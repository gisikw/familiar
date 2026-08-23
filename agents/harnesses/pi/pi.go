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

type Adapter struct {
	Binary    string
	Extension string
	Env       map[string]string
}

func (a Adapter) bin() string {
	if a.Binary != "" {
		return a.Binary
	}
	return "pi"
}
func paths(j protocol.Job) (string, string) {
	return filepath.Join(j.Artifacts.Directory, "pi-session.jsonl"), filepath.Join(j.Artifacts.Directory, "pi-output.jsonl")
}
func (a Adapter) Start(_ context.Context, j protocol.Job) (harnesses.Launch, error) {
	if j.Artifacts.Directory == "" {
		return harnesses.Launch{}, errors.New("pi requires artifact directory")
	}
	if e := os.MkdirAll(j.Artifacts.Directory, 0700); e != nil {
		return harnesses.Launch{}, e
	}
	s, t := paths(j)
	v := []string{a.bin(), "--mode", "json", "--print", "--session", s}
	if a.Extension != "" {
		v = append(v, "--extension", a.Extension)
	}
	if j.Model != "" {
		v = append(v, "--model", j.Model)
	}
	v = append(v, j.Prompt)
	return harnesses.Launch{Argv: v, Dir: j.CWD, Env: cloneEnv(a.Env), Transcript: t, Session: s}, nil
}
func (a Adapter) Resume(_ context.Context, j protocol.Job, l harnesses.Launch) (harnesses.Launch, error) {
	if l.Session == "" {
		return harnesses.Launch{}, errors.New("pi resume requires session")
	}
	l.Argv = []string{a.bin(), "--mode", "json", "--print", "--session", l.Session}
	if a.Extension != "" {
		l.Argv = append(l.Argv, "--extension", a.Extension)
	}
	l.Env = cloneEnv(a.Env)
	if j.Model != "" {
		l.Argv = append(l.Argv, "--model", j.Model)
	}
	l.Argv = append(l.Argv, "Continue the interrupted delegated task from the existing session.")
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
func (Adapter) Observe(ctx context.Context, j protocol.Job, r *harnesses.Runtime) (harnesses.Observation, error) {
	if r.Alive == nil {
		return harnesses.Observation{}, harnesses.ErrUnsupported
	}
	alive, code, err := r.Alive(ctx)
	if err != nil {
		return harnesses.Observation{}, err
	}
	o := harnesses.Observation{State: protocol.Running, ExitCode: code, Cursor: r.ObservationCursor}
	f, e := os.Open(r.Launch.Transcript)
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
			// A writer may be in the middle of a JSON record. Do not advance the
			// durable cursor until its newline makes the record complete.
			if !strings.HasSuffix(line, "\n") {
				break
			}
			lineOffset := o.Cursor
			o.Cursor += int64(len(line))
			b := []byte(strings.TrimSuffix(line, "\n"))
			var header struct {
				Type      string    `json:"type"`
				Timestamp time.Time `json:"timestamp"`
			}
			if json.Unmarshal(b, &header) == nil && recognizedEvent(header.Type) {
				h := sha256.Sum256(b)
				at := header.Timestamp
				if at.IsZero() {
					at = time.Now().UTC()
				}
				o.Progresses = append(o.Progresses, &protocol.Progress{ID: fmt.Sprintf("%s-pi-%d-%s", j.ID, lineOffset, hex.EncodeToString(h[:8])), JobID: j.ID, At: at, Message: "pi " + header.Type, Detail: json.RawMessage(append([]byte(nil), b...))})
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
func (Adapter) CollectSettlement(_ context.Context, j protocol.Job, l harnesses.Launch, o harnesses.Observation) (*protocol.Settlement, error) {
	s, err := harnesses.BasicSettlement(j, l, o)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(l.Session)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	scan := bufio.NewScanner(f)
	scan.Buffer(make([]byte, 64<<10), 4<<20)
	for scan.Scan() {
		var v any
		if json.Unmarshal(scan.Bytes(), &v) == nil {
			collectUsage(v, &s.Usage)
		}
	}
	return s, scan.Err()
}

// JSON mode emits these documented lifecycle records. Session headers and
// arbitrary extension payloads are intentionally not projected as progress.
func recognizedEvent(kind string) bool {
	switch kind {
	case "agent_start", "agent_end", "turn_start", "turn_end", "message_start", "message_update", "message_end",
		"tool_execution_start", "tool_execution_update", "tool_execution_end", "queue_update", "compaction_start", "compaction_end", "auto_retry_start", "auto_retry_end":
		return true
	default:
		return false
	}
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
