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

func TestGeneratedTmuxThemeIsComposed(t *testing.T) {
	dir := t.TempDir()
	theme := filepath.Join(dir, "theme.conf")
	if err := os.WriteFile(theme, []byte("set-option -g mode-style 'fg=colour1,bg=colour2'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAMILIAR_TMUX_THEME_CONFIG", theme)
	tm := Tmux{Socket: filepath.Join(dir, "tmux.sock")}
	if err := tm.Prepare(); err != nil {
		t.Fatal(err)
	}
	config, err := os.ReadFile(tm.config())
	if err != nil || !strings.Contains(string(config), "mode-style 'fg=colour1,bg=colour2'") {
		t.Fatalf("generated theme not composed: %q %v", config, err)
	}
}

func TestMissingThemeIsNonBlocking(t *testing.T) {
	dir := t.TempDir()
	// A theme artifact that does not exist (or is a symlink) must be skipped so
	// workers still start on the plain policy config — theming is cosmetic.
	t.Setenv("FAMILIAR_TMUX_THEME_CONFIG", filepath.Join(dir, "absent.conf"))
	tm := Tmux{Socket: filepath.Join(dir, "tmux.sock")}
	if err := tm.Prepare(); err != nil {
		t.Fatalf("missing theme blocked worker start: %v", err)
	}
	config, err := os.ReadFile(tm.config())
	if err != nil || !strings.Contains(string(config), "allow-passthrough on") {
		t.Fatalf("plain policy not written when theme absent: %q %v", config, err)
	}
	if strings.Contains(string(config), "canonical Familiar palette") {
		t.Fatal("absent theme should not compose a palette section")
	}
}

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

func TestInteractiveLaunchOwnsPaneWithoutTee(t *testing.T) {
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
	t.Cleanup(func() { _, _ = tm.run(context.Background(), "kill-server") })
	transcript := filepath.Join(dir, "out")
	// An interactive harness owns the pane PTY directly: no tee pipeline, so the
	// transcript file is never created. The pane still shows its output.
	s, target, e := tm.Start(ctx, "interactive", harnesses.Launch{Argv: []string{"sh", "-c", "printf 'tui-live\\n'; sleep 0.5"}, Dir: dir, Transcript: transcript, Interactive: true})
	if e != nil {
		t.Fatal(e)
	}
	start := tm.mustPaneCommand(ctx, t, target)
	if strings.Contains(start, "tee") || strings.Contains(start, "pipefail") {
		t.Fatalf("interactive launch wrapped harness in tee pipeline: %q", start)
	}
	if _, err := os.Stat(transcript); !os.IsNotExist(err) {
		t.Fatalf("interactive launch created a transcript file: %v", err)
	}
	_ = s
}

func (t Tmux) mustPaneCommand(ctx context.Context, tb *testing.T, target string) string {
	tb.Helper()
	out, err := t.run(ctx, "display-message", "-p", "-t", target, "#{pane_start_command}")
	if err != nil {
		tb.Fatal(err)
	}
	return out
}
