package cli

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// hostRig: a fake client (a shell script answering from files), a fake
// systemd-run that only records, and a scheduler socket that counts notes.
type hostRig struct {
	t       *testing.T
	state   string
	answer  string // what run-result prints
	env     map[string]string
	mu      sync.Mutex
	notes   []serviceRequest
	started string
}

const hostRunsJSONDone = `{"run":{"id":"aaaaaaaaaaaa","reason":"SSD health","script":"smartctl -a /dev/sda\n","code":"ABC-DEF","created":"2026-10-27T20:00:00Z","state":"done","exit":0},
 "result":{"status":"done","exit":0,"stdout":"SMART overall-health: PASSED\n","stderr":"","started":"2026-10-27T20:01:00Z","finished":"2026-10-27T20:01:05Z"}}`

func newHostRig(t *testing.T) *hostRig {
	t.Helper()
	r := &hostRig{t: t, state: t.TempDir(), env: map[string]string{}}
	bin := t.TempDir()
	r.answer = filepath.Join(bin, "answer.json")
	r.started = filepath.Join(bin, "started")
	client := filepath.Join(bin, "client")
	os.WriteFile(client, []byte(`#!/bin/sh
case "$1" in
  run) echo '{"id":"aaaaaaaaaaaa","code":"ABC-DEF","page":"https://smaug.fort.example/"}' ;;
  run-result) cat "`+r.answer+`" ;;
  runs) echo '[]' ;;
esac
`), 0o755)
	sr := filepath.Join(bin, "systemd-run")
	os.WriteFile(sr, []byte("#!/bin/sh\necho \"$@\" >> "+r.started+"\n"), 0o755)
	sockDir := t.TempDir()
	os.Chmod(sockDir, 0o700)
	sock := filepath.Join(sockDir, "s.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, e := ln.Accept()
			if e != nil {
				return
			}
			line, _ := bufio.NewReader(c).ReadBytes('\n')
			var req serviceRequest
			json.Unmarshal(line, &req)
			r.mu.Lock()
			r.notes = append(r.notes, req)
			r.mu.Unlock()
			c.Write([]byte(`{"ok":true,"result":{"event":{"id":"e1","due_at":1000},"created":true}}` + "\n"))
			c.Close()
		}
	}()
	r.env = map[string]string{"FAMILIAR_STATE_DIR": r.state, "FAMILIAR_HOST_CLIENT": client,
		"FAMILIAR_SYSTEMD_RUN": sr, "FAMILIAR_SERVICES_SOCKET": sock, "FAMILIAR_INSTANCE_ID": "session-a",
		"HOME": t.TempDir()}
	oldPoll, oldBlock, oldWait, oldSleep := hostPoll, hostBlockPoll, hostApprovalWait, hostSleep
	hostPoll, hostBlockPoll, hostSleep = 0, 0, func(time.Duration) {}
	t.Cleanup(func() { hostPoll, hostBlockPoll, hostApprovalWait, hostSleep = oldPoll, oldBlock, oldWait, oldSleep })
	return r
}

func (r *hostRig) setAnswer(s string)     { os.WriteFile(r.answer, []byte(s), 0o644) }
func (r *hostRig) getenv(k string) string { return r.env[k] }
func (r *hostRig) imp(args ...string) (int, string, string) {
	var out, errw bytes.Buffer
	code := Main(append([]string{"host"}, args...), nil, &out, &errw, r.getenv)
	return code, out.String(), errw.String()
}
func (r *hostRig) script() string {
	p := filepath.Join(r.t.TempDir(), "check.sh")
	os.WriteFile(p, []byte("smartctl -a /dev/sda\n"), 0o644)
	return p
}
func (r *hostRig) noteCount() int { r.mu.Lock(); defer r.mu.Unlock(); return len(r.notes) }
func (r *hostRig) watch() string {
	var out, errw bytes.Buffer
	h := hostCtx{state: r.state, getenv: r.getenv, out: &out, errw: &errw}
	h.watch("smaug", "aaaaaaaaaaaa", "https://smaug.fort.example/runs/aaaaaaaaaaaa", "instance:session-a")
	return errw.String()
}

func TestHostRunAsyncPushesOpenAndStartsWatcher(t *testing.T) {
	r := newHostRig(t)
	code, out, errs := r.imp("run", "smaug", r.script(), "SSD health", "--async")
	if code != 0 || !strings.HasPrefix(out, "https://smaug.fort.example/runs/aaaaaaaaaaaa\n") || !strings.Contains(out, "ABC-DEF") {
		t.Fatalf("run: %d %q %q", code, out, errs)
	}
	items, _ := readOpenFile(filepath.Join(r.state, "open.json"))
	if len(items) != 1 || !strings.Contains(str(items[0], "title"), "SSD health") || !strings.HasSuffix(str(items[0], "path"), "smaug-aaaaaaaaaaaa/index.md") {
		t.Fatalf("open %v", items)
	}
	doc, _ := os.ReadFile(filepath.Join(r.state, "host-runs", "smaug-aaaaaaaaaaaa", "index.md"))
	if !strings.Contains(string(doc), "(https://smaug.fort.example/runs/aaaaaaaaaaaa)") || !strings.Contains(string(doc), "smartctl -a /dev/sda") {
		t.Fatalf("doc %s", doc)
	}
	started, _ := os.ReadFile(r.started)
	if !strings.Contains(string(started), "familiar-host-watch-smaug-aaaaaaaaaaaa") || !strings.Contains(string(started), "host _watch smaug aaaaaaaaaaaa") || !strings.Contains(string(started), "--target instance:session-a") {
		t.Fatalf("watcher %s", started)
	}
	// Then the watcher delivers it once, and closes the Open row.
	r.setAnswer(hostRunsJSONDone)
	r.watch()
	if r.noteCount() != 1 {
		t.Fatalf("notes %d", r.noteCount())
	}
	n := r.notes[0].Args
	if n["target"] != "instance:session-a" || n["origin"] != nil || n["urgency"] != nil || !strings.Contains(n["body"].(string), "SMART overall-health: PASSED") || !strings.Contains(n["body"].(string), "full output:") {
		t.Fatalf("note %v", n)
	}
	if items, _ := readOpenFile(filepath.Join(r.state, "open.json")); len(items) != 0 {
		t.Fatalf("open row not closed: %v", items)
	}
}

