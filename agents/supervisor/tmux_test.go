package supervisor

import (
	"context"
	"familiar.dev/agents/harnesses"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPrivateTmuxLifecycle(t *testing.T) {
	if _, e := exec.LookPath("tmux"); e != nil {
		t.Skip("tmux absent")
	}
	dir := t.TempDir()
	tm := Tmux{Socket: filepath.Join(dir, "tmux.sock")}
	if e := tm.Prepare(); e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	transcript := filepath.Join(dir, "out")
	s, target, e := tm.Start(ctx, "test", harnesses.Launch{Argv: []string{"sh", "-c", "printf 'visible-out\\n'; printf 'visible-err\\n' >&2; exit 7"}, Dir: dir, Transcript: transcript})
	if e != nil {
		t.Fatal(e)
	}
	if !strings.HasPrefix(target, s+":") {
		t.Fatal(target)
	}
	if !tm.Has(ctx, s) {
		t.Fatal("session absent")
	}
	if out, e := tm.run(ctx, "show-options", "-gv", "allow-passthrough"); e != nil || out != "on" {
		t.Fatalf("explicit config missing: %q %v", out, e)
	}
	if out, e := tm.run(ctx, "show-options", "-gv", "mouse"); e != nil || out != "on" {
		t.Fatalf("mouse arbitration missing: %q %v", out, e)
	}
	if out, e := tm.run(ctx, "list-keys", "-T", "root", "PageUp"); e != nil || !strings.Contains(out, "#{alternate_on}") {
		t.Fatalf("PageUp arbitration missing: %q %v", out, e)
	}
	var exit *int
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
		alive, code, paneErr := tm.Pane(ctx, target)
		if paneErr != nil {
			t.Fatal(paneErr)
		}
		if !alive {
			exit = code
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if exit == nil || *exit != 7 {
		t.Fatalf("pipeline lost harness exit status: %v", exit)
	}
	pane, e := tm.run(ctx, "capture-pane", "-p", "-S", "-", "-t", target)
	if e != nil || !strings.Contains(pane, "visible-out") || !strings.Contains(pane, "visible-err") {
		t.Fatalf("harness output not visible in pane: %q %v", pane, e)
	}
	got, e := os.ReadFile(transcript)
	if e != nil || string(got) != "visible-out\nvisible-err\n" {
		t.Fatalf("transcript is not an exact output copy: %q %v", got, e)
	}
	_, _ = tm.run(ctx, "kill-server")
}
