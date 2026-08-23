package main

import (
	"context"
	"encoding/json"
	"familiar.dev/agents/client"
	piadapter "familiar.dev/agents/harnesses/pi"
	"familiar.dev/agents/supervisor"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func secondsEnv(k string, fallback time.Duration) time.Duration {
	v := os.Getenv(k)
	if v == "" {
		return fallback
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n < 0 {
		slog.Error("seconds environment must be a non-negative integer", "key", k)
		os.Exit(2)
	}
	return time.Duration(n) * time.Second
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
	artifactRoot := flag.String("artifact-root", env("FAMILIAR_AGENTS_ARTIFACT_ROOT", ""), "host-local artifact root (default: STATE/artifacts)")
	allowedRoots := flag.String("allowed-cwd-roots", env("FAMILIAR_AGENTS_ALLOWED_CWD_ROOTS", home), "allowed CWD roots separated by the OS path-list separator")
	interval := flag.Duration("poll", 5*time.Second, "reconcile interval")
	offline := flag.Duration("offline-restart-window", 30*time.Minute, "maximum disconnected recreation window")
	linger := flag.Duration("linger", secondsEnv("FAMILIAR_AGENTS_LINGER_SECONDS", time.Hour), "settled worker tmux retention")
	pi := flag.String("pi", env("FAMILIAR_AGENTS_PI", "pi"), "pi executable")
	flag.Parse()
	if *host == "" || *offline < 0 || *linger < 0 || *allowedRoots == "" {
		slog.Error("invalid supervisor configuration")
		os.Exit(2)
	}
	if *artifactRoot == "" {
		*artifactRoot = filepath.Join(*state, "artifacts")
	}
	roots := strings.Split(*allowedRoots, string(os.PathListSeparator))
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
	workerEnv := map[string]string{}
	for _, key := range []string{"FAMILIAR_TIAMAT_URL", "FAMILIAR_TIAMAT_TOKEN_FILE", "FAMILIAR_TIAMAT_POLL_SECONDS", "FAMILIAR_TIAMAT_DISPLAY_TZ"} {
		if value := os.Getenv(key); value != "" {
			workerEnv[key] = value
		}
	}
	piAdapter := piadapter.Adapter{Binary: *pi, Extension: os.Getenv("FAMILIAR_AGENTS_TIAMAT_EXTENSION"), Env: workerEnv}
	s := &supervisor.Supervisor{Host: *host, Client: client.New(*endpoint), Registry: reg, Tmux: tm, OfflineWindow: *offline, Linger: *linger, ArtifactRoot: *artifactRoot, AllowedCWDRoots: roots, Adapters: supervisor.ConfiguredAdapters(piAdapter, argvEnv("FAMILIAR_AGENTS_CLAUDE_ARGV", []string{"claude", "{prompt}"}), argvEnv("FAMILIAR_AGENTS_CODEX_ARGV", []string{"codex", "{prompt}"}))}
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
