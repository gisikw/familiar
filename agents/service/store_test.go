package service

import (
	"context"
	"familiar.dev/agents/protocol"
	"path/filepath"
	"testing"
	"time"
)

func create(t *testing.T, s *Store) protocol.Job {
	t.Helper()
	j, e := s.Create(context.Background(), protocol.CreateJob{IdempotencyKey: "key", Harness: "fake", Host: "host", Prompt: "go", CWD: "/tmp"})
	if e != nil {
		t.Fatal(e)
	}
	return j
}
func TestSettlementIdempotentAndDurable(t *testing.T) {
	p := filepath.Join(t.TempDir(), "db")
	s, e := Open(p)
	if e != nil {
		t.Fatal(e)
	}
	j := create(t, s)
	ctx := context.Background()
	for i, st := range []protocol.State{protocol.Starting, protocol.Running} {
		if e = s.Record(ctx, protocol.EventBatch{Host: "host", Events: []protocol.ObservedEvent{{ID: string(rune('a' + i)), JobID: j.ID, State: st}}}); e != nil {
			t.Fatal(e)
		}
	}
	set := &protocol.Settlement{ID: "settle", JobID: j.ID, Verdict: protocol.Done, At: time.Now()}
	b := protocol.EventBatch{Host: "host", Events: []protocol.ObservedEvent{{ID: "terminal", JobID: j.ID, Settlement: set}}}
	if e = s.Record(ctx, b); e != nil {
		t.Fatal(e)
	}
	if e = s.Record(ctx, b); e != nil {
		t.Fatal(e)
	}
	altered := *set
	altered.Summary = "late conflicting detail"
	if e = s.Record(ctx, protocol.EventBatch{Host: "host", Events: []protocol.ObservedEvent{{ID: "terminal-retry", JobID: j.ID, Settlement: &altered}}}); e != nil {
		t.Fatal(e)
	}
	s.Close()
	s, e = Open(p)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	got, e := s.Get(ctx, j.ID)
	if e != nil || got.State != protocol.Done || got.Settlement == nil || got.Settlement.Summary != "" {
		t.Fatalf("reopen/first settlement: %#v %v", got, e)
	}
}
func TestRejectTerminalWithoutSettlement(t *testing.T) {
	s, _ := Open(filepath.Join(t.TempDir(), "db"))
	defer s.Close()
	j := create(t, s)
	e := s.Record(context.Background(), protocol.EventBatch{Host: "host", Events: []protocol.ObservedEvent{{ID: "bad", JobID: j.ID, State: protocol.Failed}}})
	if e == nil {
		t.Fatal("accepted terminal observation without settlement")
	}
}
