package pi

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"familiar.dev/agents/harnesses"
	"familiar.dev/agents/protocol"
	"os"
	"path/filepath"
	"time"
)

type Adapter struct{ Binary string }

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
	if j.Model != "" {
		v = append(v, "--model", j.Model)
	}
	v = append(v, j.Prompt)
	return harnesses.Launch{Argv: v, Dir: j.CWD, Transcript: t, Session: s}, nil
}
func (a Adapter) Resume(_ context.Context, j protocol.Job, l harnesses.Launch) (harnesses.Launch, error) {
	if l.Session == "" {
		return harnesses.Launch{}, errors.New("pi resume requires session")
	}
	l.Argv = []string{a.bin(), "--mode", "json", "--print", "--session", l.Session}
	if j.Model != "" {
		l.Argv = append(l.Argv, "--model", j.Model)
	}
	l.Argv = append(l.Argv, "Continue the interrupted delegated task from the existing session.")
	return l, nil
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
	o := harnesses.Observation{State: protocol.Running, ExitCode: code}
	f, e := os.Open(r.Launch.Transcript)
	if e == nil {
		defer f.Close()
		scan := bufio.NewScanner(f)
		scan.Buffer(make([]byte, 64<<10), 4<<20)
		for scan.Scan() {
			b := append([]byte(nil), scan.Bytes()...)
			if !json.Valid(b) {
				continue
			}
			h := sha256.Sum256(b)
			o.Progress = &protocol.Progress{ID: j.ID + "-pi-" + hex.EncodeToString(h[:8]), JobID: j.ID, At: time.Now().UTC(), Message: "pi lifecycle event", Detail: json.RawMessage(b)}
		}
		if err = scan.Err(); err != nil {
			return o, err
		}
	} else if !os.IsNotExist(e) {
		return o, e
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
func collectUsage(v any, u *protocol.Usage) {
	switch x := v.(type) {
	case map[string]any:
		for k, v := range x {
			if m, ok := v.(map[string]any); ok && (k == "usage" || k == "tokens") {
				addNumber(m, "input", &u.InputTokens)
				addNumber(m, "inputTokens", &u.InputTokens)
				addNumber(m, "output", &u.OutputTokens)
				addNumber(m, "outputTokens", &u.OutputTokens)
			}
			collectUsage(v, u)
		}
	case []any:
		for _, v := range x {
			collectUsage(v, u)
		}
	}
}
func addNumber(m map[string]any, k string, p *int64) {
	if n, ok := m[k].(float64); ok {
		*p += int64(n)
	}
}
