package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// imp host: ask a host to run a script as root, the way Kev approves it.
//
// The backend is the host page (fortress-approve) and its signed client
// (fortress-keeper, with Kes's key): a request waits on
// https://<host>.fort.<domain>/runs/<id> for Kev's passkey or his Reject. This
// wrapper submits it, puts a doc for it in Kev's Open list, and starts a
// watcher outside this Pi's cgroup (a transient systemd unit) that notifies
// the instance that asked once the run is done, failed, rejected or expired,
// with the result already fetched. Nothing here is fortress-specific beyond
// the client's CLI; any host that serves the page works.

const hostHelp = `Usage:
  imp host run <host> <script> "reason" [--async]
                                          ask <host> to run <script> as root, once
  imp host runs <host>                    my run requests there and their state
  imp host result <host> <id>             a run's state and output, now (saved to disk)
  imp host watch <host> <id> [--url U]    (re)start the watcher for a run

run prints the run's page first (paste it to Kev; it's also in his Open
list), then BLOCKS: up to 5 minutes for his passkey, then through the run
(the host caps a run at 5 minutes), and prints the result: exit code,
trimmed stdout/stderr, and the folder with the full output. Give the shell
call a timeout of at least 13 minutes. Rejected or expired returns at once.
Still waiting after 5 minutes: it returns "still pending" with the URL,
and the watcher takes over. --async returns right after submitting (queue
several for overnight); the watcher handles everything.

The watcher hard-notifies this instance when a run is done, failed,
rejected or expired (and once if the host refuses an approval), carrying
the same report. A result is delivered once: by the blocking call or by
the watcher, never both. Don't poll or call result.

Kev reads the exact script on the page before he taps; keep scripts
read-only unless he asked for a change. The reason is one line for him.

Client: $FAMILIAR_HOST_CLIENT, else $FAMILIAR_STATE_DIR/bin/fortress-keeper.
Output: $FAMILIAR_STATE_DIR/host-runs/<host>-<id>/.
`

var hostNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
var hostRunIDRe = regexp.MustCompile(`^[0-9a-f]{12}$`)

// hostPoll and hostSleep are variables so tests can run the watcher fast.
var hostPoll = 15 * time.Second
var hostSleep = time.Sleep
var hostNow = time.Now

func hostMain(args []string, out, errw io.Writer, getenv func(string) string) int {
	if len(args) == 0 || isHelp(args[0]) {
		io.WriteString(out, hostHelp)
		return 0
	}
	state := getenv("FAMILIAR_STATE_DIR")
	if state == "" || !filepath.IsAbs(state) {
		fmt.Fprintln(errw, "imp: FAMILIAR_STATE_DIR is not set; imp host works only inside a Familiar resident")
		return ExitUnavailable
	}
	h := hostCtx{state: state, getenv: getenv, out: out, errw: errw}
	cmd, rest := args[0], args[1:]
	flags := map[string]string{}
	var pos []string
	for i := 0; i < len(rest); i++ {
		a := rest[i]
		if a == "--async" {
			flags["async"] = "1"
			continue
		}
		if strings.HasPrefix(a, "--") && (a == "--url" || a == "--target") {
			if i+1 >= len(rest) {
				return usageError(errw, "%s needs a value", a)
			}
			flags[a[2:]] = rest[i+1]
			i++
			continue
		}
		if strings.HasPrefix(a, "--") {
			return usageError(errw, "unknown option %s (see imp host --help)", a)
		}
		pos = append(pos, a)
	}
	if len(pos) > 0 && !hostNameRe.MatchString(pos[0]) {
		return usageError(errw, "%q isn't a host name", pos[0])
	}
	if len(pos) > 1 && cmd != "run" && !hostRunIDRe.MatchString(pos[1]) {
		return usageError(errw, "%q isn't a run id (12 hex characters)", pos[1])
	}
	switch cmd {
	case "run":
		if len(pos) != 3 || strings.TrimSpace(pos[2]) == "" {
			return usageError(errw, `usage: imp host run <host> <script> "reason" (the reason is for Kev; it's required)`)
		}
		return h.run(pos[0], pos[1], pos[2], flags["async"] != "")
	case "runs", "list", "ls":
		if len(pos) != 1 {
			return usageError(errw, "usage: imp host runs <host>")
		}
		return h.list(pos[0])
	case "result":
		if len(pos) != 2 {
			return usageError(errw, "usage: imp host result <host> <id>")
		}
		v, e := h.fetch(pos[0], pos[1])
		if e != nil {
			return branchError(errw, e)
		}
		dir, _ := h.save(pos[0], v, "")
		io.WriteString(out, h.report(pos[0], v, "", dir))
		return 0
	case "watch":
		if len(pos) != 2 {
			return usageError(errw, "usage: imp host watch <host> <id> [--url U]")
		}
		return h.startWatch(pos[0], pos[1], flags["url"], hostTarget(getenv, flags["target"]))
	case "_watch":
		if len(pos) != 2 {
			return usageError(errw, "usage: imp host _watch <host> <id> [--url U] [--target T]")
		}
		return h.watch(pos[0], pos[1], flags["url"], flags["target"])
	}
	return usageError(errw, "unknown host command %q (see imp host --help)", cmd)
}