func TestHostRunBlocksAndDeliversOnce(t *testing.T) {
	r := newHostRig(t)
	r.setAnswer(hostRunsJSONDone)
	code, out, errs := r.imp("run", "smaug", r.script(), "SSD health")
	if code != 0 || !strings.Contains(out, "smaug run aaaaaaaaaaaa done, exit 0") || !strings.Contains(out, "SMART overall-health: PASSED") {
		t.Fatalf("blocking run: %d %q %q", code, out, errs)
	}
	if _, e := os.Stat(filepath.Join(r.state, "host-runs", "smaug-aaaaaaaaaaaa", "blocking")); e == nil {
		t.Fatal("lease left behind")
	}
	if b, _ := os.ReadFile(filepath.Join(r.state, "host-runs", "smaug-aaaaaaaaaaaa", "stdout.txt")); string(b) != "SMART overall-health: PASSED\n" {
		t.Fatalf("stdout.txt %q", b)
	}
	r.watch() // the watcher also sees it settle: it must stay quiet
	if r.noteCount() != 0 {
		t.Fatalf("delivered twice: %v", r.notes)
	}
}

func TestHostRunBlockingTimesOutThenWatcherDelivers(t *testing.T) {
	r := newHostRig(t)
	hostApprovalWait = 0
	r.setAnswer(strings.Replace(`{"run":{"id":"aaaaaaaaaaaa","reason":"SSD health","script":"x","code":"ABC-DEF","created":"2026-10-27T20:00:00Z","state":"pending"}}`, "\n", "", -1))
	code, out, _ := r.imp("run", "smaug", r.script(), "SSD health")
	if code != 0 || !strings.Contains(out, "still pending") || !strings.Contains(out, "https://smaug.fort.example/runs/aaaaaaaaaaaa") {
		t.Fatalf("timeout: %d %q", code, out)
	}
	r.setAnswer(hostRunsJSONDone)
	r.watch()
	if r.noteCount() != 1 {
		t.Fatalf("notes after handover: %d", r.noteCount())
	}
}

func TestHostRunRejectedReturnsAtOnce(t *testing.T) {
	r := newHostRig(t)
	r.setAnswer(`{"run":{"id":"aaaaaaaaaaaa","reason":"SSD health","script":"x","code":"ABC-DEF","created":"2026-10-27T20:00:00Z","state":"rejected"}}`)
	code, out, _ := r.imp("run", "smaug", r.script(), "SSD health")
	if code != 0 || !strings.Contains(out, "rejected") || !strings.Contains(out, "It never ran") {
		t.Fatalf("rejected: %d %q", code, out)
	}
}

func TestHostWatcherDefersToFreshLease(t *testing.T) {
	r := newHostRig(t)
	dir := filepath.Join(r.state, "host-runs", "smaug-aaaaaaaaaaaa")
	os.MkdirAll(dir, 0o755)
	r.setAnswer(hostRunsJSONDone)
	h := hostCtx{state: r.state, getenv: r.getenv}
	h.touchLease("smaug", "aaaaaaaaaaaa")
	if !h.leaseFresh("smaug", "aaaaaaaaaaaa") {
		t.Fatal("lease not fresh")
	}
	old := time.Now().Add(-time.Minute)
	os.Chtimes(filepath.Join(dir, "blocking"), old, old)
	if h.leaseFresh("smaug", "aaaaaaaaaaaa") {
		t.Fatal("stale lease counted as fresh")
	}
	if !h.claim("smaug", "aaaaaaaaaaaa") || h.claim("smaug", "aaaaaaaaaaaa") {
		t.Fatal("claim is not once-only")
	}
}

func TestHostUsage(t *testing.T) {
	r := newHostRig(t)
	if code, _, _ := r.imp("run", "smaug", r.script()); code != ExitUsage {
		t.Fatal("run without a reason accepted")
	}
	if code, _, _ := r.imp("result", "Smaug!", "aaaaaaaaaaaa"); code != ExitUsage {
		t.Fatal("bad host accepted")
	}
	if code, out, _ := r.imp("--help"); code != 0 || !strings.Contains(out, "--async") {
		t.Fatal("help")
	}
}

func TestTrimOutputKeepsHeadAndTail(t *testing.T) {
	var lines []string
	for i := 0; i < 100; i++ {
		lines = append(lines, "line")
	}
	lines[0], lines[99] = "FIRST", "LAST"
	got := trimOutput(strings.Join(lines, "\n"), 30, 10000)
	if !strings.Contains(got, "FIRST") || !strings.Contains(got, "LAST") || !strings.Contains(got, "lines left out") || !strings.Contains(got, "(100 lines, trimmed)") {
		t.Fatalf("%s", got)
	}
}
