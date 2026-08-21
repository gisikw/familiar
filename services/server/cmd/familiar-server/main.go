package main

import (
	"context"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	server "familiar.dev/server"
)

func main() {
	configDefault := os.Getenv("FAMILIAR_SERVER_CONFIG")
	listenDefault := os.Getenv("FAMILIAR_SERVER_LISTEN")
	var configPath, listen string
	flag.StringVar(&configPath, "config", configDefault, "supervisor TOML file (or FAMILIAR_SERVER_CONFIG)")
	flag.StringVar(&listen, "listen", listenDefault, "override loopback listen address (or FAMILIAR_SERVER_LISTEN)")
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	cfg, err := server.LoadConfig(configPath)
	if err != nil {
		log.Error("invalid configuration", "error", err)
		os.Exit(2)
	}
	if listen != "" {
		cfg.Listen = listen
		if err = server.ValidateConfig(cfg); err != nil {
			log.Error("invalid listen override", "error", err)
			os.Exit(2)
		}
	}
	sup, err := server.New(cfg, log)
	if err != nil {
		log.Error("supervisor initialization failed", "error", err)
		os.Exit(2)
	}
	sup.Start()
	httpServer := &http.Server{Addr: cfg.Listen, Handler: sup.Handler(), ReadHeaderTimeout: cfg.ReadHeaderTimeout.Value(), IdleTimeout: 2 * cfg.ReadHeaderTimeout.Value()}
	errCh := make(chan error, 1)
	go func() { errCh <- httpServer.ListenAndServe() }()
	log.Info("Familiar Server listening", "address", cfg.Listen, "children", len(cfg.Children))
	sig, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	select {
	case <-sig.Done():
	case err = <-errCh:
		if err != nil && err != http.ErrServerClosed {
			log.Error("HTTP server failed", "error", err)
		}
	}
	ctx, done := context.WithTimeout(context.Background(), cfg.ShutdownGrace.Value()*time.Duration(len(cfg.Children)+1))
	defer done()
	_ = httpServer.Shutdown(ctx)
	if closeErr := sup.Close(ctx); closeErr != nil {
		log.Error("supervisor shutdown incomplete", "error", closeErr)
		os.Exit(1)
	}
	if err != nil && err != http.ErrServerClosed {
		os.Exit(1)
	}
}
