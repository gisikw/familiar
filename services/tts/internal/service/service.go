package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Config struct {
	Upstream, Backend                                             string
	BackendCommand                                                string
	BackendArgs                                                   []string
	Model, ModelURL, Voice, VoicesSource, StateDir, AgeKey, Baker string
	MaxBody                                                       int64
	MaxInput, Concurrency                                         int
	StartupTimeout, RequestTimeout, ShutdownTimeout               time.Duration
}

type Manager struct {
	cfg      Config
	log      *slog.Logger
	mu       sync.Mutex
	child    *exec.Cmd
	starting chan struct{}
	closed   bool
	client   *http.Client
}

func NewManager(c Config, l *slog.Logger) *Manager {
	return &Manager{cfg: c, log: l, client: &http.Client{Timeout: c.StartupTimeout}}
}
func (m *Manager) ready() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.child != nil
}
func (m *Manager) Ensure(ctx context.Context) error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return errors.New("shutting down")
	}
	if m.child != nil {
		m.mu.Unlock()
		return nil
	}
	if ch := m.starting; ch != nil {
		m.mu.Unlock()
		select {
		case <-ch:
			return m.startResult()
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	ch := make(chan struct{})
	m.starting = ch
	m.mu.Unlock()
	err := m.start(ctx)
	m.mu.Lock()
	if err != nil {
		m.child = nil
	}
	close(ch)
	m.starting = nil
	m.mu.Unlock()
	return err
}
func (m *Manager) startResult() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.child == nil {
		return errors.New("backend failed to start")
	}
	return nil
}
func (m *Manager) start(ctx context.Context) error {
	model, err := m.prepare(ctx)
	if err != nil {
		return err
	}
	args := append([]string{}, m.cfg.BackendArgs...)
	args = append(args, "--model-path", model)
	if m.cfg.Voice != "" {
		args = append(args, "--voice", m.cfg.Voice)
	}
	u, _ := url.Parse(m.cfg.Backend)
	host, port, _ := net.SplitHostPort(u.Host)
	args = append(args, "--host", host, "--port", port)
	cmd := exec.Command(m.cfg.BackendCommand, args...)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err = cmd.Start(); err != nil {
		return fmt.Errorf("start backend: %w", err)
	}
	m.mu.Lock()
	m.child = cmd
	m.mu.Unlock()
	go func() {
		err := cmd.Wait()
		m.log.Warn("backend exited", "error", err)
		m.mu.Lock()
		if m.child == cmd {
			m.child = nil
		}
		m.mu.Unlock()
	}()
	deadline := time.NewTimer(m.cfg.StartupTimeout)
	defer deadline.Stop()
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			m.stopCommand(cmd)
			return ctx.Err()
		case <-deadline.C:
			m.stopCommand(cmd)
			return errors.New("backend startup deadline exceeded")
		case <-tick.C:
			conn, e := net.DialTimeout("tcp", u.Host, 100*time.Millisecond)
			if e == nil {
				conn.Close()
				return nil
			}
			m.mu.Lock()
			dead := m.child != cmd
			m.mu.Unlock()
			if dead {
				return errors.New("backend exited during startup")
			}
		}
	}
}
func newer(a, b string) bool {
	ai, e := os.Stat(a)
	if e != nil {
		return false
	}
	bi, e := os.Stat(b)
	return e != nil || ai.ModTime().After(bi.ModTime())
}
func atomicCommand(ctx context.Context, dest string, mode os.FileMode, name string, args ...string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dest), ".staging-*")
	if err != nil {
		return err
	}
	path := tmp.Name()
	tmp.Close()
	os.Remove(path)
	defer os.Remove(path)
	args2 := make([]string, len(args))
	for i, a := range args {
		args2[i] = strings.ReplaceAll(a, "{output}", path)
	}
	cmd := exec.CommandContext(ctx, name, args2...)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err = cmd.Run(); err != nil {
		return fmt.Errorf("runtime preparation failed: %w", err)
	}
	f, err := os.OpenFile(path, os.O_RDONLY, 0)
	if err != nil {
		return errors.New("runtime preparation produced no artifact")
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	f.Close()
	if err = os.Chmod(path, mode); err != nil {
		return err
	}
	return os.Rename(path, dest)
}
func (m *Manager) prepare(ctx context.Context) (string, error) {
	model := m.cfg.Model
	if _, err := os.Stat(model); err != nil && m.cfg.ModelURL != "" {
		if err = m.download(ctx, model); err != nil {
			return "", err
		}
	}
	if _, err := os.Stat(model); err != nil {
		return "", fmt.Errorf("model unavailable: %w", err)
	}
	if m.cfg.VoicesSource == "" {
		return model, nil
	}
	entries, err := os.ReadDir(m.cfg.VoicesSource)
	if err != nil {
		if os.IsNotExist(err) {
			return model, nil
		}
		return "", err
	}
	voiceDir := filepath.Join(m.cfg.StateDir, "voices", "kokoro")
	var packs []string
	changed := false
	for _, e := range entries {
		n := e.Name()
		if e.IsDir() || (!strings.HasSuffix(n, ".pt") && !strings.HasSuffix(n, ".pt.age")) {
			continue
		}
		base := strings.TrimSuffix(strings.TrimSuffix(n, ".age"), ".pt")
		dst := filepath.Join(voiceDir, base+".pt")
		src := filepath.Join(m.cfg.VoicesSource, n)
		if newer(src, dst) {
			if strings.HasSuffix(n, ".age") {
				if m.cfg.AgeKey == "" {
					return "", errors.New("encrypted voice requires age key")
				}
				err = atomicCommand(ctx, dst, 0600, "age", "-i", m.cfg.AgeKey, "--decrypt", "-o", "{output}", src)
			} else {
				err = atomicCommand(ctx, dst, 0600, "cp", src, "{output}")
			}
			if err != nil {
				return "", err
			}
			changed = true
		}
		packs = append(packs, dst)
	}
	if len(packs) == 0 {
		return model, nil
	}
	baked := filepath.Join(m.cfg.StateDir, "models", "baked-"+filepath.Base(model))
	if changed || newer(model, baked) {
		args := append([]string{model, "{output}"}, packs...)
		if err = atomicCommand(ctx, baked, 0600, m.cfg.Baker, args...); err != nil {
			return "", err
		}
	}
	return baked, nil
}
func (m *Manager) download(ctx context.Context, dest string) error {
	req, _ := http.NewRequestWithContext(ctx, "GET", m.cfg.ModelURL, nil)
	r, e := m.client.Do(req)
	if e != nil {
		return e
	}
	defer r.Body.Close()
	if r.StatusCode/100 != 2 {
		return fmt.Errorf("model download: %s", r.Status)
	}
	if e = os.MkdirAll(filepath.Dir(dest), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(dest), ".download-*")
	if e != nil {
		return e
	}
	p := f.Name()
	defer os.Remove(p)
	_, e = io.Copy(f, r.Body)
	if e == nil {
		e = f.Sync()
	}
	if x := f.Close(); e == nil {
		e = x
	}
	if e != nil {
		return e
	}
	return os.Rename(p, dest)
}
func (m *Manager) stopCommand(c *exec.Cmd) {
	if c == nil || c.Process == nil {
		return
	}
	_ = syscall.Kill(-c.Process.Pid, syscall.SIGTERM)
	deadline := time.Now().Add(m.cfg.ShutdownTimeout)
	for time.Now().Before(deadline) {
		m.mu.Lock()
		done := m.child != c
		m.mu.Unlock()
		if done {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	_ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
}
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	starting := m.starting
	m.mu.Unlock()
	// If shutdown races the single-flight start, do not let it orphan a child.
	if starting != nil {
		<-starting
	}
	m.mu.Lock()
	c := m.child
	m.mu.Unlock()
	m.stopCommand(c)
}

type Server struct {
	cfg       Config
	mgr       *Manager
	target    *url.URL
	transport *http.Transport
	sem       chan struct{}
	log       *slog.Logger
}

func New(c Config, l *slog.Logger) (*Server, error) {
	target := c.Upstream
	if target == "" {
		target = c.Backend
	}
	u, e := url.Parse(target)
	if e != nil {
		return nil, e
	}
	return &Server{c, mustManager(c, l), u, &http.Transport{Proxy: http.ProxyFromEnvironment, DisableCompression: true}, make(chan struct{}, c.Concurrency), l}, nil
}
func mustManager(c Config, l *slog.Logger) *Manager {
	if c.Upstream != "" {
		return nil
	}
	return NewManager(c, l)
}
func (s *Server) Close() {
	s.transport.CloseIdleConnections()
	if s.mgr != nil {
		s.mgr.Close()
	}
}
func (s *Server) Handler() http.Handler { return http.HandlerFunc(s.serve) }
func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/livez":
		w.WriteHeader(200)
		_, _ = w.Write([]byte("ok\n"))
		return
	case "/readyz":
		if s.mgr != nil && !s.mgr.ready() {
			http.Error(w, "not ready", 503)
			return
		}
		w.WriteHeader(200)
		_, _ = w.Write([]byte("ok\n"))
		return
	}
	if r.URL.Path != "/v1/audio/speech" || r.Method != "POST" {
		http.NotFound(w, r)
		return
	}
	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	default:
		http.Error(w, "busy", 429)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxBody)
	body, e := io.ReadAll(r.Body)
	if e != nil {
		http.Error(w, "request too large", 413)
		return
	}
	var p struct {
		Input string          `json:"input"`
		Voice json.RawMessage `json:"voice"`
	}
	if e = json.Unmarshal(body, &p); e != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	if p.Input == "" || len([]byte(p.Input)) > s.cfg.MaxInput {
		http.Error(w, "invalid input length", 400)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.RequestTimeout)
	defer cancel()
	if s.mgr != nil {
		if e = s.mgr.Ensure(ctx); e != nil {
			s.log.Error("backend unavailable", "error", e)
			http.Error(w, "backend unavailable", 503)
			return
		}
	}
	out, _ := http.NewRequestWithContext(ctx, "POST", s.target.ResolveReference(&url.URL{Path: "/v1/audio/speech"}).String(), bytes.NewReader(body))
	copyHeaders(out.Header, r.Header)
	out.Host = s.target.Host
	resp, e := s.transport.RoundTrip(out)
	if e != nil {
		s.log.Warn("synthesis failed", "error", e)
		http.Error(w, "bad gateway", 502)
		return
	}
	defer resp.Body.Close()
	copyHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

var hop = map[string]bool{"connection": true, "proxy-connection": true, "keep-alive": true, "proxy-authenticate": true, "proxy-authorization": true, "te": true, "trailer": true, "transfer-encoding": true, "upgrade": true}

func copyHeaders(dst, src http.Header) {
	blocked := make(map[string]bool, len(hop))
	for k, v := range hop {
		blocked[k] = v
	}
	// RFC 9110 also makes every field named by Connection hop-by-hop.
	for _, value := range src.Values("Connection") {
		for _, name := range strings.Split(value, ",") {
			blocked[strings.ToLower(strings.TrimSpace(name))] = true
		}
	}
	for k, v := range src {
		if blocked[strings.ToLower(k)] {
			continue
		}
		for _, x := range v {
			dst.Add(k, x)
		}
	}
}
