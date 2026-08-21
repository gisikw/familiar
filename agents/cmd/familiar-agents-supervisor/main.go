package main

import (
	"context"
	"encoding/json"
	"familiar.dev/agents/client"
	"familiar.dev/agents/supervisor"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func argvEnv(k string, fallback []string) []string {
	v := os.Getenv(k)
	if v == "" {
		return fallback
	}
	var out []string
	if json.Unmarshal([]byte(v), &out) != nil {
		slog.Error("argv environment must be JSON array", "key", k)
		os.Exit(2)
	}
	return out
}
func main() {
	home, _ := os.UserHomeDir()
	stateDefault := filepath.Join(home, ".local", "state", "familiar", "agents-supervisor")
	host := flag.String("host", env("FAMILIAR_AGENTS_HOST", "local"), "explicit worker host name")
	endpoint := flag.String("service", env("FAMILIAR_AGENTS_ENDPOINT", "http://127.0.0.1:7337"), "service HTTP URL or unix://path")
	state := flag.String("state", env("FAMILIAR_AGENTS_SUPERVISOR_STATE", stateDefault), "local durable state directory")
	interval := flag.Duration("poll", 5*time.Second, "reconcile interval")
	offline := flag.Duration("offline-restart-window", 30*time.Minute, "maximum disconnected recreation window")
	pi := flag.String("pi", env("FAMILIAR_AGENTS_PI", "pi"), "pi executable")
	flag.Parse()
	if *host == "" || *offline < 0 {
		slog.Error("invalid supervisor configuration")
		os.Exit(2)
	}
	if err := os.MkdirAll(*state, 0700); err != nil {
		slog.Error("state directory", "error", err)
		os.Exit(1)
	}
	reg, err := supervisor.OpenRegistry(filepath.Join(*state, "workers.json"))
	if err != nil {
		slog.Error("registry", "error", err)
		os.Exit(1)
	}
	tm := supervisor.Tmux{Socket: filepath.Join(*state, "tmux.sock"), Config: filepath.Join(*state, "tmux.conf")}
	if err = tm.Prepare(); err != nil {
		slog.Error("tmux prepare", "error", err)
		os.Exit(1)
	}
	s := &supervisor.Supervisor{Host: *host, Client: client.New(*endpoint), Registry: reg, Tmux: tm, OfflineWindow: *offline, Adapters: supervisor.DefaultAdapters(*pi, argvEnv("FAMILIAR_AGENTS_CLAUDE_ARGV", []string{"claude", "{prompt}"}), argvEnv("FAMILIAR_AGENTS_CODEX_ARGV", []string{"codex", "{prompt}"}))}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	// Reconcile with global truth before any reboot recreation. Only when the
	// service is unavailable may the bounded offline policy authorize recovery.
	if err = s.Tick(ctx); err != nil {
		slog.Warn("initial reconcile unavailable; applying offline policy", "error", err)
		s.Recover(ctx)
	}
	ticker := time.NewTicker(*interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if err = s.Tick(ctx); err != nil && ctx.Err() == nil {
			slog.Warn("reconcile failed; workers preserved", "error", err)
		}
	}
}
