// Package harnesses defines the process-neutral adapter contract. Adapters own
// harness semantics; the supervisor owns tmux/process reality.
package harnesses

import (
	"context"
	"errors"
	"os"
	"time"

	"familiar.dev/agents/protocol"
)

type Launch struct {
	Argv       []string          `json:"argv"`
	Dir        string            `json:"dir"`
	Env        map[string]string `json:"env,omitempty"`
	Transcript string            `json:"transcript"`
	Session    string            `json:"session,omitempty"`
}

type Runtime struct {
	Launch            Launch
	ObservationCursor int64 // durable adapter-specific byte/event cursor
	SendText          func(context.Context, string) error
	Cancel            func(context.Context) error
	Alive             func(context.Context) (bool, *int, error)
}

type Observation struct {
	State      protocol.State
	ExitCode   *int
	Progress   *protocol.Progress // compatibility for adapters projecting one event
	Progresses []*protocol.Progress
	Cursor     int64
	Question   *protocol.BlockedQuestion
	Detail     []byte
}

// Adapter is deliberately explicit even when a minimal harness cannot support
// every operation. Unsupported methods return ErrUnsupported rather than
// pretending equivalent semantics.
type Adapter interface {
	Start(context.Context, protocol.Job) (Launch, error)
	Prompt(context.Context, *Runtime, string) error
	Observe(context.Context, protocol.Job, *Runtime) (Observation, error)
	Answer(context.Context, *Runtime, protocol.Answer) error
	Cancel(context.Context, *Runtime) error
	Resume(context.Context, protocol.Job, Launch) (Launch, error)
	CollectSettlement(context.Context, protocol.Job, Launch, Observation) (*protocol.Settlement, error)
}

var ErrUnsupported = errors.New("operation unsupported by harness adapter")

func BasicSettlement(job protocol.Job, launch Launch, o Observation) (*protocol.Settlement, error) {
	verdict, summary := protocol.Failed, "harness process failed"
	if o.ExitCode != nil && *o.ExitCode == 0 {
		verdict, summary = protocol.Done, "harness process completed"
	}
	if o.State == protocol.Cancelled {
		verdict, summary = protocol.Cancelled, "harness process cancelled"
	}
	if o.State == protocol.Timeout {
		verdict, summary = protocol.Timeout, "harness process timed out"
	}
	return &protocol.Settlement{ID: job.ID + "-settlement", JobID: job.ID, Verdict: verdict, Summary: summary, At: time.Now().UTC(), Artifacts: existingArtifacts(launch)}, nil
}
func existingArtifacts(l Launch) []protocol.ArtifactRef {
	out := []protocol.ArtifactRef{}
	for name, path := range map[string]string{"transcript": l.Transcript, "session": l.Session} {
		if path != "" {
			if _, err := os.Stat(path); err == nil {
				out = append(out, protocol.ArtifactRef{Name: name, Path: path})
			}
		}
	}
	return out
}
