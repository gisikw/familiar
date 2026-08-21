package stt

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
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
	Upstream                           *url.URL
	Model, FFmpeg, Transcribe, TempDir string
	MaxBody, MaxAudio                  int64
	Concurrency                        int
	Deadline                           time.Duration
	Logger                             *slog.Logger
}

type Server struct {
	c            Config
	client       *http.Client
	sem          chan struct{}
	mu           sync.Mutex
	initializing chan struct{}
	initErr      error
	initialized  bool
}

func New(c Config) (*Server, error) {
	if c.MaxBody <= 0 || c.MaxAudio <= 0 || c.MaxAudio > c.MaxBody || c.Concurrency <= 0 || c.Deadline <= 0 {
		return nil, errors.New("invalid limits")
	}
	if c.Upstream == nil && c.Model == "" {
		return nil, errors.New("STT_MODEL is required without STT_UPSTREAM_URL")
	}
	if c.FFmpeg == "" {
		c.FFmpeg = "ffmpeg"
	}
	if c.Transcribe == "" {
		c.Transcribe = "transcribe-cli"
	}
	if c.TempDir == "" {
		c.TempDir = os.TempDir()
	}
	if c.Logger == nil {
		c.Logger = slog.Default()
	}
	return &Server{c: c, client: &http.Client{}, sem: make(chan struct{}, c.Concurrency)}, nil
}

func (s *Server) Handler() http.Handler { return http.HandlerFunc(s.serve) }
func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/health", "/healthz":
		reply(w, 200, map[string]string{"status": "ok"})
		return
	case "/ready", "/readyz":
		reply(w, 200, map[string]string{"status": "ready"})
		return
	case "/v1/audio/transcriptions":
	default:
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		reply(w, 405, map[string]string{"error": "method not allowed"})
		return
	}
	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	default:
		reply(w, 429, map[string]string{"error": "too many transcriptions"})
		return
	}
	if r.ContentLength > s.c.MaxBody {
		reply(w, 413, map[string]string{"error": publicError(413)})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.c.Deadline)
	defer cancel()
	if s.c.Upstream != nil {
		s.proxy(w, r.WithContext(ctx))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.c.MaxBody)
	text, status, err := s.local(ctx, r)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			status = 504
		}
		s.c.Logger.Warn("transcription failed", "status", status, "error", safeError(err))
		reply(w, status, map[string]string{"error": publicError(status)})
		return
	}
	reply(w, 200, map[string]string{"text": text})
}

