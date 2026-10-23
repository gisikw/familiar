package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// imp play: drop an audio clip into Kes's speech stream, so it plays inline
// (after whatever Kes has already said) wherever Kev is listening. imp reads
// and, when needed, cuts the audio (ffmpeg; yt-dlp for URLs) and POSTs the
// bytes to the gateway's /play; the gateway never opens a path itself.

const playHelp = `Usage:
  imp play <file|url> [--start T] [--end T] [--title T] [--else-open] [--cut-only]

Plays the clip in my voice stream, queued after what I've already said in this
turn, on every device Kev has the speaker on. Say the lead-in first ("here's
Hinton on radiologists:"), then call this; keep talking after it and my next
words play after the clip.

  file        mp3, m4a, aac, wav, ogg, opus, flac, webm, mp4, mkv, ... (anything ffmpeg reads)
  url         anything yt-dlp handles (YouTube, podcasts, direct links)
  --start/--end  T as 90, 1:30, 1:02:03, or 1:30.5; cuts with ffmpeg
  --title     label for the segment (default: file name)
  --else-open if nobody has the speaker on, push the clip to his Open list instead
  --cut-only  just cut/convert and print the saved clip path (for prepping briefs)

Cuts and downloads are saved under $FAMILIAR_STATE_DIR/clips/ (kept, reusable).
Nobody listening: nothing is queued (a later listener would never hear it);
exit 3 and say so, unless --else-open. Max 32 MB.
`

const maxClipBytes = 32 << 20

var clipTimeRe = regexp.MustCompile(`^(\d+:){0,2}\d+(\.\d+)?$`)

var directClipTypes = map[string]string{
	".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav",
	".ogg": "audio/ogg", ".oga": "audio/ogg", ".flac": "audio/flac",
}

