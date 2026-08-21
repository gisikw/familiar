package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"familiar.dev/agents/client"
	"familiar.dev/agents/harnesses"
	"familiar.dev/agents/harnesses/claude"
	"familiar.dev/agents/harnesses/codex"
	piadapter "familiar.dev/agents/harnesses/pi"
	"familiar.dev/agents/protocol"
)

type ActionKind string

const (
	Start  ActionKind = "start"
	Cancel ActionKind = "cancel"
	Forget ActionKind = "forget"
)

type Action struct {
	Kind       ActionKind
	Assignment protocol.Assignment
	JobID      string
}

// Diff is pure so reconciliation behavior can be tested without processes.
func Diff(desired []protocol.Assignment, local map[string]Worker) []Action {
	out := []Action{}
	seen := map[string]bool{}
	for _, d := range desired {
		seen[d.Job.ID] = true
		_, ok := local[d.Job.ID]
		if !ok && !d.Job.CancelRequested && d.DesiredState != protocol.Cancelling {
			out = append(out, Action{Kind: Start, Assignment: d, JobID: d.Job.ID})
		} else if ok && (d.Job.CancelRequested || d.DesiredState == protocol.Cancelling) {
			out = append(out, Action{Kind: Cancel, Assignment: d, JobID: d.Job.ID})
		}
	}
	for id := range local {
		if !seen[id] {
			out = append(out, Action{Kind: Forget, JobID: id})
		}
	}
	return out
}

type Supervisor struct {
	Host          string
	Client        *client.Client
	Registry      *Registry
	Tmux          Tmux
	OfflineWindow time.Duration
	Adapters      map[string]harnesses.Adapter
	Logger        *slog.Logger
}

func (s *Supervisor) log() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}
func (s *Supervisor) adapter(kind protocol.HarnessKind) (harnesses.Adapter, error) {
	a, ok := s.Adapters[string(kind)]
	if !ok {
		return nil, fmt.Errorf("unknown harness %q", kind)
	}
	return a, nil
}
func DefaultAdapters(piBinary string, claudeArgv, codexArgv []string) map[string]harnesses.Adapter {
	return map[string]harnesses.Adapter{"pi": piadapter.Adapter{Binary: piBinary}, "claude": claude.Adapter{ArgvTemplate: claudeArgv}, "codex": codex.Adapter{ArgvTemplate: codexArgv}, "fake": claude.Adapter{ArgvTemplate: []string{"sh", "-c", "printf '%s\\n' fake-worker-complete; sleep 1"}}}
}

// Recover adopts surviving sessions. Only pi (currently the only resumable
// adapter) is recreated while disconnected, and never after RestartUntil.
func (s *Supervisor) Recover(ctx context.Context) {
	for id, w := range s.Registry.Snapshot() {
		if s.Tmux.Has(ctx, w.Session) {
			continue
		}
		if time.Now().After(w.RestartUntil) {
			s.log().Warn("offline restart window expired", "job", id)
			continue
		}
		a, err := s.adapter(w.Job.Harness)
		if err != nil {
			continue
		}
		launch, err := a.Resume(ctx, w.Job, w.Launch)
		if err != nil {
			s.log().Warn("worker cannot resume offline", "job", id, "error", err)
			continue
		}
		session, target, err := s.Tmux.Start(ctx, id, launch)
		if err != nil {
			s.log().Error("offline recreate failed", "job", id, "error", err)
			continue
		}
		w.Launch, w.Session, w.Target, w.StartedAt = launch, session, target, time.Now().UTC()
		_ = s.Registry.Put(w)
		s.log().Info("worker resumed offline", "job", id)
	}
}

