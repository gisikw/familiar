package pi

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"familiar.dev/agents/harnesses"
	"familiar.dev/agents/protocol"
)

// Adapter runs pi as an interactive TUI. Lifecycle is reported out-of-band by
// the agent-hooks pi extension (HookExtension) which appends durable records to
// the job's side-channel events file; Observe advances a cursor over it. This
// is the documented "hook/side-channel" pattern for harnesses without a
// machine-readable stdout lifecycle stream.
type Adapter struct {
	Binary string
	// Extension is an optional additional worker extension (e.g. tiamat model
	// routing) loaded alongside the hook extension.
	Extension string
	// HookExtension is the agent-hooks side-channel extension path. When empty
	// no lifecycle is reported over the side channel and the worker settles only
	// on process death (supervisor crash boundary).
	HookExtension string
	Env           map[string]string
}

// EventsEnv names the side-channel path the hook extension writes to.
const EventsEnv = "FAMILIAR_AGENTS_EVENTS"

// blockSuffix is appended to the worker's initial prompt. Blocking is an
// explicit agent action (pi has no native ask mechanism): the agent-hooks
// extension registers agents_block, and this sentence tells the worker when and
// how to use it. Kept short by design.
const blockSuffix = "\n\nIf you are genuinely blocked on operator input (missing credentials, ambiguous requirements, or confirmation of a destructive action), call the agents_block tool with your question, then end your turn; the operator's answer will arrive as your next message."

// withBlockSuffix appends the blocked-question instruction to a worker prompt.
func withBlockSuffix(prompt string) string { return prompt + blockSuffix }

func (a Adapter) bin() string {
	if a.Binary != "" {
		return a.Binary
	}
	return "pi"
}

// paths returns the session JSONL, pane transcript, and side-channel events
// file beneath the job's artifact directory.
func paths(j protocol.Job) (string, string, string) {
	return filepath.Join(j.Artifacts.Directory, "pi-session.jsonl"),
		filepath.Join(j.Artifacts.Directory, "pi-transcript.log"),
		filepath.Join(j.Artifacts.Directory, "events.jsonl")
}

func (a Adapter) launchEnv(events string) map[string]string {
	env := cloneEnv(a.Env)
	if env == nil {
		env = map[string]string{}
	}
	env[EventsEnv] = events
	return env
}

func (a Adapter) extensions(v []string) []string {
	if a.HookExtension != "" {
		v = append(v, "--extension", a.HookExtension)
	}
	if a.Extension != "" {
		v = append(v, "--extension", a.Extension)
	}
	return v
}

func (a Adapter) Start(_ context.Context, j protocol.Job) (harnesses.Launch, error) {
	if j.Artifacts.Directory == "" {
		return harnesses.Launch{}, errors.New("pi requires artifact directory")
	}
	if e := os.MkdirAll(j.Artifacts.Directory, 0700); e != nil {
		return harnesses.Launch{}, e
	}
	s, t, ev := paths(j)
	// Interactive TUI: no --mode json --print. The positional prompt is
	// delivered as pi's initial message so the agent starts immediately.
	v := a.extensions([]string{a.bin(), "--session", s})
	if j.Model != "" {
		v = append(v, "--model", j.Model)
	}
	v = append(v, withBlockSuffix(j.Prompt))
	return harnesses.Launch{Argv: v, Dir: j.CWD, Env: a.launchEnv(ev), Transcript: t, Session: s, Events: ev, Interactive: true}, nil
}

func (a Adapter) Resume(_ context.Context, j protocol.Job, l harnesses.Launch) (harnesses.Launch, error) {
	if l.Session == "" {
		return harnesses.Launch{}, errors.New("pi resume requires session")
	}
	if l.Events == "" {
		_, _, l.Events = paths(j)
	}
	l.Argv = a.extensions([]string{a.bin(), "--session", l.Session})
	if j.Model != "" {
		l.Argv = append(l.Argv, "--model", j.Model)
	}
	l.Argv = append(l.Argv, "Continue the interrupted delegated task from the existing session.")
	l.Env = a.launchEnv(l.Events)
	l.Interactive = true
	return l, nil
}