type hostCtx struct {
	state  string
	getenv func(string) string
	out    io.Writer
	errw   io.Writer
}

// hostTarget: an explicit --target, else the instance that is asking.
func hostTarget(getenv func(string) string, explicit string) string {
	if explicit != "" {
		return explicit
	}
	if id := getenv("FAMILIAR_INSTANCE_ID"); id != "" {
		return "instance:" + id
	}
	return ""
}

func (h hostCtx) client() string {
	if c := h.getenv("FAMILIAR_HOST_CLIENT"); c != "" {
		return c
	}
	return filepath.Join(h.state, "bin", "fortress-keeper")
}

// call runs the client and returns its JSON stdout. The client prints the
// server's error on stderr (log.Fatal) and exits non-zero.
func (h hostCtx) call(args ...string) ([]byte, error) {
	c := exec.Command(h.client(), args...)
	var stdout, stderr bytes.Buffer
	c.Stdout, c.Stderr = &stdout, &stderr
	if e := c.Run(); e != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = e.Error()
		}
		return nil, fmt.Errorf("%s %s: %s", filepath.Base(h.client()), args[0], msg)
	}
	return stdout.Bytes(), nil
}

// hostRunView is the page's view of one run plus, once it ran, its result.
type hostRunView struct {
	Run struct {
		ID      string    `json:"id"`
		Reason  string    `json:"reason"`
		Script  string    `json:"script"`
		Code    string    `json:"code"`
		Created time.Time `json:"created"`
		State   string    `json:"state"`
		Exit    *int      `json:"exit"`
		Note    string    `json:"note"`
	} `json:"run"`
	Result *struct {
		Status   string `json:"status"`
		Exit     int    `json:"exit"`
		Stdout   string `json:"stdout"`
		Stderr   string `json:"stderr"`
		Error    string `json:"error"`
		Started  string `json:"started"`
		Finished string `json:"finished"`
	} `json:"result"`
}

func hostSettled(state string) bool {
	switch state {
	case "done", "failed", "rejected", "expired":
		return true
	}
	return false
}

func (h hostCtx) fetch(host, id string) (hostRunView, error) {
	var v hostRunView
	raw, e := h.call("run-result", host, id)
	if e != nil {
		return v, e
	}
	if e := json.Unmarshal(raw, &v); e != nil || v.Run.ID == "" {
		return v, fmt.Errorf("unreadable answer from %s: %.200s", host, raw)
	}
	return v, nil
}

func (h hostCtx) dir(host, id string) string {
	return filepath.Join(h.state, "host-runs", host+"-"+id)
}

func (h hostCtx) docPath(host, id string) string {
	return filepath.Join(h.dir(host, id), "index.md")
}

