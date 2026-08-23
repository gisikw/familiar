package supervisor

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"familiar.dev/agents/client"
	"familiar.dev/agents/protocol"
	"familiar.dev/agents/service"
)

func testSupervisor(t *testing.T, cwd, artifactRoot string) (*Supervisor, *service.Store, *client.Client) {
	t.Helper()
	store, err := service.Open(filepath.Join(t.TempDir(), "service.db"))
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(service.API{Store: store}.Handler())
	t.Cleanup(httpServer.Close)
	t.Cleanup(func() { _ = store.Close() })
	registry, err := OpenRegistry(filepath.Join(t.TempDir(), "workers.json"))
	if err != nil {
		t.Fatal(err)
	}
	c := client.New(httpServer.URL)
	s := &Supervisor{Host: "host", Client: c, Registry: registry, ArtifactRoot: artifactRoot, AllowedCWDRoots: []string{cwd}, Adapters: DefaultAdapters("", nil, nil), MaxStartAttempts: 2, StartBackoff: time.Nanosecond}
	return s, store, c
}

func TestPermanentStartFailureSettlesImmediatelyAndRejectsCWD(t *testing.T) {
	allowed := t.TempDir()
	outside := t.TempDir()
	s, store, c := testSupervisor(t, allowed, t.TempDir())
	j, err := c.Create(context.Background(), protocol.CreateJob{IdempotencyKey: "outside", Harness: "fake", Host: "host", Prompt: "go", CWD: outside})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.reconcileStart(context.Background(), j); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get(context.Background(), j.ID)
	if err != nil || got.State != protocol.Failed || got.Settlement == nil || !strings.Contains(got.Settlement.Summary, "outside configured allowed roots") {
		t.Fatalf("path rejection was not durably settled: %#v, %v", got, err)
	}
}

func TestTransientStartFailureIsBoundedAndAttemptPersists(t *testing.T) {
	cwd := t.TempDir()
	s, store, c := testSupervisor(t, cwd, filepath.Join("/dev/null", "artifacts"))
	j, err := c.Create(context.Background(), protocol.CreateJob{IdempotencyKey: "bounded", Harness: "fake", Host: "host", Prompt: "go", CWD: cwd})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.reconcileStart(context.Background(), j); err == nil {
		t.Fatal("expected retryable filesystem failure")
	}
	attempt, ok := s.Registry.Attempt(j.ID)
	if !ok || attempt.Count != 1 || attempt.SettlementPending {
		t.Fatalf("attempt not persisted: %#v", attempt)
	}
	registry, err := OpenRegistry(s.Registry.path)
	if err != nil {
		t.Fatal(err)
	}
	s.Registry = registry
	time.Sleep(time.Millisecond)
	if err = s.reconcileStart(context.Background(), j); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get(context.Background(), j.ID)
	if err != nil || got.State != protocol.Failed || got.Settlement == nil || !strings.Contains(got.Settlement.Summary, "after 2 attempt") {
		t.Fatalf("bounded failure was not durably settled: %#v, %v", got, err)
	}
}

func TestUnknownHarnessSettlesWithoutRetry(t *testing.T) {
	cwd := t.TempDir()
	s, store, c := testSupervisor(t, cwd, t.TempDir())
	j, err := c.Create(context.Background(), protocol.CreateJob{IdempotencyKey: "unknown", Harness: "unknown", Host: "host", Prompt: "go", CWD: cwd})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.reconcileStart(context.Background(), j); err != nil {
		t.Fatal(err)
	}
	got, _ := store.Get(context.Background(), j.ID)
	if got.State != protocol.Failed || got.Settlement == nil || !strings.Contains(got.Settlement.Summary, "unknown harness") {
		t.Fatalf("unknown harness was retried: %#v", got)
	}
}

func TestDiffDoesNotRestartOrForgetSettledWorkers(t *testing.T) {
	now := time.Now()
	desired := []protocol.Assignment{{Job: protocol.Job{ID: "historical", State: protocol.Done}, DesiredState: protocol.Done}}
	local := map[string]Worker{"lingering": {Job: protocol.Job{ID: "lingering"}, SettledAt: now}}
	if actions := Diff(desired, local); len(actions) != 0 {
		t.Fatalf("settled jobs produced actions: %#v", actions)
	}
}

func TestDiff(t *testing.T) {
	desired := []protocol.Assignment{{Job: protocol.Job{ID: "new", State: protocol.Assigned}}, {Job: protocol.Job{ID: "stop", State: protocol.Cancelling, CancelRequested: true}, DesiredState: protocol.Cancelling}}
	local := map[string]Worker{"stop": {Job: protocol.Job{ID: "stop"}}, "revoked": {Job: protocol.Job{ID: "revoked"}}}
	a := Diff(desired, local)
	seen := map[ActionKind]int{}
	for _, x := range a {
		seen[x.Kind]++
	}
	if seen[Start] != 1 || seen[Cancel] != 1 || seen[Forget] != 1 {
		t.Fatalf("actions %#v", a)
	}
}
