package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	llm "familiar.dev/llm"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	cfg, err := llm.ConfigFromEnv()
	if err != nil {
		log.Error("invalid configuration", "error", err)
		os.Exit(2)
	}
	svc, err := llm.New(cfg, log)
	if err != nil {
		log.Error("invalid configuration", "error", err)
		os.Exit(2)
	}
	httpServer := &http.Server{Addr: cfg.Listen, Handler: svc.Handler(), ReadHeaderTimeout: 10e9, IdleTimeout: 120e9}
	sig, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	errCh := make(chan error, 1)
	go func() { errCh <- httpServer.ListenAndServe() }()
	log.Info("Familiar LLM proxy listening", "address", cfg.Listen, "mode", map[bool]string{true: "upstream", false: "local"}[cfg.Upstream != ""])
	select {
	case <-sig.Done():
		stop, done := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer done()
		_ = httpServer.Shutdown(stop)
		_ = svc.Close(stop)
	case err = <-errCh:
		_ = svc.Close(context.Background())
		if err != nil && err != http.ErrServerClosed {
			log.Error("server failed", "error", err)
			os.Exit(1)
		}
	}
}
