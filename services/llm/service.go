// Package llm implements Familiar's stable, loopback LLM proxy.
package llm

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Config struct {
	Listen, Upstream, Backend, LlamaServer, ModelDir, ModelFile                    string
	Context, GPULayers                                                             int
	MaxBody                                                                        int64
	DiagnosticBytes                                                                int
	DebugChild                                                                     bool
	StartupTimeout, HeaderTimeout, ReadHeaderTimeout, BodyTimeout, ShutdownTimeout time.Duration
}

func DefaultConfig() Config {
	return Config{
		Listen: "127.0.0.1:9931", Backend: "127.0.0.1:9934", LlamaServer: "llama-server",
		ModelDir: "models", Context: 32768, GPULayers: 999, MaxBody: 32 << 20, DiagnosticBytes: 16 << 10,
		StartupTimeout: 2 * time.Minute, HeaderTimeout: 2 * time.Minute, ReadHeaderTimeout: 10 * time.Second, BodyTimeout: 30 * time.Second, ShutdownTimeout: 10 * time.Second,
	}
}

func ConfigFromEnv() (Config, error) {
	c := DefaultConfig()
	str := func(key string, dst *string) {
		if v := os.Getenv(key); v != "" {
			*dst = v
		}
	}
	str("FAMILIAR_LLM_LISTEN", &c.Listen)
	str("FAMILIAR_LLM_UPSTREAM", &c.Upstream)
	str("FAMILIAR_LLM_BACKEND", &c.Backend)
	str("FAMILIAR_LLAMA_SERVER", &c.LlamaServer)
	str("FAMILIAR_MODEL_DIR", &c.ModelDir)
	str("FAMILIAR_MODEL_FILE", &c.ModelFile)
	ints := []struct {
		k string
		p *int
	}{{"FAMILIAR_LLM_CONTEXT", &c.Context}, {"FAMILIAR_LLM_GPU_LAYERS", &c.GPULayers}, {"FAMILIAR_LLM_DIAGNOSTIC_BYTES", &c.DiagnosticBytes}}
	for _, x := range ints {
		if v := os.Getenv(x.k); v != "" {
			n, e := strconv.Atoi(v)
			if e != nil {
				return c, fmt.Errorf("%s: %w", x.k, e)
			}
			*x.p = n
		}
	}
	if v := os.Getenv("FAMILIAR_LLM_MAX_BODY_BYTES"); v != "" {
		n, e := strconv.ParseInt(v, 10, 64)
		if e != nil {
			return c, e
		}
		c.MaxBody = n
	}
	if v := os.Getenv("FAMILIAR_LLM_DEBUG_CHILD"); v != "" {
		b, e := strconv.ParseBool(v)
		if e != nil {
			return c, fmt.Errorf("FAMILIAR_LLM_DEBUG_CHILD: %w", e)
		}
		c.DebugChild = b
	}
	durs := []struct {
		k string
		p *time.Duration
	}{{"FAMILIAR_LLM_STARTUP_TIMEOUT", &c.StartupTimeout}, {"FAMILIAR_LLM_HEADER_TIMEOUT", &c.HeaderTimeout}, {"FAMILIAR_LLM_READ_HEADER_TIMEOUT", &c.ReadHeaderTimeout}, {"FAMILIAR_LLM_BODY_TIMEOUT", &c.BodyTimeout}, {"FAMILIAR_LLM_SHUTDOWN_TIMEOUT", &c.ShutdownTimeout}}
	for _, x := range durs {
		if v := os.Getenv(x.k); v != "" {
			d, e := time.ParseDuration(v)
			if e != nil {
				return c, fmt.Errorf("%s: %w", x.k, e)
			}
			*x.p = d
		}
	}
	if err := validateConfig(c); err != nil {
		return c, err
	}
	return c, nil
}

func isLoopback(addr string) bool {
	h, _, e := net.SplitHostPort(addr)
	if e != nil {
		return false
	}
	h = strings.TrimSuffix(strings.ToLower(h), ".")
	ip := net.ParseIP(h)
	return h == "localhost" || (ip != nil && ip.IsLoopback())
}