func (h hostCtx) run(host, script, reason string, async bool) int {
	if _, e := os.Stat(script); e != nil {
		return usageError(h.errw, "can't read %s: %v", script, e)
	}
	raw, e := h.call("run", host, script, reason)
	if e != nil {
		return branchError(h.errw, e)
	}
	var sub struct{ ID, Code, Page, URL string }
	if e := json.Unmarshal(raw, &sub); e != nil || !hostRunIDRe.MatchString(sub.ID) {
		return branchError(h.errw, fmt.Errorf("unreadable answer from %s: %.200s", host, raw))
	}
	url := sub.URL
	if url == "" && sub.Page != "" { // pages before /runs/ID answered with the main page only
		url = strings.TrimRight(sub.Page, "/") + "/runs/" + sub.ID
	}
	body, _ := os.ReadFile(script)
	var v hostRunView
	v.Run.ID, v.Run.Reason, v.Run.Script, v.Run.Code, v.Run.State = sub.ID, reason, string(body), sub.Code, "pending"
	v.Run.Created = hostNow()
	if _, e := h.save(host, v, url); e != nil {
		fmt.Fprintf(h.errw, "imp: writing the run doc: %v\n", e)
	}
	fmt.Fprintln(h.out, url)
	fmt.Fprintf(h.out, "%s run %s · check code %s\n", host, sub.ID, sub.Code)
	var discard bytes.Buffer
	title := fmt.Sprintf("%s run: %s (%s)", host, clip(reason, 120), sub.Code)
	if code := openMain([]string{h.docPath(host, sub.ID), "--title", title}, &discard, &discard, h.getenv); code != 0 {
		fmt.Fprintf(h.errw, "imp: not pushed to Open: %s", discard.String())
	} else {
		fmt.Fprintln(h.out, "in Kev's Open list")
	}
	if !async {
		h.touchLease(host, sub.ID) // before the watcher starts, so it never races us to the result
	}
	if code := h.startWatch(host, sub.ID, url, hostTarget(h.getenv, "")); code != 0 {
		fmt.Fprintf(h.errw, "imp: the run is submitted, but no watcher: check it with imp host result %s %s\n", host, sub.ID)
		if async {
			return code
		}
	}
	if async {
		return 0
	}
	return h.block(host, sub.ID, url)
}

// Blocking: wait hostApprovalWait for a passkey (or a Reject), then through
// the run itself (the host kills a run at 5 minutes). Whoever claims the
// delivered marker first hands the result over, so Kes gets it once: here,
// or from the watcher if this call gives up or dies (its lease goes stale).
var hostApprovalWait = 5 * time.Minute
var hostRunWait = 7 * time.Minute
var hostBlockPoll = 3 * time.Second

const hostLeaseStale = 30 * time.Second

func (h hostCtx) block(host, id, url string) int {
	lease := filepath.Join(h.dir(host, id), "blocking")
	defer os.Remove(lease)
	fmt.Fprintf(h.out, "waiting up to %s for Kev's passkey…\n", hostApprovalWait)
	start := hostNow()
	var approvedAt time.Time
	last := ""
	for {
		h.touchLease(host, id)
		v, e := h.fetch(host, id)
		if e == nil {
			if v.Run.State != last {
				last = v.Run.State
				h.save(host, v, url)
			}
			if hostSettled(v.Run.State) {
				dir := h.dir(host, id)
				h.closeOpen(host, id)
				if !h.claim(host, id) {
					fmt.Fprintf(h.out, "%s (the watcher already delivered it)\n", h.summary(host, v))
					return 0
				}
				io.WriteString(h.out, "\n"+h.report(host, v, url, dir))
				return 0
			}
			if approvedAt.IsZero() && (v.Run.State == "approved" || v.Run.State == "running") {
				approvedAt = hostNow()
				fmt.Fprintln(h.out, "approved; waiting for the run to finish…")
			}
		}
		now := hostNow()
		if (approvedAt.IsZero() && now.Sub(start) >= hostApprovalWait) || (!approvedAt.IsZero() && now.Sub(approvedAt) >= hostRunWait) {
			st := last
			if st == "" {
				st = "unknown (the host didn't answer)"
			}
			fmt.Fprintf(h.out, "still %s after %s: %s\nThe watcher has it; you'll be notified when it settles.\n", st, now.Sub(start).Round(time.Second), url)
			return 0
		}
		hostSleep(hostBlockPoll)
	}
}

func (h hostCtx) touchLease(host, id string) {
	p := filepath.Join(h.dir(host, id), "blocking")
	now := hostNow()
	if os.Chtimes(p, now, now) != nil {
		_ = os.WriteFile(p, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o644)
		_ = os.Chtimes(p, now, now)
	}
}

func (h hostCtx) leaseFresh(host, id string) bool {
	i, e := os.Stat(filepath.Join(h.dir(host, id), "blocking"))
	return e == nil && hostNow().Sub(i.ModTime()) < hostLeaseStale
}

