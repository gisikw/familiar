package pi

import (
	"context"
	"familiar.dev/agents/harnesses"
	"familiar.dev/agents/protocol"
	"os"
	"path/filepath"
	"testing"
)

func TestObserveExitAndCollectSession(t *testing.T) {
	dir := t.TempDir()
	j := protocol.Job{ID: "j", CWD: dir, Prompt: "p", Artifacts: protocol.ArtifactMetadata{Directory: dir}}
	l, err := (Adapter{Binary: "fake-pi"}).Start(context.Background(), j)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(l.Transcript, []byte("{\"type\":\"message\"}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(l.Session, []byte("{\"usage\":{\"inputTokens\":2,\"outputTokens\":3}}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	zero := 0
	r := &harnesses.Runtime{Launch: l, Alive: func(context.Context) (bool, *int, error) { return false, &zero, nil }}
	o, err := (Adapter{}).Observe(context.Background(), j, r)
	if err != nil {
		t.Fatal(err)
	}
	if o.State != protocol.Failed || o.Progress == nil {
		t.Fatalf("observation %#v", o)
	}
	s, err := (Adapter{}).CollectSettlement(context.Background(), j, l, o)
	if err != nil {
		t.Fatal(err)
	}
	if s.Verdict != protocol.Done || s.Usage.InputTokens != 2 || s.Usage.OutputTokens != 3 {
		t.Fatalf("settlement %#v", s)
	}
	if filepath.Base(l.Session) != "pi-session.jsonl" {
		t.Fatal(l.Session)
	}
}