func (s *Supervisor) Tick(ctx context.Context) error {
	known := map[string]protocol.State{}
	for id, w := range s.Registry.Snapshot() {
		known[id] = w.LastState
	}
	poll, err := s.Client.Poll(ctx, s.Host, known)
	if err != nil {
		return err
	} // existing workers are untouched
	for _, a := range Diff(poll.Assignments, s.Registry.Snapshot()) {
		switch a.Kind {
		case Start:
			if err = s.start(ctx, a.Assignment.Job); err != nil {
				s.log().Error("start failed", "job", a.JobID, "error", err)
			}
		case Cancel:
			s.cancel(ctx, a.JobID)
		case Forget:
			s.forget(ctx, a.JobID)
		}
	}
	// Deliver answered blocked questions after assignment reconciliation.
	for _, d := range poll.Assignments {
		w, ok := s.Registry.Snapshot()[d.Job.ID]
		if !ok || d.Job.Question == nil || d.Job.Question.Answer == nil || w.AnsweredKey == d.Job.Question.Answer.IdempotencyKey {
			continue
		}
		adapter, e := s.adapter(w.Job.Harness)
		if e != nil {
			continue
		}
		runtime := s.runtime(w)
		if e = adapter.Answer(ctx, &runtime, *d.Job.Question.Answer); e == nil {
			w.AnsweredKey = d.Job.Question.Answer.IdempotencyKey
			_ = s.Registry.Put(w)
		} else if !errors.Is(e, harnesses.ErrUnsupported) {
			s.log().Warn("answer delivery failed", "job", w.Job.ID, "error", e)
		}
	}
	return s.observe(ctx)
}
func (s *Supervisor) start(ctx context.Context, j protocol.Job) error {
	if j.Artifacts.Directory == "" {
		return errors.New("service did not assign artifact directory")
	}
	if err := os.MkdirAll(j.Artifacts.Directory, 0o700); err != nil {
		return err
	}
	worktree := ""
	if j.Isolation == protocol.IsolationWorktree {
		worktree = filepath.Join(j.Artifacts.Directory, "worktree")
		if out, err := exec.CommandContext(ctx, "git", "-C", j.CWD, "worktree", "add", "--detach", worktree, "HEAD").CombinedOutput(); err != nil {
			return fmt.Errorf("git worktree: %s: %w", out, err)
		}
		j.CWD = worktree
	}
	a, err := s.adapter(j.Harness)
	if err != nil {
		return err
	}
	launch, err := a.Start(ctx, j)
	if err != nil {
		return err
	}
	session, target, err := s.Tmux.Start(ctx, j.ID, launch)
	if err != nil {
		return err
	}
	w := Worker{Job: j, Launch: launch, Session: session, Target: target, Worktree: worktree, RestartUntil: time.Now().Add(s.OfflineWindow), LastState: protocol.Starting, StartedAt: time.Now().UTC()}
	if err = s.Registry.Put(w); err != nil {
		return err
	}
	return s.publishState(ctx, &w, protocol.Starting)
}
func (s *Supervisor) publishState(ctx context.Context, w *Worker, state protocol.State) error {
	event := protocol.ObservedEvent{ID: w.Job.ID + "-" + string(state), JobID: w.Job.ID, State: state, ObservedAt: time.Now().UTC()}
	if state == protocol.Starting || state == protocol.Running {
		event.Terminal = &protocol.TerminalEndpoint{Host: s.Host, Socket: s.Tmux.Socket, Target: w.Target}
	}
	if err := s.Client.Events(ctx, protocol.EventBatch{Host: s.Host, Events: []protocol.ObservedEvent{event}}); err != nil {
		return err
	}
	w.LastState = state
	return s.Registry.Put(*w)
}
func (s *Supervisor) runtime(w Worker) harnesses.Runtime {
	return harnesses.Runtime{Launch: w.Launch, SendText: func(ctx context.Context, text string) error { return s.Tmux.Send(ctx, w.Target, text) }, Cancel: func(ctx context.Context) error { return s.Tmux.Kill(ctx, w.Session) }, Alive: func(ctx context.Context) (bool, *int, error) { return s.Tmux.Pane(ctx, w.Target) }}
}
func (s *Supervisor) cancel(ctx context.Context, id string) {
	w, ok := s.Registry.Snapshot()[id]
	if !ok {
		return
	}
	_ = s.Tmux.Kill(ctx, w.Session)
	set := protocol.Settlement{ID: id + "-cancelled", JobID: id, Verdict: protocol.Cancelled, Summary: "cancelled by requested state", At: time.Now().UTC()}
	if err := s.Client.Events(ctx, protocol.EventBatch{Host: s.Host, Events: []protocol.ObservedEvent{{ID: id + "-cancel-settlement", JobID: id, Settlement: &set}}}); err == nil {
		_ = s.Registry.Delete(id)
	}
}
func (s *Supervisor) forget(ctx context.Context, id string) {
	if w, ok := s.Registry.Snapshot()[id]; ok {
		_ = s.Tmux.Kill(ctx, w.Session)
		_ = s.Registry.Delete(id)
	}
}
func (s *Supervisor) observe(ctx context.Context) error {
	for id, w := range s.Registry.Snapshot() {
		a, err := s.adapter(w.Job.Harness)
		if err != nil {
			return err
		}
		runtime := s.runtime(w)
		obs, observeErr := a.Observe(ctx, w.Job, &runtime)
		if observeErr == nil && obs.State == protocol.Running {
			if w.LastState == protocol.Starting {
				// Retry the idempotent starting event first: its original response may
				// have been lost even though the worker was successfully created.
				if err = s.publishState(ctx, &w, protocol.Starting); err != nil {
					return err
				}
				if err = s.publishState(ctx, &w, protocol.Running); err != nil {
					return err
				}
			}
			continue
		}
		if observeErr != nil && !s.Tmux.ServerAlive(ctx) {
			one := 1
			obs = harnesses.Observation{State: protocol.Failed, ExitCode: &one}
			detail, _ := json.Marshal(map[string]string{"failure_boundary": "private tmux server unavailable"})
			obs.Detail = detail
		} else if observeErr != nil {
			return observeErr
		}
		settlement, err := a.CollectSettlement(ctx, w.Job, w.Launch, obs)
		if err != nil {
			return err
		}
		if len(obs.Detail) > 0 {
			settlement.Detail = obs.Detail
		}
		event := protocol.ObservedEvent{ID: id + "-settlement", JobID: id, Settlement: settlement, ObservedAt: time.Now().UTC()}
		if err = s.Client.Events(ctx, protocol.EventBatch{Host: s.Host, Events: []protocol.ObservedEvent{event}}); err != nil {
			return err
		}
		_ = s.Registry.Delete(id)
	}
	return nil
}
// GCSettled removes only service-confirmed terminal job artifacts, honoring a
// per-job retention override. root bounds deletion and must contain each path.
func GCSettled(jobs []protocol.Job, root string, now time.Time, defaultAge time.Duration) error {
	absRoot, err := filepath.Abs(root)
	if err != nil { return err }
	for _, j := range jobs {
		if !j.State.Terminal() || j.Artifacts.Directory == "" { continue }
		path, err := filepath.Abs(j.Artifacts.Directory)
		if err != nil { return err }
		rel, err := filepath.Rel(absRoot, path)
		if err != nil || rel == "." || rel == ".." || filepath.IsAbs(rel) || len(rel) >= 3 && rel[:3] == ".."+string(os.PathSeparator) { continue }
		age := defaultAge
		if j.Artifacts.RetentionDays > 0 { age = time.Duration(j.Artifacts.RetentionDays)*24*time.Hour }
		at := j.UpdatedAt; if j.Settlement != nil && !j.Settlement.At.IsZero() { at = j.Settlement.At }
		if !at.IsZero() && now.Sub(at) >= age { if err = os.RemoveAll(path); err != nil { return err } }
	}
	return nil
}

// GC is a low-level age-based helper retained for host administration. The CLI
// uses GCSettled so running jobs can never be removed by semantic GC.
func GC(root string, before time.Time) error {
	entries, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		info, e := entry.Info()
		if e == nil && info.ModTime().Before(before) {
			if e = os.RemoveAll(filepath.Join(root, entry.Name())); e != nil {
				return e
			}
		}
	}
	return nil
}