func normalizedEndpoint(hostport, scheme string) (string, bool) {
	h, p, err := net.SplitHostPort(hostport)
	if err != nil {
		h = hostport
		p = ""
	}
	if p == "" {
		if scheme == "https" {
			p = "443"
		} else if scheme == "http" {
			p = "80"
		} else {
			return "", false
		}
	}
	if n, err := strconv.ParseUint(p, 10, 16); err == nil {
		p = strconv.FormatUint(n, 10)
	}
	h = strings.TrimSuffix(strings.ToLower(strings.Trim(h, "[]")), ".")
	ip := net.ParseIP(h)
	if h == "localhost" || (ip != nil && ip.IsLoopback()) {
		h = "loopback"
	}
	return net.JoinHostPort(h, p), true
}

func sameEndpoint(listen string, upstream *url.URL) bool {
	a, ok1 := normalizedEndpoint(listen, "")
	b, ok2 := normalizedEndpoint(upstream.Host, upstream.Scheme)
	return ok1 && ok2 && a == b
}

func validateConfig(c Config) error {
	if !isLoopback(c.Listen) {
		return fmt.Errorf("listen address %q is not loopback", c.Listen)
	}
	if c.MaxBody <= 0 || c.DiagnosticBytes <= 0 || c.DiagnosticBytes > maxDiagnosticBytes || c.StartupTimeout <= 0 || c.HeaderTimeout <= 0 || c.ReadHeaderTimeout <= 0 || c.BodyTimeout <= 0 || c.ShutdownTimeout <= 0 {
		return fmt.Errorf("limits and timeouts must be positive; diagnostic bytes must not exceed %d", maxDiagnosticBytes)
	}
	return nil
}

type Service struct {
	cfg    Config
	log    *slog.Logger
	target *url.URL
	proxy  *httputil.ReverseProxy
	mgr    *backendManager
}

