package supervisor

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"familiar.dev/agents/harnesses"
)

// Tmux addresses only the supervisor-owned server. No command may use the user
// default socket, and server creation always supplies the pinned config.
type Tmux struct{ Binary, Socket, Config string }

var safeName = regexp.MustCompile(`[^A-Za-z0-9_-]`)

func (t Tmux) binary() string {
	if t.Binary != "" {
		return t.Binary
	}
	return "tmux"
}
func (t Tmux) config() string {
	if t.Config != "" {
		return t.Config
	}
	return filepath.Join(filepath.Dir(t.Socket), "tmux.conf")
}
func (t Tmux) Prepare() error {
	if !filepath.IsAbs(t.Socket) {
		return errors.New("tmux socket must be absolute")
	}
	dir := filepath.Dir(t.Socket)
	cfg := t.config()
	if !filepath.IsAbs(cfg) || filepath.Dir(cfg) != dir {
		return errors.New("tmux config must be in private state directory")
	}
	if fi, err := os.Lstat(dir); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		return errors.New("refusing symlink tmux state directory")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	if fi, err := os.Lstat(t.Socket); err == nil && fi.Mode()&os.ModeSocket == 0 {
		return errors.New("tmux socket path is not a socket")
	}
	if fi, err := os.Lstat(cfg); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		return errors.New("refusing symlink tmux config")
	}
	policy := "# Familiar Agent Supervisor complete private tmux policy.\nset-option -g status off\nset-option -g pane-border-status off\nset-option -g remain-on-exit on\nset-option -g exit-empty off\nset-option -g destroy-unattached off\nset-option -g allow-rename off\nset-option -g prefix C-b\nunbind-key C-b\nbind-key C-b send-prefix\nset-option -g mouse on\nbind-key -n PageUp if-shell -F '#{alternate_on}' 'send-keys PageUp' 'copy-mode -eu'\nset-option -g allow-passthrough on\nset-option -g extended-keys on\nset-option -g extended-keys-format csi-u\nset-option -g terminal-features 'xterm*:extkeys,screen*:extkeys,tmux*:extkeys,kitty*:extkeys,ghostty*:extkeys,xterm-ghostty:extkeys'\n"
	return os.WriteFile(cfg, []byte(policy), 0o600)
}
func (t Tmux) run(ctx context.Context, args ...string) (string, error) {
	a := append([]string{"-S", t.Socket}, args...)
	c := exec.CommandContext(ctx, t.binary(), a...)
	configureCommand(c)
	var b bytes.Buffer
	c.Stdout = &b
	c.Stderr = &b
	err := c.Run()
	return strings.TrimSpace(b.String()), err
}
func (t Tmux) ServerAlive(ctx context.Context) bool {
	_, err := t.run(ctx, "show-options", "-g", "status")
	return err == nil
}
func (t Tmux) Has(ctx context.Context, session string) bool {
	_, err := t.run(ctx, "has-session", "-t", session)
	return err == nil
}
func (t Tmux) Start(ctx context.Context, id string, l harnesses.Launch) (string, string, error) {
	if len(l.Argv) == 0 {
		return "", "", errors.New("empty harness argv")
	}
	session := "worker-" + safeName.ReplaceAllString(id, "-")
	if t.Has(ctx, session) {
		return session, session + ":0.0", nil
	}
	if err := os.MkdirAll(filepath.Dir(l.Transcript), 0o700); err != nil {
		return "", "", err
	}
	parts := make([]string, 0, len(l.Env)+len(l.Argv))
	for k, v := range l.Env {
		parts = append(parts, quote(k+"="+v))
	}
	for _, v := range l.Argv {
		parts = append(parts, quote(v))
	}
	// Keep the harness off the PTY so its transcript bytes remain identical to
	// direct file redirection, while tee mirrors those bytes into the pane.
	// pipefail preserves the harness exit status instead of reporting tee's.
	pipeline := "exec env " + strings.Join(parts, " ") + " 2>&1 | tee -a " + quote(l.Transcript)
	cmd := "exec bash -o pipefail -c " + quote(pipeline)
	args := []string{"new-session", "-d", "-s", session, "-n", "worker", "-c", l.Dir, cmd}
	if !t.ServerAlive(ctx) {
		if fi, err := os.Lstat(t.Socket); err == nil && fi.Mode()&os.ModeSocket != 0 {
			_ = os.Remove(t.Socket)
		}
		args = append([]string{"-f", t.config()}, args...)
	}
	if out, err := t.run(ctx, args...); err != nil {
		return "", "", fmt.Errorf("tmux start: %s: %w", out, err)
	}
	return session, session + ":0.0", nil
}
func (t Tmux) Kill(ctx context.Context, session string) error {
	_, err := t.run(ctx, "kill-session", "-t", session)
	return err
}
func (t Tmux) Interrupt(ctx context.Context, target string) error {
	_, err := t.run(ctx, "send-keys", "-t", target, "C-c")
	return err
}
func (t Tmux) Send(ctx context.Context, target, text string) error {
	_, err := t.run(ctx, "send-keys", "-t", target, "-l", text)
	if err == nil {
		_, err = t.run(ctx, "send-keys", "-t", target, "Enter")
	}
	return err
}
func (t Tmux) Pane(ctx context.Context, target string) (bool, *int, error) {
	out, err := t.run(ctx, "display-message", "-p", "-t", target, "#{pane_dead} #{pane_dead_status}")
	if err != nil {
		return false, nil, err
	}
	f := strings.Fields(out)
	if len(f) > 0 && f[0] == "0" {
		return true, nil, nil
	}
	if len(f) > 1 {
		if n, e := strconv.Atoi(f[1]); e == nil {
			return false, &n, nil
		}
	}
	return false, nil, nil
}
func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'" }
