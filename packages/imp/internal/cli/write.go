package cli

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"
)

// imp write: writer mode on Kev's screen, and Kes's view of what he wrote.
//
// $FAMILIAR_STATE_DIR/writer.json names the open page ({"v":1,"session":…});
// every familiar-ui client polls it through the primary bridge and goes into
// writer mode to match, and the bridge autosaves the page to its path. Beside
// each page, <page>.stats.json holds per-sitting coaching numbers written by
// the UI. The shape is protocol/src/writer.ts in familiar-ui.

const writeHelp = `Usage:
  imp write [PATH] [--prompt TEXT] [--target WORDS] [--force]
                       put Kev in writer mode on PATH (every device). No PATH:
                       a fresh datestamped page in $FAMILIAR_STATE_DIR/writing/.
                       PATH must be .md or .txt; it's created if missing.
  imp write status     what's open (path, words, target, prompt), or nothing
  imp write read [PATH] [--json]
                       the page's text plus a sittings summary; marks it seen
  imp write diff [PATH]
                       what changed since you last read or diffed it (by
                       paragraph), plus sittings since then; marks it seen
  imp write stats [PATH] [--json]
                       coaching numbers per sitting: time, pace, pauses and
                       where he stalled, rewrite rate
  imp write close      take him out of writer mode (his text stays)

PATH defaults to the open page. Opening a different page while he's been
typing in the last two minutes needs --force: don't yank a page out from
under him. The UI shows the prompt and a words-to-go count; nothing else.
`

const writerPauseMs = 30_000

type writerSession struct {
	ID       string `json:"id"`
	Path     string `json:"path"`
	Prompt   string `json:"prompt,omitempty"`
	Target   int    `json:"target,omitempty"`
	OpenedAt string `json:"openedAt"`
	By       string `json:"by"`
}

type writerPause struct {
	At     string `json:"at"`
	Ms     int64  `json:"ms"`
	Words  int    `json:"words"`
	Para   int    `json:"para"`
	Before string `json:"before"`
}

type writerSitting struct {
	ID         string        `json:"id"`
	StartedAt  string        `json:"startedAt"`
	LastAt     string        `json:"lastAt"`
	ActiveMs   int64         `json:"activeMs"`
	WordsStart int           `json:"wordsStart"`
	WordsEnd   int           `json:"wordsEnd"`
	Inserted   int           `json:"inserted"`
	Deleted    int           `json:"deleted"`
	Pastes     int           `json:"pastes"`
	Pauses     []writerPause `json:"pauses"`
	Device     string        `json:"device,omitempty"`
}

var wordRe = regexp.MustCompile(`[\p{L}\p{N}][\p{L}\p{N}'’-]*`)

func countWords(s string) int { return len(wordRe.FindAllStringIndex(s, -1)) }

func kevLocation() *time.Location {
	if loc, e := time.LoadLocation("America/Chicago"); e == nil {
		return loc
	}
	return time.Local
}

func readWriterSession(file string) *writerSession {
	raw, e := os.ReadFile(file)
	if e != nil {
		return nil
	}
	var f struct {
		Session *writerSession `json:"session"`
	}
	if json.Unmarshal(raw, &f) != nil || f.Session == nil || f.Session.ID == "" || !filepath.IsAbs(f.Session.Path) {
		return nil
	}
	return f.Session
}

func writeWriterSession(file string, s *writerSession) error {
	body, _ := json.MarshalIndent(map[string]any{"v": 1, "session": s}, "", "  ")
	tmp := file + ".imp.tmp"
	if e := os.WriteFile(tmp, append(body, '\n'), 0o600); e != nil {
		return e
	}
	return os.Rename(tmp, file)
}

