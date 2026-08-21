package supervisor

import (
	"bytes"
	"context"
	"errors"
	"familiar.dev/agents/harnesses"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type Tmux struct{ Binary, Socket, Config string }

var safeName = regexp.MustCompile(`[^A-Za-z0-9_-]`)

func (t Tmux) Prepare() error {
	if t.Binary == "" {
		t.Binary = "tmux"
	}
	if !filepath.IsAbs(t.Socket) {
		return errors.New("tmux socket must be absolute")
	}
	if e := os.MkdirAll(filepath.Dir(t.Socket), 0700); e != nil {
		return e
	}
	cfg := "set-option -g status off\nset-option -g remain-on-exit on\nset-option -g exit-empty off\nset-option -g destroy-unattached off\nset-option -g allow-rename off\nset-option -g allow-passthrough on\n"
	return os.WriteFile(t.Config, []byte(cfg), 0600)
}
func (t Tmux) run(ctx context.Context, args ...string) (string, error) {
	a := append([]string{"-S", t.Socket}, args...)
	c := exec.CommandContext(ctx, t.Binary, a...)
	var b bytes.Buffer
	c.Stdout = &b
	c.Stderr = &b
	e := c.Run()
	return strings.TrimSpace(b.String()), e
}
func (t Tmux) ServerAlive(ctx context.Context) bool {
	_, e := t.run(ctx, "show-options", "-g", "status")
	return e == nil
}
func (t Tmux) Has(ctx context.Context, s string) bool {
	_, e := t.run(ctx, "has-session", "-t", s)
	return e == nil
}
func (t Tmux) Start(ctx context.Context, id string, l harnesses.Launch) (string, string, error) {
	s := "worker-" + safeName.ReplaceAllString(id, "-")
	if t.Has(ctx, s) {
		return s, s + ":0.0", nil
	}
	if e := os.MkdirAll(filepath.Dir(l.Transcript), 0700); e != nil {
		return "", "", e
	}
	parts := make([]string, len(l.Argv))
	for i, v := range l.Argv {
		parts[i] = quote(v)
	}
	cmd := "exec " + strings.Join(parts, " ") + " >>" + quote(l.Transcript) + " 2>&1"
	args := []string{"new-session", "-d", "-s", s, "-n", "worker", "-c", l.Dir, cmd}
	if !t.ServerAlive(ctx) {
		if fi, e := os.Lstat(t.Socket); e == nil && fi.Mode()&os.ModeSocket != 0 {
			os.Remove(t.Socket)
		}
		args = append([]string{"-f", t.Config}, args...)
	}
	if out, e := t.run(ctx, args...); e != nil {
		return "", "", fmt.Errorf("tmux start: %s: %w", out, e)
	}
	return s, s + ":0.0", nil
}
func (t Tmux) Kill(ctx context.Context, s string) error {
	_, e := t.run(ctx, "kill-session", "-t", s)
	return e
}
func (t Tmux) Pane(ctx context.Context, target string) (alive bool, exit *int, err error) {
	o, e := t.run(ctx, "display-message", "-p", "-t", target, "#{pane_dead} #{pane_dead_status}")
	if e != nil {
		return false, nil, e
	}
	f := strings.Fields(o)
	if len(f) > 0 && f[0] == "0" {
		return true, nil, nil
	}
	if len(f) > 1 {
		n, x := strconv.Atoi(f[1])
		if x == nil {
			return false, &n, nil
		}
	}
	return false, nil, nil
}
func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'" }
