package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Config struct {
	Upstream, Backend                                                          string
	LocalBackend, BackendCommand                                               string
	BackendArgs                                                                []string
	Model, ModelURL, ModelSHA256, Voice, VoicesSource, StateDir, AgeKey, Baker string
	KokoroConfig, KokoroConfigURL, KokoroConfigSHA256                          string
	KokoroVoice, KokoroVoiceURL, KokoroVoiceSHA256                             string
	KokoroConfigSize, KokoroVoiceSize                                          int64
	UpstreamAuthorization                                                      string
	UpstreamHeaders                                                            http.Header
	MaxBody, ModelMinSize, ModelSize                                           int64
	MaxInput, Concurrency                                                      int
	StartupTimeout, DownloadTimeout, RequestTimeout, ShutdownTimeout           time.Duration
}

type Manager struct {
	cfg      Config
	log      *slog.Logger
	mu       sync.Mutex
	child    *exec.Cmd
	starting chan struct{}
	startErr error
	serving  bool
	closed   bool
	lifeCtx  context.Context
	cancel   context.CancelFunc
	client   *http.Client
}

func NewManager(c Config, l *slog.Logger) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	return &Manager{cfg: c, log: l, lifeCtx: ctx, cancel: cancel, client: &http.Client{}}
}
func (m *Manager) ready() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.serving
}