func writerID() string {
	b := make([]byte, 9)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func writeMain(args []string, out, errw io.Writer, getenv func(string) string) int {
	if len(args) > 0 && isHelp(args[0]) {
		io.WriteString(out, writeHelp)
		return 0
	}
	state := getenv("FAMILIAR_STATE_DIR")
	if state == "" || !filepath.IsAbs(state) {
		fmt.Fprintln(errw, "imp: FAMILIAR_STATE_DIR is not set; imp write works only inside a Familiar resident")
		return ExitUnavailable
	}
	file := filepath.Join(state, "writer.json")
	sub := ""
	if len(args) > 0 {
		switch args[0] {
		case "status", "read", "diff", "stats", "close":
			sub, args = args[0], args[1:]
		}
	}
	var path, prompt string
	target, force, asJSON, hasPrompt, hasTarget := 0, false, false, false, false
	for i := 0; i < len(args); i++ {
		a := args[i]
		val := func() (string, bool) {
			if k := strings.Index(a, "="); k > 0 && strings.HasPrefix(a, "--") {
				return a[k+1:], true
			}
			if i+1 >= len(args) {
				return "", false
			}
			i++
			return args[i], true
		}
		name := a
		if k := strings.Index(a, "="); k > 0 && strings.HasPrefix(a, "--") {
			name = a[:k]
		}
		switch {
		case name == "--prompt":
			v, ok := val()
			if !ok {
				return usageError(errw, "--prompt needs a value")
			}
			prompt, hasPrompt = strings.TrimSpace(v), true
		case name == "--target":
			v, ok := val()
			n, e := strconv.Atoi(v)
			if !ok || e != nil || n <= 0 || n > 1_000_000 {
				return usageError(errw, "--target needs a positive word count")
			}
			target, hasTarget = n, true
		case a == "--force":
			force = true
		case a == "--json":
			asJSON = true
		case strings.HasPrefix(a, "--"):
			return usageError(errw, "unknown flag %s (see imp write --help)", a)
		case path == "":
			path = a
		default:
			return usageError(errw, "one page at a time (see imp write --help)")
		}
	}
	if len([]rune(prompt)) > 600 {
		return usageError(errw, "--prompt is limited to 600 characters")
	}
	if path != "" {
		if strings.HasPrefix(path, "~/") {
			path = filepath.Join(getenv("HOME"), path[2:])
		}
		abs, e := filepath.Abs(path)
		if e != nil {
			return usageError(errw, "%v", e)
		}
		path = abs
	}
	cur := readWriterSession(file)
	pagePath := func() (string, bool) {
		if path != "" {
			return path, true
		}
		if cur != nil {
			return cur.Path, true
		}
		return "", false
	}
	switch sub {
	case "status":
		if cur == nil {
			fmt.Fprintln(out, "writer mode is off")
			return 0
		}
		text, _ := os.ReadFile(cur.Path)
		fmt.Fprintf(out, "open: %s\nwords: %d", cur.Path, countWords(string(text)))
		if cur.Target > 0 {
			fmt.Fprintf(out, " of %d", cur.Target)
		}
		fmt.Fprintf(out, "\nopened by %s at %s\n", cur.By, cur.OpenedAt)
		if cur.Prompt != "" {
			fmt.Fprintf(out, "prompt: %s\n", cur.Prompt)
		}
		return 0
	case "close":
		if cur == nil {
			fmt.Fprintln(out, "writer mode was already off")
			return 0
		}
		if e := writeWriterSession(file, nil); e != nil {
			return branchError(errw, e)
		}
		fmt.Fprintf(out, "closed writer mode (%s stays on disk)\n", cur.Path)
		return 0
	case "read", "diff", "stats":
		p, ok := pagePath()
		if !ok {
			return usageError(errw, "writer mode is off; name a page: imp write %s PATH", sub)
		}
		return writeInspect(sub, p, state, asJSON, out, errw)
	}

	// Open.
	if path == "" {
		dir := filepath.Join(state, "writing")
		if e := os.MkdirAll(dir, 0o700); e != nil {
			return branchError(errw, e)
		}
		now := time.Now().In(kevLocation())
		path = filepath.Join(dir, now.Format("2006-01-02-1504")+".md")
	}
	ext := strings.ToLower(filepath.Ext(path))
	if ext != ".md" && ext != ".txt" {
		return usageError(errw, "writer pages are .md or .txt files")
	}
	if info, e := os.Stat(path); e == nil {
		if info.IsDir() {
			return usageError(errw, "%s is a directory", path)
		}
		if info.Size() > 1<<20 {
			return usageError(errw, "%s is over 1 MiB; writer mode is for prose", path)
		}
	} else {
		if e := os.MkdirAll(filepath.Dir(path), 0o755); e != nil {
			return branchError(errw, e)
		}
		if e := os.WriteFile(path, nil, 0o600); e != nil {
			return branchError(errw, e)
		}
	}
	if cur != nil && cur.Path != path && !force {
		if info, e := os.Stat(cur.Path); e == nil && time.Since(info.ModTime()) < 2*time.Minute {
			fmt.Fprintf(errw, "imp: Kev typed in %s within the last two minutes; --force to replace it anyway\n", cur.Path)
			return ExitUsage
		}
	}
	s := &writerSession{ID: writerID(), Path: path, Prompt: prompt, Target: target, OpenedAt: time.Now().UTC().Format(time.RFC3339Nano), By: "kes"}
	if cur != nil && cur.Path == path {
		// Same page: keep its id (no reload on his screen), update what was asked.
		s.ID, s.OpenedAt, s.By = cur.ID, cur.OpenedAt, cur.By
		if !hasPrompt {
			s.Prompt = cur.Prompt
		}
		if !hasTarget {
			s.Target = cur.Target
		}
	}
	if e := writeWriterSession(file, s); e != nil {
		return branchError(errw, e)
	}
	fmt.Fprintf(out, "writer mode: %s", path)
	if s.Target > 0 {
		fmt.Fprintf(out, " (target %d words)", s.Target)
	}
	io.WriteString(out, "\n")
	return 0
}

// --- read / diff / stats -------------------------------------------------

func seenPath(state, page string) string {
	h := sha256.Sum256([]byte(page))
	return filepath.Join(state, "writer-seen", hex.EncodeToString(h[:8])+".json")
}

type seenRecord struct {
	Path string `json:"path"`
	At   string `json:"at"`
	Text string `json:"text"`
}

func readSittings(page string) []writerSitting {
	raw, e := os.ReadFile(page + ".stats.json")
	if e != nil {
		return nil
	}
	var f struct {
		Sittings []writerSitting `json:"sittings"`
	}
	json.Unmarshal(raw, &f)
	return f.Sittings
}

func writeInspect(sub, page, state string, asJSON bool, out, errw io.Writer) int {
	raw, e := os.ReadFile(page)
	if e != nil {
		return branchError(errw, e)
	}
	text := string(raw)
	sittings := readSittings(page)
	sp := seenPath(state, page)
	var seen *seenRecord
	if b, e := os.ReadFile(sp); e == nil {
		var r seenRecord
		if json.Unmarshal(b, &r) == nil {
			seen = &r
		}
	}
	mark := func() {
		os.MkdirAll(filepath.Dir(sp), 0o700)
		b, _ := json.Marshal(seenRecord{Path: page, At: time.Now().UTC().Format(time.RFC3339), Text: text})
		os.WriteFile(sp, b, 0o600)
	}
	switch sub {
	case "stats":
		if asJSON {
			b, _ := json.MarshalIndent(map[string]any{"path": page, "words": countWords(text), "sittings": sittings}, "", "  ")
			out.Write(append(b, '\n'))
			return 0
		}
		fmt.Fprintf(out, "%s · %d words\n", page, countWords(text))
		writeSittingsSummary(out, sittings, "", true)
		return 0
	case "read":
		if asJSON {
			b, _ := json.MarshalIndent(map[string]any{"path": page, "words": countWords(text), "text": text, "sittings": sittings}, "", "  ")
			out.Write(append(b, '\n'))
			mark()
			return 0
		}
		fmt.Fprintf(out, "%s · %d words\n\n", page, countWords(text))
		io.WriteString(out, text)
		if !strings.HasSuffix(text, "\n") {
			io.WriteString(out, "\n")
		}
		io.WriteString(out, "\n---\n")
		writeSittingsSummary(out, sittings, "", false)
		mark()
		return 0
	}
	// diff
	since := ""
	old := ""
	if seen != nil {
		since, old = seen.At, seen.Text
	}
	ow, nw := countWords(old), countWords(text)
	if seen == nil {
		fmt.Fprintf(out, "%s · %d words · first look (nothing seen before), so all of it:\n\n", page, nw)
	} else {
		at, _ := time.Parse(time.RFC3339, since)
		fmt.Fprintf(out, "%s · %d words (%+d since you looked, %s)\n\n", page, nw, nw-ow, at.In(kevLocation()).Format("Mon 3:04 PM"))
	}
	if old == text {
		io.WriteString(out, "no change\n")
	} else {
		writeParaDiff(out, splitParas(old), splitParas(text))
	}
	io.WriteString(out, "\n---\n")
	writeSittingsSummary(out, sittings, since, false)
	mark()
	return 0
}

func splitParas(s string) []string {
	var out []string
	for _, p := range regexp.MustCompile(`\n\s*\n`).Split(strings.ReplaceAll(s, "\r\n", "\n"), -1) {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// writeParaDiff prints a paragraph-level diff: "  " kept (only as context
// beside a change), "- " gone, "+ " new. LCS, bounded; past the bound the
// whole thing is shown as rewritten.
func writeParaDiff(w io.Writer, a, b []string) {
	if len(a)*len(b) > 4_000_000 {
		for _, p := range b {
			fmt.Fprintf(w, "+ %s\n\n", p)
		}
		return
	}
	n, m := len(a), len(b)
	dp := make([][]int, n+1)
	for i := range dp {
		dp[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if a[i] == b[j] {
				dp[i][j] = dp[i+1][j+1] + 1
			} else if dp[i+1][j] >= dp[i][j+1] {
				dp[i][j] = dp[i+1][j]
			} else {
				dp[i][j] = dp[i][j+1]
			}
		}
	}
	type op struct {
		k byte
		s string
	}
	var ops []op
	i, j := 0, 0
	for i < n || j < m {
		switch {
		case i < n && j < m && a[i] == b[j]:
			ops = append(ops, op{' ', a[i]})
			i++
			j++
		case j < m && (i == n || dp[i][j+1] >= dp[i+1][j]):
			ops = append(ops, op{'+', b[j]})
			j++
		default:
			ops = append(ops, op{'-', a[i]})
			i++
		}
	}
	skipped := 0
	for k, o := range ops {
		if o.k == ' ' {
			near := (k > 0 && ops[k-1].k != ' ') || (k+1 < len(ops) && ops[k+1].k != ' ')
			if !near {
				skipped++
				continue
			}
			if skipped > 0 {
				fmt.Fprintf(w, "  [… %d unchanged]\n\n", skipped)
				skipped = 0
			}
			fmt.Fprintf(w, "  %s\n\n", clipRunes(o.s, 160))
			continue
		}
		if skipped > 0 {
			fmt.Fprintf(w, "  [… %d unchanged]\n\n", skipped)
			skipped = 0
		}
		fmt.Fprintf(w, "%c %s\n\n", o.k, o.s)
	}
	if skipped > 0 {
		fmt.Fprintf(w, "  [… %d unchanged]\n", skipped)
	}
}

func clipRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

func fmtDur(ms int64) string {
	d := time.Duration(ms) * time.Millisecond
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm", int(d.Minutes()+0.5))
	}
	return fmt.Sprintf("%dh%02dm", int(d.Hours()), int(d.Minutes())%60)
}

// writeSittingsSummary: one line per sitting (since `since`, if given), then
// the longest stalls with the words he'd just written. Pace is net words per
// typing minute; rewrite is characters removed per character typed.
func writeSittingsSummary(w io.Writer, all []writerSitting, since string, everyStall bool) {
	var ss []writerSitting
	for _, s := range all {
		if since == "" || s.LastAt > since {
			ss = append(ss, s)
		}
	}
	if len(ss) == 0 {
		if since != "" {
			io.WriteString(w, "no writing sittings since then\n")
		} else {
			io.WriteString(w, "no sittings recorded\n")
		}
		return
	}
	loc := kevLocation()
	var stalls []writerPause
	for _, s := range ss {
		start, _ := time.Parse(time.RFC3339Nano, s.StartedAt)
		last, _ := time.Parse(time.RFC3339Nano, s.LastAt)
		net := s.WordsEnd - s.WordsStart
		pace := "—"
		if s.ActiveMs >= 30_000 {
			pace = fmt.Sprintf("%.0f wpm", float64(net)/(float64(s.ActiveMs)/60_000))
		}
		rewrite := "—"
		if s.Inserted > 0 {
			rewrite = fmt.Sprintf("%.0f%%", 100*float64(s.Deleted)/float64(s.Inserted))
		}
		var paused int64
		for _, p := range s.Pauses {
			paused += p.Ms
		}
		fmt.Fprintf(w, "sitting %s, %s on page (%s typing, %d pauses ≥30s totalling %s): %+d words, %s, rewrite %s",
			start.In(loc).Format("Mon Jan 2 3:04 PM"), fmtDur(last.Sub(start).Milliseconds()), fmtDur(s.ActiveMs), len(s.Pauses), fmtDur(paused), net, pace, rewrite)
		if s.Pastes > 0 {
			fmt.Fprintf(w, ", %d pastes", s.Pastes)
		}
		if s.Device != "" {
			fmt.Fprintf(w, " [%s]", s.Device)
		}
		io.WriteString(w, "\n")
		stalls = append(stalls, s.Pauses...)
	}
	sort.SliceStable(stalls, func(i, j int) bool { return stalls[i].Ms > stalls[j].Ms })
	limit := 3
	if everyStall {
		limit = 10
	}
	if len(stalls) > limit {
		stalls = stalls[:limit]
	}
	if len(stalls) > 0 {
		io.WriteString(w, "longest stalls:\n")
		for _, p := range stalls {
			fmt.Fprintf(w, "  %s at %d words, paragraph %d, after “…%s”\n", fmtDur(p.Ms), p.Words, p.Para+1, p.Before)
		}
	}
}
