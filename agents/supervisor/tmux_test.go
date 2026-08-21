package supervisor

import (
	"context"
	"familiar.dev/agents/harnesses"
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
	s, target, e := tm.Start(ctx, "test", harnesses.Launch{Argv: []string{"sh", "-c", "sleep .2"}, Dir: dir, Transcript: filepath.Join(dir, "out")})
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
	_, _ = tm.run(ctx, "kill-server")
}