// state reports the lazy backend's lifecycle for readiness reporting:
// "running" once the backend accepts connections, "starting" while a
// single-flight start is in progress, "cold" when no backend is up but
// one will be started lazily on first synthesis, "closed" on shutdown.
func (m *Manager) state() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	switch {
	case m.closed:
		return "closed"
	case m.serving:
		return "running"
	case m.starting != nil:
		return "starting"
	default:
		return "cold"
	}
}
func (m *Manager) Ensure(caller context.Context) error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return errors.New("shutting down")
	}
	if m.serving {
		m.mu.Unlock()
		return nil
	}
	ch := m.starting
	if ch == nil {
		ch = make(chan struct{})
		m.starting = ch
		m.startErr = nil
		go m.runStart(ch)
	}
	m.mu.Unlock()
	select {
	case <-ch:
		m.mu.Lock()
		err := m.startErr
		serving := m.serving
		m.mu.Unlock()
		if err != nil {
			return err
		}
		if !serving {
			return errors.New("backend failed to start")
		}
		return nil
	case <-caller.Done():
		return caller.Err()
	}
}
func (m *Manager) runStart(ch chan struct{}) {
	downloadCtx, cancelDownload := context.WithTimeout(m.lifeCtx, m.cfg.DownloadTimeout)
	err := m.ensureModel(downloadCtx)
	cancelDownload()
	if err == nil {
		startupCtx, cancelStartup := context.WithTimeout(m.lifeCtx, m.cfg.StartupTimeout)
		err = m.start(startupCtx)
		cancelStartup()
	}
	m.mu.Lock()
	m.startErr = err
	if err != nil {
		m.serving = false
	}
	close(ch)
	m.starting = nil
	m.mu.Unlock()
}
func (m *Manager) start(ctx context.Context) error {
	args := append([]string{}, m.cfg.BackendArgs...)
	if m.cfg.LocalBackend == "kokoro" {
		voice := m.cfg.Voice
		if voice == "" {
			voice = "af_heart"
		}
		voicesDir := m.cfg.VoicesSource
		if voicesDir == "" {
			voicesDir = filepath.Dir(m.cfg.KokoroVoice)
		}
		args = append(args, "--model", m.cfg.Model, "--config", m.cfg.KokoroConfig,
			"--voices-dir", voicesDir, "--default-voice", voice)
	} else {
		model, err := m.prepareVoices(ctx)
		if err != nil {
			return err
		}
		args = append(args, "--model-path", model)
		if m.cfg.Voice != "" {
			args = append(args, "--voice", m.cfg.Voice)
		}
	}
	u, _ := url.Parse(m.cfg.Backend)
	host, port, _ := net.SplitHostPort(u.Host)
	args = append(args, "--host", host, "--port", port)
	cmd := exec.CommandContext(m.lifeCtx, m.cfg.BackendCommand, args...)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start backend: %w", err)
	}
	m.mu.Lock()
	m.child = cmd
	m.serving = false
	m.mu.Unlock()
	go func() {
		err := cmd.Wait()
		m.log.Warn("backend exited", "error", err)
		m.mu.Lock()
		if m.child == cmd {
			m.child = nil
			m.serving = false
		}
		m.mu.Unlock()
	}()
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			m.stopCommand(cmd)
			return fmt.Errorf("backend startup: %w", ctx.Err())
		case <-tick.C:
			conn, e := net.DialTimeout("tcp", u.Host, 100*time.Millisecond)
			if e == nil {
				conn.Close()
				m.mu.Lock()
				if m.child == cmd {
					m.serving = true
				}
				ok := m.serving
				m.mu.Unlock()
				if ok {
					return nil
				}
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
func (m *Manager) ensureModel(ctx context.Context) error {
	if m.cfg.LocalBackend == "kokoro" {
		artifacts := []struct {
			path, source, hash string
			size               int64
		}{
			{m.cfg.Model, m.cfg.ModelURL, m.cfg.ModelSHA256, m.cfg.ModelSize},
			{m.cfg.KokoroConfig, m.cfg.KokoroConfigURL, m.cfg.KokoroConfigSHA256, m.cfg.KokoroConfigSize},
		}
		if m.cfg.VoicesSource == "" {
			artifacts = append(artifacts, struct {
				path, source, hash string
				size               int64
			}{m.cfg.KokoroVoice, m.cfg.KokoroVoiceURL, m.cfg.KokoroVoiceSHA256, m.cfg.KokoroVoiceSize})
		}
		for _, a := range artifacts {
			if validateSHA256(a.path, a.hash, a.size) == nil {
				continue
			}
			if a.source == "" || a.hash == "" || a.size <= 0 {
				return fmt.Errorf("Kokoro artifact %q unavailable or invalid: URL, SHA-256, and exact size are required", a.path)
			}
			if err := m.downloadChecked(ctx, a.path, a.source, a.hash, a.size); err != nil {
				return err
			}
		}
		return nil
	}
	if err := validateGGUF(m.cfg.Model, m.cfg.ModelMinSize, m.cfg.ModelSize); err == nil {
		return nil
	}
	if m.cfg.ModelURL == "" {
		return fmt.Errorf("model unavailable or invalid: external provisioning required")
	}
	return m.download(ctx, m.cfg.Model)
}
func (m *Manager) prepareVoices(ctx context.Context) (string, error) {
	model := m.cfg.Model
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
	identity, err := bakerIdentity(m.cfg.Baker)
	if err != nil {
		return "", err
	}
	stamp := baked + ".baker-id"
	oldIdentity, _ := os.ReadFile(stamp)
	if changed || newer(model, baked) || string(oldIdentity) != identity {
		args := append([]string{model, "{output}"}, packs...)
		if err = atomicCommand(ctx, baked, 0600, m.cfg.Baker, args...); err != nil {
			return "", err
		}
		if err = atomicWrite(stamp, []byte(identity), 0600); err != nil {
			_ = os.Remove(baked)
			return "", err
		}
	}
	if err = validateGGUF(baked, m.cfg.ModelMinSize, 0); err != nil {
		return "", fmt.Errorf("invalid baked model: %w", err)
	}
	return baked, nil
}
func validateGGUF(path string, minimum, exact int64) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	if exact > 0 && st.Size() != exact {
		return fmt.Errorf("size %d, expected %d", st.Size(), exact)
	}
	if st.Size() < minimum {
		return fmt.Errorf("size %d below minimum %d", st.Size(), minimum)
	}
	magic := make([]byte, 4)
	if _, err = io.ReadFull(f, magic); err != nil {
		return err
	}
	if string(magic) != "GGUF" {
		return errors.New("missing GGUF magic (HTML, LFS pointer, or corrupt model)")
	}
	return nil
}
func validateSHA256(path, expected string, exact int64) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	if exact > 0 && st.Size() != exact {
		return fmt.Errorf("size %d, expected %d", st.Size(), exact)
	}
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return err
	}
	if !strings.EqualFold(hex.EncodeToString(h.Sum(nil)), expected) {
		return errors.New("SHA-256 mismatch")
	}
	return nil
}

