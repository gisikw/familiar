package main

import (
	"context"
	"familiar.dev/agents/client"
	"familiar.dev/agents/supervisor"
	"flag"
	"log"
	"os"
	"os/signal"
	"path/filepath"
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
func split(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Fields(s)
}
func main() {
	host, _ := os.Hostname()
	endpoint := flag.String("service", env("FAMILIAR_AGENTS_ENDPOINT", "http://127.0.0.1:7337"), "service URL or unix:///path")
	h := flag.String("host", env("FAMILIAR_AGENTS_HOST", host), "explicit host identity")
	state := flag.String("state", env("FAMILIAR_AGENTS_SUPERVISOR_STATE", ".agents-supervisor"), "private state directory")
	interval := flag.Duration("poll", 5*time.Second, "reconciliation interval")
	offline := flag.Duration("offline-restart-window", 30*time.Minute, "maximum disconnected recreation age")
	pi := flag.String("pi", env("FAMILIAR_AGENTS_PI", "pi"), "pi executable")
	cl := flag.String("claude-argv", env("FAMILIAR_AGENTS_CLAUDE_ARGV", ""), "minimal adapter argv template")
	co := flag.String("codex-argv", env("FAMILIAR_AGENTS_CODEX_ARGV", ""), "minimal adapter argv template")
	flag.Parse()
	abs, e := filepath.Abs(*state)
	if e != nil {
		log.Fatal(e)
	}
	r, e := supervisor.OpenRegistry(filepath.Join(abs, "workers.json"))
	if e != nil {
		log.Fatal(e)
	}
	tm := supervisor.Tmux{Binary: "tmux", Socket: filepath.Join(abs, "tmux.sock"), Config: filepath.Join(abs, "tmux.conf")}
	if e = tm.Prepare(); e != nil {
		log.Fatal(e)
	}
	s := supervisor.Supervisor{Host: *h, Client: client.New(*endpoint), Registry: r, Tmux: tm, OfflineWindow: *offline, Adapters: supervisor.DefaultAdapters(*pi, split(*cl), split(*co))}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	s.Recover(ctx)
	tick := time.NewTicker(*interval)
	defer tick.Stop()
	for {
		if e = s.Tick(ctx); e != nil {
			log.Printf("component=agent-supervisor event=reconcile_error error=%q", e)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}
