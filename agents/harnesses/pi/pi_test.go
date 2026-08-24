package pi

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"familiar.dev/agents/harnesses"
	"familiar.dev/agents/protocol"
)

func TestStartLaunchesInteractiveTUIWithSideChannel(t *testing.T) {
	dir := t.TempDir()
	adapter := Adapter{Binary: "fake-pi", HookExtension: "/extensions/agent-hooks", Extension: "/extensions/tiamat", Env: map[string]string{
		"FAMILIAR_TIAMAT_URL": "http://router",
	}}
	j := protocol.Job{ID: "j", CWD: dir, Prompt: "p", Artifacts: protocol.ArtifactMetadata{Directory: dir}}
	launch, err := adapter.Start(context.Background(), j)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(launch.Argv, " ")
	if strings.Contains(joined, "--mode json") || strings.Contains(joined, "--print") {
		t.Fatalf("interactive launch still uses print mode: %v", launch.Argv)
	}
	if !launch.Interactive {
		t.Fatal("launch not marked interactive")
	}
	if !strings.Contains(joined, "--extension /extensions/agent-hooks") || !strings.Contains(joined, "--extension /extensions/tiamat") {
		t.Fatalf("worker extensions absent: %v", launch.Argv)
	}
	if !strings.HasPrefix(launch.Argv[len(launch.Argv)-1], "p") {
		t.Fatalf("initial prompt not delivered as positional message: %v", launch.Argv)
	}
	if !strings.Contains(launch.Argv[len(launch.Argv)-1], "agents_block") {
		t.Fatalf("block-tool suffix not appended to prompt: %v", launch.Argv)
	}
	if launch.Events == "" || launch.Env[EventsEnv] != launch.Events {
		t.Fatalf("side-channel path not wired into env: %#v", launch)
	}
	// Copy discipline: launch env must not alias adapter env.
	launch.Env["FAMILIAR_TIAMAT_URL"] = "mutated"
	if adapter.Env["FAMILIAR_TIAMAT_URL"] != "http://router" {
		t.Fatal("launch mutated adapter environment")
	}
}

func TestObserveProjectsSideChannelWithCursor(t *testing.T) {
	dir := t.TempDir()
	j := protocol.Job{ID: "j", CWD: dir, Prompt: "p", Artifacts: protocol.ArtifactMetadata{ID: "j", Directory: dir}}
	l, err := (Adapter{Binary: "fake-pi"}).Start(context.Background(), j)
	if err != nil {
		t.Fatal(err)
	}
	initial := "{\"type\":\"running\",\"ts\":1}\n{\"type\":\"progress\",\"ts\":2,\"turn\":0}\n"
	if err = os.WriteFile(l.Events, []byte(initial), 0600); err != nil {
		t.Fatal(err)
	}
	alive := func(context.Context) (bool, *int, error) { return true, nil, nil }
	r := &harnesses.Runtime{Launch: l, Alive: alive}
	o, err := (Adapter{}).Observe(context.Background(), j, r)
	if err != nil || len(o.Progresses) != 2 || o.Cursor != int64(len(initial)) || o.Settled {
		t.Fatalf("first observation %#v, %v", o, err)
	}
	r.ObservationCursor = o.Cursor
	o, err = (Adapter{}).Observe(context.Background(), j, r)
	if err != nil || len(o.Progresses) != 0 {
		t.Fatalf("cursor replayed events: %#v, %v", o, err)
	}
	// A partial record must not advance the durable cursor.
	f, _ := os.OpenFile(l.Events, os.O_APPEND|os.O_WRONLY, 0600)
	_, _ = f.WriteString("{\"type\":\"settled\",\"ts\":3,\"verdict\":\"done\"")
	_ = f.Close()
	o, _ = (Adapter{}).Observe(context.Background(), j, r)
	if o.Settled || o.Cursor != r.ObservationCursor {
		t.Fatalf("advanced over partial line: %#v", o)
	}
	f, _ = os.OpenFile(l.Events, os.O_APPEND|os.O_WRONLY, 0600)
	_, _ = f.WriteString(",\"summary\":\"all done\",\"usage\":{\"input\":10,\"output\":4,\"cost\":0.002}}\n")
	_ = f.Close()
	o, err = (Adapter{}).Observe(context.Background(), j, r)
	if err != nil || !o.Settled || o.Verdict != protocol.Done || o.Summary != "all done" {
		t.Fatalf("settlement not projected: %#v, %v", o, err)
	}
	if o.Usage == nil || o.Usage.InputTokens != 10 || o.Usage.OutputTokens != 4 || o.Usage.CostMicros != 2000 {
		t.Fatalf("settlement usage not projected: %#v", o.Usage)
	}
}