func playMain(args []string, out, errw io.Writer, getenv func(string) string) int {
	if len(args) == 0 || isHelp(args[0]) {
		io.WriteString(out, playHelp)
		return 0
	}
	var src, start, end, title string
	elseOpen, cutOnly := false, false
	for i := 0; i < len(args); i++ {
		a := args[i]
		val := func() (string, bool) {
			if i+1 >= len(args) {
				return "", false
			}
			i++
			return args[i], true
		}
		switch a {
		case "--start", "--end", "--title":
			v, ok := val()
			if !ok {
				return usageError(errw, a+" needs a value")
			}
			switch a {
			case "--start":
				start = v
			case "--end":
				end = v
			default:
				title = v
			}
		case "--else-open":
			elseOpen = true
		case "--cut-only":
			cutOnly = true
		default:
			if strings.HasPrefix(a, "--") || src != "" {
				return usageError(errw, "unexpected argument "+a+" (see imp play --help)")
			}
			src = a
		}
	}
	if src == "" {
		return usageError(errw, "imp play needs a file or url")
	}
	for _, t := range []string{start, end} {
		if t != "" && !clipTimeRe.MatchString(t) {
			return usageError(errw, "times look like 90, 1:30 or 1:02:03.5, not "+t)
		}
	}
	state := getenv("FAMILIAR_STATE_DIR")
	if state == "" || !filepath.IsAbs(state) {
		fmt.Fprintln(errw, "imp: FAMILIAR_STATE_DIR is not set; imp play works only inside a Familiar resident")
		return ExitUnavailable
	}
	clips := filepath.Join(state, "clips")
	if err := os.MkdirAll(clips, 0o755); err != nil {
		fmt.Fprintf(errw, "imp: %v\n", err)
		return ExitUnavailable
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	isURL := strings.HasPrefix(src, "http://") || strings.HasPrefix(src, "https://")
	if title == "" {
		title = strings.TrimSuffix(filepath.Base(src), filepath.Ext(src))
		if isURL {
			title = "clip"
		}
	}
	stamp := time.Now().Format("20060102-150405")
	path := src
	if isURL {
		ytdlp := "yt-dlp"
		if d := getenv("FAMILIAR_YTDLP_BIN"); d != "" {
			ytdlp = filepath.Join(d, "yt-dlp")
		}
		tmpl := filepath.Join(clips, stamp+"-src.%(ext)s")
		cmd := exec.CommandContext(ctx, ytdlp, "-q", "--no-playlist", "-f", "bestaudio/best", "-o", tmpl, "--print", "after_move:filepath", src)
		b, err := cmd.Output()
		if err != nil {
			fmt.Fprintf(errw, "imp: yt-dlp failed: %v\n", err)
			return ExitUnavailable
		}
		path = strings.TrimSpace(string(b))
		if i := strings.LastIndex(path, "\n"); i >= 0 {
			path = path[i+1:]
		}
	} else if abs, err := filepath.Abs(src); err == nil {
		path = abs
	}
	if fi, err := os.Stat(path); err != nil || fi.IsDir() {
		return usageError(errw, "no such audio file: "+src)
	}
	ctype, direct := directClipTypes[strings.ToLower(filepath.Ext(path))]
	if start != "" || end != "" || !direct || cutOnly || isURL {
		dst := filepath.Join(clips, stamp+"-"+clipSlug(title)+".mp3")
		ff := []string{"-hide_banner", "-loglevel", "error", "-y"}
		if start != "" {
			ff = append(ff, "-ss", start)
		}
		if end != "" {
			ff = append(ff, "-to", end)
		}
		ff = append(ff, "-i", path, "-vn", "-c:a", "libmp3lame", "-q:a", "4", dst)
		if b, err := exec.CommandContext(ctx, "ffmpeg", ff...).CombinedOutput(); err != nil {
			fmt.Fprintf(errw, "imp: ffmpeg failed: %v %s\n", err, strings.TrimSpace(string(b)))
			return ExitUnavailable
		}
		if isURL {
			os.Remove(path)
		}
		path, ctype = dst, "audio/mpeg"
	}
	if cutOnly {
		fmt.Fprintln(out, path)
		return 0
	}
	data, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(errw, "imp: %v\n", err)
		return ExitUnavailable
	}
	if len(data) > maxClipBytes {
		return usageError(errw, fmt.Sprintf("clip is %d MB; cut it shorter (--start/--end), max 32 MB", len(data)>>20))
	}
	port := getenv("FAMILIAR_SUBSCRIBER_PORT")
	if port == "" {
		port = "1692"
	}
	req, _ := http.NewRequestWithContext(ctx, "POST", "http://127.0.0.1:"+port+"/play", bytes.NewReader(data))
	req.Header.Set("Content-Type", ctype)
	req.Header.Set("X-Clip-Title", url.PathEscape(title))
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		fmt.Fprintf(errw, "imp: gateway unreachable: %v\n", err)
		return ExitUnavailable
	}
	defer resp.Body.Close()
	var r struct {
		Played    bool   `json:"played"`
		MessageID int64  `json:"message_id"`
		Index     int64  `json:"index"`
		Error     string `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&r)
	if resp.StatusCode != 200 {
		fmt.Fprintf(errw, "imp: gateway said %d %s\n", resp.StatusCode, r.Error)
		return ExitRemote
	}
	if r.Played {
		fmt.Fprintf(out, "queued %q after my current speech (%s)\n", title, path)
		return 0
	}
	if elseOpen {
		fmt.Fprintln(out, "nobody has the speaker on; pushing it to his Open list instead")
		return openMain([]string{path, "--title", title}, out, errw, getenv)
	}
	fmt.Fprintf(errw, "imp: not played: nobody has the speaker on. The clip is at %s (imp open it, or link it).\n", path)
	return ExitUnavailable
}

var clipSlugRe = regexp.MustCompile(`[^a-z0-9]+`)

func clipSlug(s string) string {
	s = strings.Trim(clipSlugRe.ReplaceAllString(strings.ToLower(s), "-"), "-")
	if len(s) > 40 {
		s = strings.Trim(s[:40], "-")
	}
	if s == "" {
		s = "clip"
	}
	return s
}