// claim: the first caller to create the marker delivers the result.
func (h hostCtx) claim(host, id string) bool {
	f, e := os.OpenFile(filepath.Join(h.dir(host, id), "delivered"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if e != nil {
		return false
	}
	fmt.Fprintf(f, "%d %s\n", os.Getpid(), hostNow().Format(time.RFC3339))
	f.Close()
	return true
}

func (h hostCtx) list(host string) int {
	raw, e := h.call("runs", host)
	if e != nil {
		return branchError(h.errw, e)
	}
	var runs []struct {
		ID, Reason, Code, State string
		Created                 time.Time
		Exit                    *int
	}
	if e := json.Unmarshal(raw, &runs); e != nil {
		return branchError(h.errw, fmt.Errorf("unreadable answer from %s: %.200s", host, raw))
	}
	if len(runs) == 0 {
		fmt.Fprintln(h.out, "no run requests")
	}
	for _, r := range runs {
		st := r.State
		if r.Exit != nil {
			st += fmt.Sprintf(" (exit %d)", *r.Exit)
		}
		fmt.Fprintf(h.out, "%s  %-18s %s  %s  %s\n", r.ID, st, r.Code, r.Created.Local().Format("Jan 2 15:04"), clip(r.Reason, 80))
	}
	return 0
}

// startWatch runs the watcher as a transient system unit, so it outlives this
// Pi (a fork's unit stops when it merges) and familiar restarts. A unit that
// already exists means a watcher is already on it.
func (h hostCtx) startWatch(host, id, url, target string) int {
	self, e := os.Executable()
	if e != nil {
		return branchError(h.errw, e)
	}
	unit := "familiar-host-watch-" + host + "-" + id
	argv := []string{"systemd-run", "--quiet", "--collect", "--unit", unit,
		"--uid", strconv.Itoa(os.Getuid()), "--gid", strconv.Itoa(os.Getgid()),
		"-p", "RuntimeMaxSec=27h"}
	client := h.client()
	if r, e := filepath.EvalSymlinks(client); e == nil {
		client = r // the symlink may move on a reinstall; this run keeps its binary
	}
	env := map[string]string{"FAMILIAR_STATE_DIR": h.state, "FAMILIAR_HOST_CLIENT": client}
	for _, k := range []string{"HOME", "FAMILIAR_SERVICES_SOCKET", "FAMILIAR_UI_DOC_ROOTS", "TZ",
		"FORTRESS_KEEPER", "FORTRESS_PRINCIPAL", "FORTRESS_KEY", "FORTRESS_DOMAIN", "FORTRESS_HOST_URL"} {
		if v := h.getenv(k); v != "" {
			env[k] = v
		}
	}
	for k, v := range env {
		argv = append(argv, "--setenv", k+"="+v)
	}
	argv = append(argv, "--", self, "host", "_watch", host, id)
	if url != "" {
		argv = append(argv, "--url", url)
	}
	if target != "" {
		argv = append(argv, "--target", target)
	}
	var c *exec.Cmd
	if x := h.getenv("FAMILIAR_SYSTEMD_RUN"); x != "" {
		c = exec.Command(x, argv[1:]...)
	} else {
		c = exec.Command("sudo", argv...)
	}
	raw, e := c.CombinedOutput()
	if e != nil {
		if bytes.Contains(raw, []byte("already exists")) || bytes.Contains(raw, []byte("already loaded")) {
			fmt.Fprintf(h.out, "already watching (%s)\n", unit)
			return 0
		}
		fmt.Fprintf(h.errw, "imp: starting the watcher: %v: %s\n", e, bytes.TrimSpace(raw))
		return ExitRemote
	}
	fmt.Fprintf(h.out, "watching: you'll be notified when it's done, failed, rejected or expired (%s)\n", unit)
	return 0
}

// watch polls the run until it settles, then saves the output, closes the
// Open row (it lands in Recently closed, still readable) and notifies.
func (h hostCtx) watch(host, id, url, target string) int {
	start := hostNow()
	deadline := start.Add(25 * time.Hour)
	last, refusedSaid, failing := "", false, 0
	for {
		v, e := h.fetch(host, id)
		switch {
		case e != nil:
			failing++
			fmt.Fprintf(h.errw, "poll %s %s: %v\n", host, id, e)
			if strings.Contains(e.Error(), "no such run") {
				h.notify(target, host, id, fmt.Sprintf("%s run %s is gone from the host (pruned, or the wrong host); stopped watching", host, id), "")
				return 1
			}
		default:
			failing = 0
			if !v.Run.Created.IsZero() {
				deadline = v.Run.Created.Add(24*time.Hour + 30*time.Minute)
			}
			if v.Run.State != last {
				last = v.Run.State
				dir, _ := h.save(host, v, url)
				blocked := h.leaseFresh(host, id)
				if blocked {
					last = "" // a blocking imp host run is waiting on it; look again next poll
				}
				switch {
				case hostSettled(v.Run.State) && !blocked:
					h.closeOpen(host, id)
					if h.claim(host, id) { // else the blocking call already handed it over
						h.notify(target, host, id, h.summary(host, v), h.report(host, v, url, dir))
					}
					return 0
				case v.Run.State == "refused" && !refusedSaid && !blocked:
					refusedSaid = true
					h.notify(target, host, id, h.summary(host, v), h.report(host, v, url, dir))
				}
			}
		}
		if hostNow().After(deadline) {
			why := "the host never said it settled"
			if failing > 0 {
				why = fmt.Sprintf("the last %d polls failed", failing)
			}
			h.notify(target, host, id, fmt.Sprintf("%s run %s: stopped watching after 24h (%s); imp host result %s %s", host, id, why, host, id), "")
			return 1
		}
		hostSleep(hostPoll)
	}
}

func (h hostCtx) summary(host string, v hostRunView) string {
	s := fmt.Sprintf("%s run %s %s", host, v.Run.ID, v.Run.State)
	if v.Run.Exit != nil {
		s += fmt.Sprintf(", exit %d", *v.Run.Exit)
	}
	if v.Run.Reason != "" {
		s += ": " + clip(v.Run.Reason, 120)
	}
	return s
}

// report is what the notification carries (and what result prints): enough
// that nobody has to go fetch anything.
func (h hostCtx) report(host string, v hostRunView, url, dir string) string {
	var b strings.Builder
	b.WriteString(h.summary(host, v) + "\n")
	if v.Run.Note != "" {
		fmt.Fprintf(&b, "note: %s\n", v.Run.Note)
	}
	if url != "" {
		fmt.Fprintf(&b, "page: %s\n", url)
	}
	if r := v.Result; r != nil {
		if r.Error != "" {
			fmt.Fprintf(&b, "error: %s\n", r.Error)
		}
		if dir != "" {
			fmt.Fprintf(&b, "full output: %s/ (stdout.txt, stderr.txt, result.json)\n", dir)
		}
		b.WriteString("\nstdout" + trimOutput(r.Stdout, 60, 6000))
		b.WriteString("\nstderr" + trimOutput(r.Stderr, 30, 3000))
	} else if hostSettled(v.Run.State) {
		b.WriteString("It never ran; nothing to fetch.\n")
	}
	return b.String()
}

// trimOutput keeps the head and tail of long output, within maxLines and
// maxBytes, and says what it left out.
func trimOutput(s string, maxLines, maxBytes int) string {
	s = strings.TrimRight(s, "\n")
	if s == "" {
		return ": (empty)\n"
	}
	lines := strings.Split(s, "\n")
	n := len(lines)
	if n > maxLines {
		head, tail := maxLines*2/3, maxLines-maxLines*2/3
		kept := append(append([]string{}, lines[:head]...), fmt.Sprintf("… %d lines left out …", n-head-tail))
		lines = append(kept, lines[n-tail:]...)
	}
	out := strings.Join(lines, "\n")
	if len(out) > maxBytes {
		out = out[:maxBytes] + "\n… (cut at " + strconv.Itoa(maxBytes) + " bytes)"
	}
	label := fmt.Sprintf(" (%d lines):\n", n)
	if n > maxLines {
		label = fmt.Sprintf(" (%d lines, trimmed):\n", n)
	}
	return label + out + "\n"
}

// save writes the run's folder: index.md (the doc in Kev's Open list) and,
// once it ran, the full output.
func (h hostCtx) save(host string, v hostRunView, url string) (string, error) {
	dir := h.dir(host, v.Run.ID)
	if e := os.MkdirAll(dir, 0o755); e != nil {
		return "", e
	}
	if url == "" {
		if b, e := os.ReadFile(filepath.Join(dir, "url")); e == nil {
			url = strings.TrimSpace(string(b))
		}
	} else {
		_ = os.WriteFile(filepath.Join(dir, "url"), []byte(url+"\n"), 0o644)
	}
	if r := v.Result; r != nil {
		_ = os.WriteFile(filepath.Join(dir, "stdout.txt"), []byte(r.Stdout), 0o600)
		_ = os.WriteFile(filepath.Join(dir, "stderr.txt"), []byte(r.Stderr), 0o600)
		if b, e := json.MarshalIndent(v, "", "  "); e == nil {
			_ = os.WriteFile(filepath.Join(dir, "result.json"), append(b, '\n'), 0o600)
		}
	}
	return dir, os.WriteFile(h.docPath(host, v.Run.ID), []byte(h.doc(host, v, url)), 0o644)
}

var hostStateWords = map[string]string{
	"pending": "waiting for your passkey (or Reject)", "approved": "approved, about to run", "running": "running",
	"done": "done", "failed": "failed", "refused": "refused by the host (Try again on the page)",
	"rejected": "rejected", "expired": "expired (nobody approved it in 24h)",
}

func (h hostCtx) doc(host string, v hostRunView, url string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# %s run %s\n\n", host, v.Run.ID)
	if v.Run.Reason != "" {
		fmt.Fprintf(&b, "%s\n\n", v.Run.Reason)
	}
	st := hostStateWords[v.Run.State]
	if st == "" {
		st = v.Run.State
	}
	if v.Run.Exit != nil {
		st += fmt.Sprintf(", exit %d", *v.Run.Exit)
	}
	fmt.Fprintf(&b, "**State:** %s  \n**Check code:** `%s`  \n**Updated:** %s\n\n", st, v.Run.Code, hostNow().Local().Format("Mon Jan 2 15:04"))
	if v.Run.Note != "" {
		fmt.Fprintf(&b, "**Note:** %s\n\n", v.Run.Note)
	}
	if url != "" {
		fmt.Fprintf(&b, "**[Open it on %s's page →](%s)**\n\n", host, url)
	}
	fence := "```"
	for strings.Contains(v.Run.Script, fence) {
		fence += "`"
	}
	fmt.Fprintf(&b, "## Script\n\n%sbash\n%s\n%s\n", fence, strings.TrimRight(v.Run.Script, "\n"), fence)
	if r := v.Result; r != nil {
		for _, part := range []struct{ name, text string }{{"stdout", r.Stdout}, {"stderr", r.Stderr}} {
			t := trimOutput(part.text, 200, 32000)
			f := "```"
			for strings.Contains(t, f) {
				f += "`"
			}
			head, body, _ := strings.Cut(t, "\n")
			fmt.Fprintf(&b, "\n## %s%s\n\n%s\n%s%s\n", part.name, strings.TrimSuffix(head, ":"), f, body, f)
		}
		fmt.Fprintf(&b, "\nFull output: `%s/`\n", h.dir(host, v.Run.ID))
	}
	return b.String()
}

func (h hostCtx) closeOpen(host, id string) {
	file := filepath.Join(h.state, "open.json")
	items, e := readOpenFile(file)
	if e != nil {
		return
	}
	path := h.docPath(host, id)
	if r, e := filepath.EvalSymlinks(path); e == nil {
		path = r
	}
	kept := items[:0]
	var gone []map[string]any
	for _, it := range items {
		if str(it, "kind") == "doc" && str(it, "path") == path {
			gone = append(gone, it)
			continue
		}
		kept = append(kept, it)
	}
	if len(gone) == 0 || writeOpenFile(file, kept) != nil {
		return
	}
	for _, it := range gone {
		appendOpenClosed(file, it)
	}
}

// notify is a hard notification to target (the instance that asked; a merged
// fork's resolves to its parent), carrying the whole report as the body.
// The scheduler may be restarting; a watcher that can't say what happened
// has done nothing, so it keeps trying for ten minutes.
func (h hostCtx) notify(target, host, id, summary, body string) {
	for i := 0; i < 40; i++ {
		if h.notifyOnce(target, host, id, summary, body) == nil {
			return
		}
		hostSleep(15 * time.Second)
	}
}

func (h hostCtx) notifyOnce(target, host, id, summary, body string) error {
	args := []string{"notify", "--id", "host-run-" + host + "-" + id + "-" + strconv.FormatInt(hostNow().Unix(), 10), "--source", "host-run"}
	if target != "" {
		args = append(args, "--target", target)
	}
	if body != "" {
		args = append(args, "--body", body)
	}
	args = append(args, clip(summary, 300))
	// No FAMILIAR_INSTANCE_ID: the watcher is nobody's instance, and an
	// origin would make a merged fork's note undeliverable.
	env := func(k string) string {
		if k == "FAMILIAR_INSTANCE_ID" {
			return ""
		}
		return h.getenv(k)
	}
	var out bytes.Buffer
	if code := schedulerMain(args, &out, &out, env); code != 0 {
		fmt.Fprintf(h.errw, "notify failed (%d): %s\n", code, out.String())
		return errors.New("notify failed")
	}
	return nil
}