func cloneEnv(src map[string]string) map[string]string {
	if len(src) == 0 {
		return nil
	}
	dst := make(map[string]string, len(src))
	for k, v := range src {
		dst[k] = v
	}
	return dst
}

func (Adapter) Prompt(ctx context.Context, r *harnesses.Runtime, p string) error {
	if r.SendText == nil {
		return harnesses.ErrUnsupported
	}
	return r.SendText(ctx, p)
}
func (Adapter) Answer(ctx context.Context, r *harnesses.Runtime, a protocol.Answer) error {
	if r.SendText == nil {
		return harnesses.ErrUnsupported
	}
	return r.SendText(ctx, a.Text)
}
func (Adapter) Cancel(ctx context.Context, r *harnesses.Runtime) error {
	if r.Cancel == nil {
		return harnesses.ErrUnsupported
	}
	return r.Cancel(ctx)
}

// sideEvent is one line of the append-only events.jsonl side channel written by
// the agent-hooks extension.
type sideEvent struct {
	Type    string     `json:"type"`
	Ts      int64      `json:"ts"` // epoch millis
	Turn    *int       `json:"turn,omitempty"`
	Message string     `json:"message,omitempty"`
	Summary string     `json:"summary,omitempty"`
	Verdict string     `json:"verdict,omitempty"`
	ID      string     `json:"id,omitempty"`
	Prompt  string     `json:"prompt,omitempty"`
	Options []string   `json:"options,omitempty"`
	Usage   *sideUsage `json:"usage,omitempty"`
}
type sideUsage struct {
	Input  int64   `json:"input"`
	Output int64   `json:"output"`
	Cost   float64 `json:"cost"`
}

// Observe advances a durable byte cursor over the side-channel events file. It
// never parses pi TUI output. Process death is the supervisor's concern.
func (Adapter) Observe(ctx context.Context, j protocol.Job, r *harnesses.Runtime) (harnesses.Observation, error) {
	if r.Alive == nil {
		return harnesses.Observation{}, harnesses.ErrUnsupported
	}
	alive, code, err := r.Alive(ctx)
	if err != nil {
		return harnesses.Observation{}, err
	}
	o := harnesses.Observation{State: protocol.Running, ExitCode: code, Cursor: r.ObservationCursor}
	f, e := os.Open(r.Launch.Events)
	if e == nil {
		defer f.Close()
		if _, err = f.Seek(r.ObservationCursor, io.SeekStart); err != nil {
			return o, err
		}
		reader := bufio.NewReaderSize(f, 64<<10)
		for {
			line, readErr := reader.ReadString('\n')
			if readErr != nil && !errors.Is(readErr, io.EOF) {
				return o, readErr
			}
			// A writer may be mid-record; do not advance the durable cursor until
			// its newline makes the JSON object complete.
			if !strings.HasSuffix(line, "\n") {
				break
			}
			lineOffset := o.Cursor
			o.Cursor += int64(len(line))
			b := []byte(strings.TrimSuffix(line, "\n"))
			var ev sideEvent
			if json.Unmarshal(b, &ev) != nil || ev.Type == "" {
				if errors.Is(readErr, io.EOF) {
					break
				}
				continue
			}
			at := time.UnixMilli(ev.Ts).UTC()
			if ev.Ts == 0 {
				at = time.Now().UTC()
			}
			switch ev.Type {
			case "settled":
				o.Settled = true
				o.Verdict = mapVerdict(ev.Verdict)
				o.Summary = ev.Summary
				if ev.Usage != nil {
					o.Usage = &protocol.Usage{InputTokens: ev.Usage.Input, OutputTokens: ev.Usage.Output, CostMicros: int64(math.Round(ev.Usage.Cost * 1_000_000))}
				}
			case "blocked":
				o.Question = &protocol.BlockedQuestion{ID: ev.ID, Prompt: ev.Prompt, Options: ev.Options, At: at, Detail: json.RawMessage(append([]byte(nil), b...))}
			default:
				h := sha256.Sum256(b)
				msg := ev.Message
				if msg == "" {
					msg = "pi " + ev.Type
				}
				o.Progresses = append(o.Progresses, &protocol.Progress{ID: fmt.Sprintf("%s-pi-%d-%s", j.ID, lineOffset, hex.EncodeToString(h[:8])), JobID: j.ID, At: at, Message: msg, Detail: json.RawMessage(append([]byte(nil), b...))})
			}
			if errors.Is(readErr, io.EOF) {
				break
			}
		}
	} else if !os.IsNotExist(e) {
		return o, e
	}
	if len(o.Progresses) > 0 {
		o.Progress = o.Progresses[len(o.Progresses)-1]
	}
	if !alive {
		o.State = protocol.Failed
	}
	return o, nil
}