func (s *Server) initialize(ctx context.Context) error {
	s.mu.Lock()
	if s.initialized {
		s.mu.Unlock()
		return nil
	}
	if ch := s.initializing; ch != nil {
		s.mu.Unlock()
		select {
		case <-ch:
			s.mu.Lock()
			e := s.initErr
			s.mu.Unlock()
			return e
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	ch := make(chan struct{})
	s.initializing = ch
	s.mu.Unlock()
	_, e1 := exec.LookPath(s.c.FFmpeg)
	_, e2 := exec.LookPath(s.c.Transcribe)
	_, e3 := os.Stat(s.c.Model)
	err := e1
	if err == nil {
		err = e2
	}
	if err == nil {
		err = e3
	}
	s.mu.Lock()
	s.initErr = err
	s.initialized = err == nil
	s.initializing = nil
	close(ch)
	s.mu.Unlock()
	return err
}

func (s *Server) local(ctx context.Context, r *http.Request) (string, int, error) {
	if err := s.initialize(ctx); err != nil {
		return "", 503, err
	}
	dir, err := os.MkdirTemp(s.c.TempDir, "familiar-stt-")
	if err != nil {
		return "", 500, err
	}
	defer os.RemoveAll(dir)
	input := filepath.Join(dir, "input")
	if err = receiveAudio(r, input, s.c.MaxAudio); err != nil {
		var mb *http.MaxBytesError
		if errors.As(err, &mb) || errors.Is(err, errAudioLarge) {
			return "", 413, err
		}
		return "", 400, err
	}
	wav, txt := filepath.Join(dir, "audio.wav"), filepath.Join(dir, "result.txt")
	if err = run(ctx, s.c.FFmpeg, "-hide_banner", "-loglevel", "error", "-i", input, "-ar", "16000", "-ac", "1", "-f", "wav", "-y", wav); err != nil {
		return "", 422, err
	}
	if err = run(ctx, s.c.Transcribe, "-m", s.c.Model, "-q", "--timestamps", "none", "-o", txt, wav); err != nil {
		return "", 502, err
	}
	b, err := os.ReadFile(txt)
	if err != nil {
		return "", 502, err
	}
	return strings.TrimSpace(string(b)), 200, nil
}

var errAudioLarge = errors.New("audio exceeds limit")

func receiveAudio(r *http.Request, dst string, max int64) error {
	var src io.Reader = r.Body
	var mr *multipart.Reader
	ct := r.Header.Get("Content-Type")
	mt, p, err := mime.ParseMediaType(ct)
	if strings.HasPrefix(strings.ToLower(ct), "multipart/") {
		if err != nil || mt != "multipart/form-data" || p["boundary"] == "" {
			return errors.New("malformed multipart content type")
		}
		mr = multipart.NewReader(r.Body, p["boundary"])
		for {
			part, e := mr.NextPart()
			if e == io.EOF {
				break
			}
			if e != nil {
				return e
			}
			if part.FormName() == "file" {
				src = part
				break
			}
			part.Close()
		}
		if src == r.Body {
			return errors.New("missing file field")
		}
	}
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	n, copyErr := io.Copy(f, io.LimitReader(src, max+1))
	closeErr := f.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if n == 0 {
		return errors.New("empty audio")
	}
	if n > max {
		return errAudioLarge
	}
	// Consume the remaining multipart framing/parts so the complete-body bound is enforced.
	if mr != nil {
		for {
			part, e := mr.NextPart()
			if e == io.EOF {
				break
			}
			if e != nil {
				return e
			}
			if _, e = io.Copy(io.Discard, part); e != nil {
				return e
			}
			part.Close()
		}
	}
	return nil
}

func run(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.WaitDelay = 2 * time.Second
	out, err := cmd.CombinedOutput()
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("backend command failed: %w: %.512s", err, out)
	}
	return nil
}

var hop = map[string]bool{"connection": true, "proxy-connection": true, "keep-alive": true, "proxy-authenticate": true, "proxy-authorization": true, "te": true, "trailer": true, "transfer-encoding": true, "upgrade": true}

func copyHeaders(dst, src http.Header) {
	blocked := make(map[string]bool, len(hop))
	for k, v := range hop {
		blocked[k] = v
	}
	for _, line := range src.Values("Connection") {
		for _, name := range strings.Split(line, ",") {
			blocked[strings.ToLower(strings.TrimSpace(name))] = true
		}
	}
	for k, v := range src {
		if !blocked[strings.ToLower(k)] {
			for _, x := range v {
				dst.Add(k, x)
			}
		}
	}
}
func (s *Server) proxy(w http.ResponseWriter, r *http.Request) {
	u := *s.c.Upstream
	u.Path = strings.TrimRight(u.Path, "/") + r.URL.Path
	u.RawQuery = r.URL.RawQuery
	body := http.MaxBytesReader(w, r.Body, s.c.MaxBody)
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, u.String(), body)
	if err != nil {
		reply(w, 500, map[string]string{"error": "proxy request failed"})
		return
	}
	copyHeaders(req.Header, r.Header)
	req.Host = u.Host
	resp, err := s.client.Do(req)
	if err != nil {
		status := 502
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(r.Context().Err(), context.DeadlineExceeded) {
			status = 504
		}
		reply(w, status, map[string]string{"error": publicError(status)})
		return
	}
	defer resp.Body.Close()
	copyHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}
func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func publicError(status int) string {
	switch status {
	case 400:
		return "invalid request"
	case 413:
		return "request too large"
	case 422:
		return "invalid audio"
	case 429:
		return "too many transcriptions"
	case 503:
		return "local backend unavailable"
	case 504:
		return "transcription timed out"
	default:
		return "transcription failed"
	}
}
func safeError(e error) string {
	if errors.Is(e, context.DeadlineExceeded) {
		return "deadline exceeded"
	}
	if errors.Is(e, errAudioLarge) {
		return "audio exceeds limit"
	}
	return "backend/request error (details suppressed)"
}
