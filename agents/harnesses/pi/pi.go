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
	l.Argv = []string{a.bin(), "--mode", "json", "--print", "--session", l.Session, j.Prompt}
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
func (Adapter) Observe(_ context.Context, j protocol.Job, r *harnesses.Runtime) (harnesses.Observation, error) {
	o := harnesses.Observation{State: protocol.Running}
	f, e := os.Open(r.Launch.Transcript)
	if os.IsNotExist(e) {
		return o, nil
	}
	if e != nil {
		return o, e
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		b := append([]byte(nil), s.Bytes()...)
		h := sha256.Sum256(b)
		o.Progress = &protocol.Progress{ID: j.ID + "-pi-" + hex.EncodeToString(h[:8]), JobID: j.ID, At: time.Now().UTC(), Message: "pi lifecycle event", Detail: json.RawMessage(b)}
	}
	return o, s.Err()
}
func (Adapter) CollectSettlement(_ context.Context, j protocol.Job, l harnesses.Launch, o harnesses.Observation) (*protocol.Settlement, error) {
	return harnesses.BasicSettlement(j, l, o)
}
