package main

import (
	"bytes"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
	"unsafe"
)

const (
	fps             = 20
	minimumFrames   = 120
	particleCount   = 42
	slideFrameCount = 36
)

type cell struct {
	r     rune
	style uint8
}

type particle struct {
	x, y  int
	speed int
	glyph rune
	color uint8
}

type renderer struct {
	rows, cols int
	previous   []cell
}

type winsize struct {
	row, col       uint16
	xpixel, ypixel uint16
}

var dragon = []string{
	`   ^       ^`,
	`  / \ :-: / \`,
	` /-v (o o) v-\ <~.`,
	` \ .- \_/ -. /   '`,
	`  \  /'''\  /   //`,
	`    |'.'.'\ ___\ \`,
	`     \' ' ' ' ' '/`,
	`      ("|")._\(."`,
	`       "" ""   "`,
}

func terminalSize() (int, int) {
	request := uintptr(0x5413) // Linux TIOCGWINSZ
	if runtime.GOOS == "darwin" || runtime.GOOS == "freebsd" {
		request = 0x40087468
	}
	ws := winsize{}
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, os.Stdout.Fd(), request, uintptr(unsafe.Pointer(&ws)))
	if errno == 0 && ws.row > 0 && ws.col > 0 {
		return int(ws.row), int(ws.col)
	}
	return 24, 80
}

func blankFrame(rows, cols int) []cell {
	frame := make([]cell, rows*cols)
	for i := range frame {
		frame[i].r = ' '
	}
	return frame
}

func put(frame []cell, rows, cols, row, col int, text string, style uint8) {
	if row < 0 || row >= rows {
		return
	}
	for _, r := range text {
		if col >= 0 && col < cols {
			frame[row*cols+col] = cell{r: r, style: style}
		}
		col++
	}
}

func styleCode(style uint8) string {
	switch {
	case style == 0:
		return "\x1b[0m"
	case style >= 1 && style <= 6:
		colors := [...]int{94, 130, 166, 172, 208, 214}
		return fmt.Sprintf("\x1b[2;38;5;%dm", colors[style-1])
	case style >= 10 && style <= 15:
		colors := [...]int{166, 172, 208, 214, 208, 172}
		return fmt.Sprintf("\x1b[1;38;5;%dm", colors[style-10])
	case style == 20:
		return "\x1b[1;38;5;214m"
	case style == 21:
		return "\x1b[2;38;5;172m"
	case style == 22:
		return "\x1b[38;5;172m"
	default:
		return "\x1b[0m"
	}
}

func (r *renderer) draw(frame []cell, rows, cols int) {
	var out bytes.Buffer
	if rows != r.rows || cols != r.cols || len(r.previous) != len(frame) {
		r.rows, r.cols = rows, cols
		r.previous = blankFrame(rows, cols)
		out.WriteString("\x1b[2J")
	}

	for row := 0; row < rows; row++ {
		for col := 0; col < cols; {
			i := row*cols + col
			if frame[i] == r.previous[i] {
				col++
				continue
			}
			style := frame[i].style
			start := col
			var text []rune
			for col < cols {
				i = row*cols + col
				if frame[i] == r.previous[i] || frame[i].style != style {
					break
				}
				text = append(text, frame[i].r)
				col++
			}
			fmt.Fprintf(&out, "\x1b[%d;%dH%s%s", row+1, start+1, styleCode(style), string(text))
		}
	}
	out.WriteString("\x1b[0m")
	_, _ = os.Stdout.Write(out.Bytes())
	copy(r.previous, frame)
}

func centeredLeft(cols int, text string) int {
	left := (cols - utf8.RuneCountInString(text)) / 2
	if left < 0 {
		return 0
	}
	return left
}

func exists(path string) bool {
	if path == "" {
		return true
	}
	_, err := os.Stat(path)
	return err == nil
}

func paneSnapshot(pane string) ([][]byte, error) {
	output, err := exec.Command(
		"herdr", "pane", "read", pane,
		"--source", "visible", "--format", "ansi",
	).Output()
	if err != nil {
		return nil, err
	}
	lines := bytes.Split(output, []byte{'\n'})
	for i := range lines {
		lines[i] = bytes.TrimSuffix(lines[i], []byte{'\r'})
	}
	return lines, nil
}

func overlaySnapshotTop(lines [][]byte, revealedRows, rows int) {
	revealedRows = min(revealedRows, rows)
	var out bytes.Buffer
	for row := 0; row < revealedRows; row++ {
		fmt.Fprintf(&out, "\x1b[%d;1H\x1b[0m\x1b[2K", row+1)
		if row < len(lines) {
			out.Write(lines[row])
		}
	}
	out.WriteString("\x1b[0m")
	_, _ = os.Stdout.Write(out.Bytes())
}