func mapVerdict(v string) protocol.State {
	switch protocol.State(v) {
	case protocol.Done, protocol.Failed, protocol.Cancelled, protocol.Timeout:
		return protocol.State(v)
	default:
		return protocol.Done
	}
}

// CollectSettlement builds the settlement. A side-channel "settled" event
// carries the verdict, final assistant message, and usage directly; otherwise
// (e.g. a crash boundary) BasicSettlement infers the verdict from process exit.
// In both cases usage is reconciled against the pi session JSONL, whose
// per-operation records are the authoritative cumulative total.
func (Adapter) CollectSettlement(_ context.Context, j protocol.Job, l harnesses.Launch, o harnesses.Observation) (*protocol.Settlement, error) {
	var s *protocol.Settlement
	if o.Settled {
		s = harnesses.SideChannelSettlement(j, l, o)
	} else {
		var err error
		if s, err = harnesses.BasicSettlement(j, l, o); err != nil {
			return nil, err
		}
	}
	// Reconcile usage from the session JSONL when the side channel did not
	// report it (the cumulative-usage logic is the authoritative source).
	if o.Usage == nil {
		if err := sessionUsage(l.Session, &s.Usage); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func sessionUsage(session string, u *protocol.Usage) error {
	f, err := os.Open(session)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	scan := bufio.NewScanner(f)
	scan.Buffer(make([]byte, 64<<10), 4<<20)
	for scan.Scan() {
		var v any
		if json.Unmarshal(scan.Bytes(), &v) == nil {
			collectUsage(v, u)
		}
	}
	return scan.Err()
}

type piUsage struct {
	Input  int64 `json:"input"`
	Output int64 `json:"output"`
	Cost   struct {
		Total float64 `json:"total"`
	} `json:"cost"`
}
type sessionRecord struct {
	Type    string   `json:"type"`
	Usage   *piUsage `json:"usage,omitempty"`
	Message *struct {
		Role  string   `json:"role"`
		Usage *piUsage `json:"usage,omitempty"`
	} `json:"message,omitempty"`
}

// Session usage records are per-operation deltas, not cumulative snapshots.
// We add only usage-bearing fields defined by pi's session schema and return
// the final cumulative total. Nested details/retainedTail copies are ignored.
func collectUsage(v any, u *protocol.Usage) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	var record sessionRecord
	if json.Unmarshal(b, &record) != nil {
		return
	}
	var usage *piUsage
	switch record.Type {
	case "message":
		if record.Message != nil && (record.Message.Role == "assistant" || record.Message.Role == "toolResult") {
			usage = record.Message.Usage
		}
	case "compaction", "branch_summary":
		usage = record.Usage
	}
	if usage != nil {
		u.InputTokens += usage.Input
		u.OutputTokens += usage.Output
		u.CostMicros += int64(math.Round(usage.Cost.Total * 1_000_000))
	}
}
