package main

import (
	"context"
	"encoding/json"
	"familiar.dev/agents/client"
	"familiar.dev/agents/protocol"
	"familiar.dev/agents/supervisor"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var jsonOut bool

func fatal(e error) { fmt.Fprintln(os.Stderr, "familiar-agents:", e); os.Exit(1) }
func print(v any) {
	if jsonOut {
		json.NewEncoder(os.Stdout).Encode(v)
		return
	}
	switch x := v.(type) {
	case protocol.Job:
		fmt.Printf("%s  %-11s %-8s host=%s\n", x.ID, x.State, x.Harness, x.Host)
	case []protocol.Job:
		for _, j := range x {
			print(j)
		}
	default:
		fmt.Println(v)
	}
}
func main() {
	root := flag.NewFlagSet("familiar-agents", flag.ExitOnError)
	endpoint := root.String("service", env("FAMILIAR_AGENTS_ENDPOINT", "http://127.0.0.1:7337"), "service URL or unix:///path")
	root.BoolVar(&jsonOut, "json", false, "JSON output")
	root.Parse(os.Args[1:])
	args := root.Args()
	if len(args) == 0 {
		fatal(fmt.Errorf("usage: familiar-agents [--service URL] [--json] {dispatch|status|list|attach-hint|cancel|answer|gc}"))
	}
	ctx := context.Background()
	c := client.New(*endpoint)
	switch args[0] {
	case "dispatch":
		f := flag.NewFlagSet("dispatch", flag.ExitOnError)
		host := f.String("host", "", "worker host")
		h := f.String("harness", "pi", "pi|claude|codex|fake")
		model := f.String("model", "", "model")
		cwd := f.String("cwd", ".", "working directory")
		key := f.String("key", fmt.Sprintf("cli-%d", time.Now().UnixNano()), "idempotency key")
		worktree := f.Bool("worktree", false, "use detached git worktree")
		f.Parse(args[1:])
		if *host == "" || f.NArg() == 0 {
			fatal(fmt.Errorf("dispatch requires --host and prompt"))
		}
		abs, e := filepath.Abs(*cwd)
		if e != nil {
			fatal(e)
		}
		iso := protocol.IsolationNone
		if *worktree {
			iso = protocol.IsolationWorktree
		}
		j, e := c.Create(ctx, protocol.CreateJob{IdempotencyKey: *key, Harness: protocol.HarnessKind(*h), Model: *model, CWD: abs, Isolation: iso, Prompt: strings.Join(f.Args(), " "), Host: *host})
		if e != nil {
			fatal(e)
		}
		print(j)
	case "status":
		need(args, 2)
		j, e := c.Get(ctx, args[1])
		if e != nil {
			fatal(e)
		}
		print(j)
	case "list":
		f := flag.NewFlagSet("list", flag.ExitOnError)
		state := f.String("state", "", "lifecycle state")
		f.Parse(args[1:])
		j, e := c.List(ctx, protocol.State(*state))
		if e != nil {
			fatal(e)
		}
		print(j)
	case "cancel":
		need(args, 2)
		j, e := c.Cancel(ctx, args[1])
		if e != nil {
			fatal(e)
		}
		print(j)
	case "answer":
		need(args, 3)
		j, e := c.Get(ctx, args[1])
		if e != nil {
			fatal(e)
		}
		qid := ""
		if j.Question != nil {
			qid = j.Question.ID
		}
		j, e = c.Answer(ctx, args[1], protocol.Answer{IdempotencyKey: fmt.Sprintf("cli-%d", time.Now().UnixNano()), QuestionID: qid, Text: strings.Join(args[2:], " ")})
		if e != nil {
			fatal(e)
		}
		print(j)
	case "attach-hint":
		need(args, 2)
		j, e := c.Get(ctx, args[1])
		if e != nil {
			fatal(e)
		}
		if j.Terminal == nil {
			fatal(fmt.Errorf("terminal endpoint not yet published"))
		}
		if jsonOut {
			print(j.Terminal)
		} else {
			fmt.Printf("host=%s tmux -S %q attach-session -t %q\n", j.Terminal.Host, j.Terminal.Socket, j.Terminal.Target)
		}
	case "gc":
		f := flag.NewFlagSet("gc", flag.ExitOnError)
		root := f.String("root", "artifacts", "artifact root")
		age := f.Duration("older-than", 30*24*time.Hour, "minimum age")
		f.Parse(args[1:])
		if e := supervisor.GC(*root, time.Now().Add(-*age)); e != nil {
			fatal(e)
		}
	default:
		fatal(fmt.Errorf("unknown command %q", args[0]))
	}
}
func need(a []string, n int) {
	if len(a) < n {
		fatal(fmt.Errorf("missing argument"))
	}
}
func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
