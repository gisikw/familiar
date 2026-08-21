package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"familiar-stt/internal/stt"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	cfg := stt.Config{Model: os.Getenv("STT_MODEL"), FFmpeg: env("STT_FFMPEG", "ffmpeg"), Transcribe: env("STT_TRANSCRIBE_CLI", "transcribe-cli"), TempDir: env("STT_TEMP_DIR", os.TempDir()), MaxBody: int64(num("STT_MAX_BODY_BYTES", 32<<20)), MaxAudio: int64(num("STT_MAX_AUDIO_BYTES", 24<<20)), Concurrency: num("STT_CONCURRENCY", 2), Deadline: time.Duration(num("STT_DEADLINE_SECONDS", 120)) * time.Second, Logger: log}
	if raw := os.Getenv("STT_UPSTREAM_URL"); raw != "" {
		u, e := url.Parse(raw)
		if e != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			log.Error("invalid STT_UPSTREAM_URL")
			os.Exit(2)
		}
		cfg.Upstream = u
	}
	s, e := stt.New(cfg)
	if e != nil {
		log.Error("invalid configuration", "error", e.Error())
		os.Exit(2)
	}
	addr := env("STT_LISTEN", "127.0.0.1:9932")
	// ReadTimeout is slightly longer than the end-to-end transcription deadline:
	// legitimate requests get their full configured budget, while slow readers
	// cannot retain a connection indefinitely.
	h := &http.Server{Addr: addr, Handler: s.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: cfg.Deadline + 10*time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 1 << 20}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = h.Shutdown(c)
	}()
	log.Info("listening", "address", addr, "mode", map[bool]string{true: "upstream", false: "local"}[cfg.Upstream != nil])
	if e = h.ListenAndServe(); e != nil && !errors.Is(e, http.ErrServerClosed) {
		log.Error("server failed", "error", e.Error())
		os.Exit(1)
	}
}
func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func num(k string, d int) int {
	v := os.Getenv(k)
	if v == "" {
		return d
	}
	n, e := strconv.Atoi(v)
	if e != nil || n <= 0 {
		slog.Error("invalid positive integer", "variable", k)
		os.Exit(2)
	}
	return n
}