func buildSplashFrame(
	rows, cols, frameNumber int,
	ready bool,
	particles []particle,
	rng *rand.Rand,
) []cell {
	frame := blankFrame(rows, cols)

	for i := range particles {
		p := &particles[i]
		row := p.y * max(rows-1, 1) / 1000
		col := p.x * max(cols-1, 1) / 1000
		put(frame, rows, cols, row, col, string(p.glyph), p.color)
		if frameNumber%2 == 0 {
			p.y += p.speed * 7
			if p.y >= 1000 {
				p.y = 0
				p.x = rng.Intn(1000)
			}
		}
	}

	artWidth := 0
	for _, line := range dragon {
		artWidth = max(artWidth, utf8.RuneCountInString(line))
	}
	top := max((rows-len(dragon)-4)/2, 0)
	left := max((cols-artWidth)/2, 0)
	reveal := min(max((frameNumber-6)/3, 0), len(dragon))
	pulse := uint8(10 + (frameNumber/5)%6)
	for i := 0; i < reveal; i++ {
		line := dragon[i]
		if i == 2 {
			switch frameNumber % 53 {
			case 0, 1:
				line = ` /-v (- -) v-\ <~.`
			case 20, 21, 22, 23, 24, 25:
				line = ` /-v (o o) v-\ <~*`
			}
		}
		put(frame, rows, cols, top+i, left, line, pulse)
	}

	title := "F A M I L I A R"
	titleRunes := []rune(title)
	titleChars := min(max((frameNumber-38)/2, 0), len(titleRunes))
	put(frame, rows, cols, top+len(dragon)+1, centeredLeft(cols, title), string(titleRunes[:titleChars]), 20)

	var status string
	switch {
	case frameNumber < 30:
		status = "opening Familiar"
	case frameNumber < 60:
		status = "reticulating splines"
	case frameNumber < 90:
		status = "arranging the room"
	case ready:
		status = "ready"
	default:
		status = "bringing things online"
	}
	dots := strings.Repeat(".", frameNumber%4) + strings.Repeat(" ", 3-frameNumber%4)
	put(frame, rows, cols, top+len(dragon)+3, centeredLeft(cols, status+"..."), status+dots, 21)

	return frame
}

func main() {
	readyFile := ""
	handoffFile := ""
	piPane := ""
	if len(os.Args) > 1 {
		readyFile = os.Args[1]
	}
	if len(os.Args) > 2 {
		handoffFile = os.Args[2]
	}
	if len(os.Args) > 3 {
		piPane = os.Args[3]
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(signals)
	defer fmt.Print("\x1b[0m\x1b[?25h")
	fmt.Print("\x1b[?25l")

	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	glyphs := []rune{'·', ':', '⋮', '✦', '+'}
	particles := make([]particle, particleCount)
	for i := range particles {
		particles[i] = particle{
			x: rng.Intn(1000), y: rng.Intn(1000), speed: rng.Intn(2) + 1,
			glyph: glyphs[rng.Intn(len(glyphs))], color: uint8(rng.Intn(6) + 1),
		}
	}

	render := renderer{}
	ticker := time.NewTicker(time.Second / fps)
	defer ticker.Stop()
	frameNumber := 0
	finalFrames := 0

	for {
		select {
		case <-signals:
			return
		case <-ticker.C:
		}

		rows, cols := terminalSize()
		ready := exists(readyFile)
		frame := buildSplashFrame(rows, cols, frameNumber, ready, particles, rng)
		render.draw(frame, rows, cols)
		if frameNumber >= minimumFrames && ready {
			finalFrames++
			if finalFrames >= 8 {
				break
			}
		}
		frameNumber++
	}

	if piPane != "" {
		for slideFrame := 1; slideFrame <= slideFrameCount; {
			select {
			case <-signals:
				return
			case <-ticker.C:
			}
			lines, err := paneSnapshot(piPane)
			if err != nil {
				continue
			}
			rows, cols := terminalSize()
			offset := (slideFrame*rows + slideFrameCount - 1) / slideFrameCount
			splash := buildSplashFrame(rows, cols, frameNumber, true, particles, rng)
			shifted := blankFrame(rows, cols)
			for sourceRow := 0; sourceRow < rows-offset; sourceRow++ {
				destinationRow := sourceRow + offset
				copy(
					shifted[destinationRow*cols:(destinationRow+1)*cols],
					splash[sourceRow*cols:(sourceRow+1)*cols],
				)
			}
			if offset < rows {
				for col := 0; col < cols; col++ {
					shifted[offset*cols+col] = cell{r: '─', style: 22}
				}
			}
			render.draw(shifted, rows, cols)
			overlaySnapshotTop(lines, offset, rows)
			frameNumber++
			slideFrame++
		}
	}

	if handoffFile == "" {
		return
	}
	if err := os.WriteFile(handoffFile, nil, 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "familiar-splash: %v", err)
		return
	}
	<-signals
}