func TestObserveProjectsBlockedQuestion(t *testing.T) {
	dir := t.TempDir()
	j := protocol.Job{ID: "j", CWD: dir, Prompt: "p", Artifacts: protocol.ArtifactMetadata{ID: "j", Directory: dir}}
	l, _ := (Adapter{}).Start(context.Background(), j)
	if err := os.WriteFile(l.Events, []byte("{\"type\":\"blocked\",\"ts\":1,\"id\":\"q1\",\"prompt\":\"which db?\",\"options\":[\"postgres\",\"sqlite\"]}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	r := &harnesses.Runtime{Launch: l, Alive: func(context.Context) (bool, *int, error) { return true, nil, nil }}
	o, err := (Adapter{}).Observe(context.Background(), j, r)
	if err != nil || o.Question == nil || o.Question.ID != "q1" || o.Question.Prompt != "which db?" {
		t.Fatalf("blocked question not projected: %#v, %v", o, err)
	}
	if len(o.Question.Options) != 2 || o.Question.Options[0] != "postgres" || o.Question.Options[1] != "sqlite" {
		t.Fatalf("blocked options not projected: %#v", o.Question)
	}
}

// After a blocked event the answer is delivered as the next TUI message; the
// worker resumes and the side channel emits fresh progress. The next Observe
// sees no new blocked record, so o.Question is nil and the supervisor returns
// the worker to Running (edge-triggered: blocked is set only on the tick that
// reads the blocked line). This test documents that projection contract.
func TestObserveResumesAfterBlockedAnswer(t *testing.T) {
	dir := t.TempDir()
	j := protocol.Job{ID: "j", CWD: dir, Prompt: "p", Artifacts: protocol.ArtifactMetadata{ID: "j", Directory: dir}}
	l, _ := (Adapter{}).Start(context.Background(), j)
	if err := os.WriteFile(l.Events, []byte("{\"type\":\"blocked\",\"ts\":1,\"id\":\"q1\",\"prompt\":\"which db?\"}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	r := &harnesses.Runtime{Launch: l, Alive: func(context.Context) (bool, *int, error) { return true, nil, nil }}
	o, err := (Adapter{}).Observe(context.Background(), j, r)
	if err != nil || o.Question == nil {
		t.Fatalf("blocked question not projected: %#v, %v", o, err)
	}
	r.ObservationCursor = o.Cursor
	// Operator's answer resumes the worker; it emits progress on the next turn.
	f, _ := os.OpenFile(l.Events, os.O_APPEND|os.O_WRONLY, 0600)
	_, _ = f.WriteString("{\"type\":\"progress\",\"ts\":2,\"turn\":1}\n")
	_ = f.Close()
	o, err = (Adapter{}).Observe(context.Background(), j, r)
	if err != nil || o.Question != nil {
		t.Fatalf("stale blocked question after answer: %#v, %v", o, err)
	}
	if len(o.Progresses) != 1 || o.State != protocol.Running {
		t.Fatalf("worker did not resume to running with progress: %#v", o)
	}
}

func TestCollectSettlementFromSideChannelReconcilesUsage(t *testing.T) {
	dir := t.TempDir()
	j := protocol.Job{ID: "j", CWD: dir, Prompt: "p", Artifacts: protocol.ArtifactMetadata{ID: "j", Directory: dir}}
	l := harnesses.Launch{Session: filepath.Join("testdata", "session.jsonl")}
	// Side channel reported the verdict + usage directly: session is NOT summed.
	usage := &protocol.Usage{InputTokens: 3, OutputTokens: 1, CostMicros: 500}
	s, err := (Adapter{}).CollectSettlement(context.Background(), j, l, harnesses.Observation{Settled: true, Verdict: protocol.Done, Summary: "ok", Usage: usage})
	if err != nil {
		t.Fatal(err)
	}
	if s.Verdict != protocol.Done || s.Summary != "ok" || s.Usage.InputTokens != 3 {
		t.Fatalf("side-channel settlement not used verbatim: %#v", s)
	}
}

func TestCollectSettlementFallsBackToSessionUsage(t *testing.T) {
	dir := t.TempDir()
	j := protocol.Job{ID: "j", CWD: dir, Prompt: "p", Artifacts: protocol.ArtifactMetadata{ID: "j", Directory: dir}}
	l := harnesses.Launch{Session: filepath.Join("testdata", "session.jsonl")}
	zero := 0
	// No usage on the observation (e.g. crash boundary): fall back to the
	// cumulative session-JSONL sum, preserving the original accounting.
	s, err := (Adapter{}).CollectSettlement(context.Background(), j, l, harnesses.Observation{State: protocol.Failed, ExitCode: &zero})
	if err != nil {
		t.Fatal(err)
	}
	if s.Verdict != protocol.Done || s.Usage.InputTokens != 18 || s.Usage.OutputTokens != 7 || s.Usage.CostMicros != 6000 {
		t.Fatalf("session usage double-counted or incomplete: %#v", s)
	}
}
