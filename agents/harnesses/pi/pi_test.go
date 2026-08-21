package pi

import (
	"context"
	"familiar.dev/agents/harnesses"
	"familiar.dev/agents/protocol"
	"os"
	"path/filepath"
	"testing"
)

func TestObserveUsesCursorAndProjectsIntermediateEvents(t *testing.T) {
	dir := t.TempDir()
	j := protocol.Job{ID: "j", CWD: dir, Prompt: "p", Artifacts: protocol.ArtifactMetadata{ID: "j", Directory: dir}}
	l, err := (Adapter{Binary: "fake-pi"}).Start(context.Background(), j)
	if err != nil {
		t.Fatal(err)
	}
	initial := "{\"type\":\"session\",\"version\":3}\n{\"type\":\"turn_start\"}\n{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\"}}\n"
	if err = os.WriteFile(l.Transcript, []byte(initial), 0600); err != nil {
		t.Fatal(err)
	}
	alive := func(context.Context) (bool, *int, error) { return true, nil, nil }
	r := &harnesses.Runtime{Launch: l, Alive: alive}
	o, err := (Adapter{}).Observe(context.Background(), j, r)
	if err != nil || len(o.Progresses) != 2 || o.Cursor != int64(len(initial)) {
		t.Fatalf("first observation %#v, %v", o, err)
	}
	r.ObservationCursor = o.Cursor
	o, err = (Adapter{}).Observe(context.Background(), j, r)
	if err != nil || len(o.Progresses) != 0 {
		t.Fatalf("cursor replayed events: %#v, %v", o, err)
	}
	f, _ := os.OpenFile(l.Transcript, os.O_APPEND|os.O_WRONLY, 0600)
	_, _ = f.WriteString("{\"type\":\"tool_execution_end\"}")
	_ = f.Close()
	o, _ = (Adapter{}).Observe(context.Background(), j, r)
	if len(o.Progresses) != 0 || o.Cursor != r.ObservationCursor {
		t.Fatalf("advanced over partial line: %#v", o)
	}
	f, _ = os.OpenFile(l.Transcript, os.O_APPEND|os.O_WRONLY, 0600)
	_, _ = f.WriteString("\n")
	_ = f.Close()
	o, err = (Adapter{}).Observe(context.Background(), j, r)
	if err != nil || len(o.Progresses) != 1 || o.Cursor <= r.ObservationCursor {
		t.Fatalf("appended observation %#v, %v", o, err)
	}
}

func TestCollectSettlementUsesPiSessionSchema(t *testing.T) {
	dir := t.TempDir()
	j := protocol.Job{ID: "j", CWD: dir, Prompt: "p", Artifacts: protocol.ArtifactMetadata{ID: "j", Directory: dir}}
	l := harnesses.Launch{Session: filepath.Join("testdata", "session.jsonl")}
	zero := 0
	s, err := (Adapter{}).CollectSettlement(context.Background(), j, l, harnesses.Observation{State: protocol.Failed, ExitCode: &zero})
	if err != nil {
		t.Fatal(err)
	}
	if s.Verdict != protocol.Done || s.Usage.InputTokens != 18 || s.Usage.OutputTokens != 7 || s.Usage.CostMicros != 6000 {
		t.Fatalf("settlement usage double-counted or incomplete: %#v", s)
	}
}