func atomicWrite(dest string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(dest), ".staging-*")
	if err != nil {
		return err
	}
	p := f.Name()
	defer os.Remove(p)
	if err = f.Chmod(mode); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	if x := f.Close(); err == nil {
		err = x
	}
	if err != nil {
		return err
	}
	return os.Rename(p, dest)
}
func bakerIdentity(command string) (string, error) {
	path, err := exec.LookPath(command)
	if err != nil {
		return "", fmt.Errorf("voice baker unavailable: %w", err)
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return "", err
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil)) + "\n", nil
}
func (m *Manager) downloadChecked(ctx context.Context, dest, source, hash string, exact int64) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
		return err
	}
	part := dest + ".part"
	if validateSHA256(part, hash, exact) == nil {
		return os.Rename(part, dest)
	}
	offset := int64(0)
	if st, err := os.Stat(part); err == nil {
		offset = st.Size()
		if offset >= exact {
			if err = os.Remove(part); err != nil {
				return err
			}
			offset = 0
		}
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", source, nil)
	if offset > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	r, err := m.client.Do(req)
	if err != nil {
		return fmt.Errorf("artifact download: %w", err)
	}
	defer r.Body.Close()
	appendMode := offset > 0 && r.StatusCode == http.StatusPartialContent
	if r.StatusCode != http.StatusOK && r.StatusCode != http.StatusPartialContent {
		return fmt.Errorf("artifact download: %s", r.Status)
	}
	flags := os.O_CREATE | os.O_WRONLY
	if appendMode {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_TRUNC
		offset = 0
	}
	f, err := os.OpenFile(part, flags, 0600)
	if err != nil {
		return err
	}
	limited := io.LimitReader(r.Body, exact-offset+1)
	_, err = io.Copy(f, limited)
	if err == nil {
		err = f.Sync()
	}
	if x := f.Close(); err == nil {
		err = x
	}
	if err != nil {
		return err
	}
	if err = validateSHA256(part, hash, exact); err != nil {
		return fmt.Errorf("downloaded artifact rejected: %w", err)
	}
	return os.Rename(part, dest)
}

func (m *Manager) download(ctx context.Context, dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
		return err
	}
	part := dest + ".part"
	if validateGGUF(part, m.cfg.ModelMinSize, m.cfg.ModelSize) == nil {
		return os.Rename(part, dest)
	}
	offset := int64(0)
	if st, err := os.Stat(part); err == nil {
		offset = st.Size()
		// An overlong or declared-complete invalid partial cannot be resumed safely.
		if m.cfg.ModelSize > 0 && offset >= m.cfg.ModelSize {
			if err = os.Remove(part); err != nil {
				return err
			}
			offset = 0
		}
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", m.cfg.ModelURL, nil)
	if offset > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	r, err := m.client.Do(req)
	if err != nil {
		return fmt.Errorf("model download: %w", err)
	}
	defer r.Body.Close()
	appendMode := offset > 0 && r.StatusCode == http.StatusPartialContent
	if r.StatusCode != http.StatusOK && r.StatusCode != http.StatusPartialContent {
		return fmt.Errorf("model download: %s", r.Status)
	}
	flags := os.O_CREATE | os.O_WRONLY
	if appendMode {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_TRUNC
		offset = 0
	}
	f, err := os.OpenFile(part, flags, 0600)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, r.Body)
	if err == nil {
		err = f.Sync()
	}
	if x := f.Close(); err == nil {
		err = x
	}
	if err != nil {
		return err
	}
	if length := r.Header.Get("Content-Length"); length != "" {
		if n, e := strconv.ParseInt(length, 10, 64); e == nil && n >= 0 {
			st, _ := os.Stat(part)
			if st.Size() != offset+n {
				return errors.New("truncated model download")
			}
		}
	}
	if err = validateGGUF(part, m.cfg.ModelMinSize, m.cfg.ModelSize); err != nil {
		return fmt.Errorf("downloaded model rejected: %w", err)
	}
	return os.Rename(part, dest)
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
	m.cancel()
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
	if c.LocalBackend == "" {
		c.LocalBackend = "ttscpp"
	}
	if c.LocalBackend != "ttscpp" && c.LocalBackend != "kokoro" {
		return nil, fmt.Errorf("unknown local backend %q (want ttscpp or kokoro)", c.LocalBackend)
	}
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
		// Cold-local readiness (same semantics as the LLM proxy): the
		// backend is lazy, so "ready" means the proxy can accept a
		// synthesis request and will start the backend on demand — not
		// that the backend is already hot. Without this, a supervised
		// idle TTS never reports ready and blocks dependents.
		if s.mgr != nil {
			state := s.mgr.state()
			if state == "closed" {
				http.Error(w, "shutting down", 503)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, "{\"status\":\"ready\",\"backend\":%q}\n", state)
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
	out.Header.Del("Authorization")
	out.Header.Del("Cookie")
	if s.cfg.UpstreamAuthorization != "" {
		out.Header.Set("Authorization", s.cfg.UpstreamAuthorization)
	}
	for k, values := range s.cfg.UpstreamHeaders {
		out.Header.Del(k)
		for _, value := range values {
			out.Header.Add(k, value)
		}
	}
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
