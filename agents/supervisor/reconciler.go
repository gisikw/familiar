package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"familiar.dev/agents/client"
	"familiar.dev/agents/harnesses"
	"familiar.dev/agents/harnesses/claude"
	"familiar.dev/agents/harnesses/codex"
	piadapter "familiar.dev/agents/harnesses/pi"
	"familiar.dev/agents/protocol"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

type ActionKind string

const (
	Start  ActionKind = "start"
	Cancel ActionKind = "cancel"
)

type Action struct {
	Kind       ActionKind
	Assignment protocol.Assignment
}

func Diff(desired []protocol.Assignment, local map[string]Worker) []Action {
	a := []Action{}
	for _, d := range desired {
		w, ok := local[d.Job.ID]
		if !ok && !d.Job.CancelRequested && d.DesiredState != protocol.Cancelling {
			a = append(a, Action{Start, d})
		} else if ok && (d.Job.CancelRequested || d.DesiredState == protocol.Cancelling) {
			_ = w
			a = append(a, Action{Cancel, d})
		}
	}
	return a
}

type Supervisor struct {
	Host          string
	Client        *client.Client
	Registry      *Registry
	Tmux          Tmux
	OfflineWindow time.Duration
	Adapters      map[string]harnesses.Adapter
}

func (s *Supervisor) adapter(kind string) (harnesses.Adapter, error) {
	a, ok := s.Adapters[kind]
	if !ok {
		return nil, fmt.Errorf("unknown harness %q", kind)
	}
	return a, nil
}
func DefaultAdapters(pi string, claudeArgv, codexArgv []string) map[string]harnesses.Adapter {
	return map[string]harnesses.Adapter{"pi": piadapter.Adapter{Binary: pi}, "claude": claude.Adapter{ArgvTemplate: claudeArgv}, "codex": codex.Adapter{ArgvTemplate: codexArgv}, "fake": claude.Adapter{ArgvTemplate: []string{"sh", "-c", "printf 'fake worker complete\\n'; sleep 1"}}}
}
func (s *Supervisor) Recover(ctx context.Context) {
	for _, w := range s.Registry.Snapshot() {
		if s.Tmux.Has(ctx, w.Session) {
			continue
		}
		if time.Now().Before(w.RestartUntil) {
			session, target, e := s.Tmux.Start(ctx, w.Job.ID, w.Launch)
			if e == nil {
				w.Session = session
				w.Target = target
				w.StartedAt = time.Now().UTC()
				s.Registry.Put(w)
				log.Printf("component=agent-supervisor event=offline_recreate job=%s", w.Job.ID)
			} else {
				log.Printf("component=agent-supervisor event=recover_failed job=%s error=%q", w.Job.ID, e)
			}
		} else {
			log.Printf("component=agent-supervisor event=offline_window_expired job=%s", w.Job.ID)
		}
	}
}
func (s *Supervisor) Tick(ctx context.Context) error {
	known := map[string]protocol.State{}
	for id, w := range s.Registry.Snapshot() {
		known[id] = w.LastState
	}
	p, e := s.Client.Poll(ctx, s.Host, known)
	if e != nil {
		return e
	}
	for _, a := range Diff(p.Assignments, s.Registry.Snapshot()) {
		switch a.Kind {
		case Start:
			if e = s.start(ctx, a.Assignment.Job); e != nil {
				log.Printf("component=agent-supervisor event=start_failed job=%s error=%q", a.Assignment.Job.ID, e)
			}
		case Cancel:
			s.cancel(ctx, a.Assignment.Job.ID)
		}
	}
	return s.observe(ctx)
}
func (s *Supervisor) start(ctx context.Context, j protocol.Job) error {
	if j.Artifacts.Directory == "" {
		return errors.New("service must assign artifact directory")
	}
	if j.Isolation == protocol.IsolationWorktree {
		wt := filepath.Join(j.Artifacts.Directory, "worktree")
		base := "HEAD"
		if base == "" {
			base = "HEAD"
		}
		if o, e := exec.CommandContext(ctx, "git", "-C", j.CWD, "worktree", "add", "--detach", wt, base).CombinedOutput(); e != nil {
			return fmt.Errorf("git worktree: %s: %w", o, e)
		}
		j.CWD = wt
	}
	a, e := s.adapter(string(j.Harness))
	if e != nil {
		return e
	}
	l, e := a.Start(ctx, j)
	if e != nil {
		return e
	}
	session, target, e := s.Tmux.Start(ctx, j.ID, l)
	if e != nil {
		return e
	}
	w := Worker{Job: j, Launch: l, Session: session, Target: target, Worktree: func() string {
		if j.Isolation == protocol.IsolationWorktree {
			return j.CWD
		}
		return ""
	}(), RestartUntil: time.Now().Add(s.OfflineWindow), LastState: protocol.Starting, StartedAt: time.Now().UTC()}
	if e = s.Registry.Put(w); e != nil {
		return e
	}
	endpoint := &protocol.TerminalEndpoint{Host: s.Host, Socket: s.Tmux.Socket, Target: target}
	events := []protocol.ObservedEvent{{ID: j.ID + "-starting", JobID: j.ID, State: protocol.Starting, Terminal: endpoint}, {ID: j.ID + "-running", JobID: j.ID, State: protocol.Running}}
	if e = s.Client.Events(ctx, protocol.EventBatch{Host: s.Host, Events: events}); e == nil {
		w.LastState = protocol.Running
		s.Registry.Put(w)
	}
	return e
}
func (s *Supervisor) cancel(ctx context.Context, id string) {
	w, ok := s.Registry.Snapshot()[id]
	if !ok {
		return
	}
	s.Tmux.Kill(ctx, w.Session)
	set := protocol.Settlement{ID: id + "-cancelled", JobID: id, Verdict: protocol.Cancelled, Summary: "cancelled by requested state", At: time.Now().UTC()}
	e := s.Client.Events(ctx, protocol.EventBatch{Host: s.Host, Events: []protocol.ObservedEvent{{ID: id + "-cancel-settlement", JobID: id, Settlement: &set}}})
	if e == nil {
		s.Registry.Delete(id)
	}
}
func (s *Supervisor) observe(ctx context.Context) error {
	for id, w := range s.Registry.Snapshot() {
		alive, code, e := s.Tmux.Pane(ctx, w.Target)
		if alive {
			continue
		}
		if e != nil && s.Tmux.ServerAlive(ctx) {
			continue
		}
		a, x := s.adapter(string(w.Job.Harness))
		if x != nil {
			return x
		}
		n := 1
		if code != nil {
			n = *code
		}
		o := harnesses.Observation{State: protocol.Failed, ExitCode: &n}
		set, x := a.CollectSettlement(ctx, w.Job, w.Launch, o)
		if x != nil {
			return x
		}
		if e != nil {
			set.Verdict = protocol.Failed
			d, _ := json.Marshal(map[string]string{"failure_boundary": "private tmux server unavailable"})
			set.Detail = d
		}
		batch := protocol.EventBatch{Host: s.Host, Events: []protocol.ObservedEvent{{ID: id + "-settlement", JobID: id, Settlement: set}}}
		if x = s.Client.Events(ctx, batch); x != nil {
			return x
		}
		s.Registry.Delete(id)
	}
	return nil
}
func GC(root string, before time.Time) error {
	es, e := os.ReadDir(root)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	for _, x := range es {
		p := filepath.Join(root, x.Name())
		i, e := x.Info()
		if e == nil && i.ModTime().Before(before) {
			os.RemoveAll(p)
		}
	}
	return nil
}