func New(c Config, logger *slog.Logger) (*Service, error) {
	if logger == nil {
		logger = slog.Default()
	}
	s := &Service{cfg: c, log: logger}
	if err := validateConfig(c); err != nil {
		return nil, err
	}
	if c.Upstream != "" {
		u, e := url.Parse(c.Upstream)
		if e != nil || (!strings.EqualFold(u.Scheme, "http") && !strings.EqualFold(u.Scheme, "https")) || u.Host == "" {
			return nil, fmt.Errorf("invalid upstream URL")
		}
		u.Scheme = strings.ToLower(u.Scheme)
		if sameEndpoint(c.Listen, u) {
			return nil, fmt.Errorf("upstream resolves to proxy listen endpoint")
		}
		s.target = u
	} else {
		if !isLoopback(c.Backend) {
			return nil, fmt.Errorf("local backend address must be loopback")
		}
		u, _ := url.Parse("http://" + c.Backend)
		if sameEndpoint(c.Listen, u) {
			return nil, fmt.Errorf("local backend collides with proxy listen endpoint")
		}
		if c.ModelFile == "" {
			return nil, errors.New("FAMILIAR_MODEL_FILE is required for local mode")
		}
		model := filepath.Join(c.ModelDir, c.ModelFile)
		info, e := os.Stat(model)
		if e != nil || !info.Mode().IsRegular() {
			return nil, fmt.Errorf("local model prerequisite unavailable")
		}
		if _, e = exec.LookPath(c.LlamaServer); e != nil {
			return nil, fmt.Errorf("llama-server executable unavailable")
		}
		s.target = u
		s.mgr = &backendManager{cfg: c, log: logger}
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.ResponseHeaderTimeout = c.HeaderTimeout
	tr.MaxIdleConnsPerHost = 32
	p := httputil.NewSingleHostReverseProxy(s.target)
	p.Transport = tr
	p.FlushInterval = -1
	orig := p.Director
	p.Director = func(r *http.Request) { orig(r); r.Host = s.target.Host }
	p.ErrorHandler = func(w http.ResponseWriter, r *http.Request, e error) {
		logger.Warn("backend request failed", "method", r.Method, "error", safeError(e))
		http.Error(w, "LLM backend unavailable", http.StatusBadGateway)
	}
	s.proxy = p
	return s, nil
}

func safeError(e error) string {
	if errors.Is(e, context.DeadlineExceeded) {
		return "timeout"
	}
	if errors.Is(e, context.Canceled) {
		return "canceled"
	}
	return "backend transport error"
}
func (s *Service) Handler() http.Handler { return http.HandlerFunc(s.serve) }
func (s *Service) serve(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/live":
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, "{\"status\":\"ok\"}\n")
		return
	case "/ready":
		state := "upstream"
		if s.mgr != nil {
			state = s.mgr.state()
		}
		if state == "closing" {
			http.Error(w, "shutting down", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, "{\"status\":\"ready\",\"backend\":%q}\n", state)
		return
	}
	if r.ContentLength > s.cfg.MaxBody {
		http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
		return
	}
	// Buffer only the bounded inference payload so chunked bodies can be rejected
	// before contacting the backend (and can never become a partial inference).
	if r.Body != nil {
		controller := http.NewResponseController(w)
		_ = controller.SetReadDeadline(time.Now().Add(s.cfg.BodyTimeout))
		body, err := io.ReadAll(io.LimitReader(r.Body, s.cfg.MaxBody+1))
		_ = controller.SetReadDeadline(time.Time{})
		_ = r.Body.Close()
		if err != nil {
			var timeout interface{ Timeout() bool }
			if errors.As(err, &timeout) && timeout.Timeout() {
				http.Error(w, "request body timeout", http.StatusRequestTimeout)
			} else {
				http.Error(w, "invalid request body", http.StatusBadRequest)
			}
			return
		}
		if int64(len(body)) > s.cfg.MaxBody {
			http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		r.ContentLength = int64(len(body))
	}
	if s.mgr != nil {
		if err := s.mgr.ensure(r.Context()); err != nil {
			s.log.Warn("local backend unavailable", "error", safeError(err))
			http.Error(w, "local LLM backend unavailable", 503)
			return
		}
	}
	s.proxy.ServeHTTP(w, r)
}
func (s *Service) Close(ctx context.Context) error {
	if s.mgr != nil {
		return s.mgr.close(ctx)
	}
	return nil
}

const maxDiagnosticBytes = 64 << 10

var (
	bearerSecret = regexp.MustCompile(`(?i)\bbearer\s+[^\s,;]+`)
	namedSecret  = regexp.MustCompile(`(?im)\b(authorization|api[-_ ]?key|access[-_ ]?token|token|secret|password)\b[^\r\n]*`)
	urlSecret    = regexp.MustCompile(`(?i)(https?://)[^/@\s]+@`)
)

type boundedTail struct {
	mu   sync.Mutex
	cap  int
	data []byte
}

func newBoundedTail(capacity int) *boundedTail {
	if capacity > maxDiagnosticBytes {
		capacity = maxDiagnosticBytes
	}
	return &boundedTail{cap: capacity}
}
func (b *boundedTail) Write(p []byte) (int, error) {
	originalLen := len(p)
	p = []byte(sanitizeDiagnostic(string(p)))
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(p) >= b.cap {
		b.data = append(b.data[:0], p[len(p)-b.cap:]...)
	} else {
		drop := len(b.data) + len(p) - b.cap
		if drop > 0 {
			copy(b.data, b.data[drop:])
			b.data = b.data[:len(b.data)-drop]
		}
		b.data = append(b.data, p...)
	}
	return originalLen, nil
}
func sanitizeDiagnostic(raw string) string {
	raw = bearerSecret.ReplaceAllString(raw, "Bearer <redacted>")
	raw = namedSecret.ReplaceAllString(raw, "${1}=<redacted>")
	return urlSecret.ReplaceAllString(raw, "${1}<redacted>@")
}
func (b *boundedTail) String() string {
	b.mu.Lock()
	raw := string(append([]byte(nil), b.data...))
	b.mu.Unlock()
	return sanitizeDiagnostic(raw)
}
func (b *boundedTail) Len() int { b.mu.Lock(); defer b.mu.Unlock(); return len(b.data) }

type backendManager struct {
	cfg      Config
	log      *slog.Logger
	mu       sync.Mutex
	proc     *exec.Cmd
	starting chan struct{}
	startErr error
	closing  bool
}

func (m *backendManager) ready() bool { return m.state() == "running" }
func (m *backendManager) state() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closing {
		return "closing"
	}
	if m.starting != nil {
		return "starting"
	}
	if m.proc != nil {
		return "running"
	}
	return "cold"
}
func (m *backendManager) ensure(ctx context.Context) error {
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return errors.New("shutting down")
	}
	if m.proc != nil && m.starting == nil {
		m.mu.Unlock()
		return nil
	}
	if ch := m.starting; ch != nil {
		m.mu.Unlock()
		select {
		case <-ch:
			m.mu.Lock()
			e := m.startErr
			m.mu.Unlock()
			return e
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	ch := make(chan struct{})
	m.starting = ch
	m.mu.Unlock()
	go func() {
		err := m.start(context.Background())
		m.mu.Lock()
		m.startErr = err
		m.starting = nil
		close(ch)
		m.mu.Unlock()
	}()
	select {
	case <-ch:
		m.mu.Lock()
		e := m.startErr
		m.mu.Unlock()
		return e
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (m *backendManager) start(parent context.Context) error {
	if m.cfg.ModelFile == "" {
		return errors.New("FAMILIAR_MODEL_FILE is required for local mode")
	}
	if _, e := os.Stat(filepath.Join(m.cfg.ModelDir, m.cfg.ModelFile)); e != nil {
		return fmt.Errorf("model is not present in runtime model directory: %w", e)
	}
	host, port, e := net.SplitHostPort(m.cfg.Backend)
	if e != nil {
		return e
	}
	args := []string{"--models-dir", m.cfg.ModelDir, "--jinja", "--host", host, "--port", port, "-ngl", strconv.Itoa(m.cfg.GPULayers), "-c", strconv.Itoa(m.cfg.Context)}
	cmd := exec.Command(m.cfg.LlamaServer, args...)
	// Stdout can include request data. Stderr is retained only in a strict tail;
	// it is emitted, redacted, solely when explicit child debugging is enabled.
	tail := newBoundedTail(m.cfg.DiagnosticBytes)
	cmd.Stdout = io.Discard
	cmd.Stderr = tail
	configureChildProcess(cmd)
	m.mu.Lock()
	closing := m.closing
	m.mu.Unlock()
	if closing {
		return errors.New("shutting down")
	}
	if e = cmd.Start(); e != nil {
		return fmt.Errorf("start llama-server: %w", e)
	}
	m.mu.Lock()
	m.proc = cmd
	m.mu.Unlock()
	go m.wait(cmd, tail)
	deadline := time.NewTimer(m.cfg.StartupTimeout)
	defer deadline.Stop()
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	client := http.Client{Timeout: 500 * time.Millisecond}
	for {
		select {
		case <-parent.Done():
			m.stop(cmd)
			return parent.Err()
		case <-deadline.C:
			m.stop(cmd)
			return context.DeadlineExceeded
		case <-tick.C:
			m.mu.Lock()
			alive := m.proc == cmd
			m.mu.Unlock()
			if !alive {
				return errors.New("llama-server exited during startup")
			}
			resp, e := client.Get("http://" + m.cfg.Backend + "/health")
			if e == nil {
				io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
				if resp.StatusCode >= 200 && resp.StatusCode < 300 {
					m.log.Info("local backend ready")
					return nil
				}
			}
		}
	}
}
func (m *backendManager) wait(cmd *exec.Cmd, tail *boundedTail) {
	_ = cmd.Wait()
	m.mu.Lock()
	if m.proc == cmd {
		m.proc = nil
	}
	closing := m.closing
	m.mu.Unlock()
	if !closing {
		attrs := []any{"status", processExitStatus(cmd.ProcessState)}
		if m.cfg.DebugChild && tail.String() != "" {
			attrs = append(attrs, "stderr_tail", tail.String())
		}
		m.log.Warn("local backend exited", attrs...)
	}
}
func (m *backendManager) stop(cmd *exec.Cmd) { terminateProcessGroup(cmd, false) }
func (m *backendManager) close(ctx context.Context) error {
	m.mu.Lock()
	m.closing = true
	starting := m.starting
	cmd := m.proc
	m.mu.Unlock()
	if cmd != nil {
		m.stop(cmd)
	}
	if starting != nil {
		select {
		case <-starting:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	m.mu.Lock()
	cmd = m.proc
	m.mu.Unlock()
	if cmd == nil {
		return nil
	}
	m.stop(cmd)
	done := make(chan struct{})
	go func() {
		for {
			m.mu.Lock()
			p := m.proc
			m.mu.Unlock()
			if p != cmd {
				close(done)
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		terminateProcessGroup(cmd, true)
		return ctx.Err()
	}
}
