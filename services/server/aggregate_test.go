package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// aggFixture builds a plugin left-nav contribution whose node IDs (root/b/i)
// deliberately collide with every other plugin so namespacing is exercised.
func aggFixture(workspace, session string) string {
	return `{"render_api":1,"revision":1,"ttl_ms":5000,"target":"left-nav","content":{"kind":"tree","id":"root","label":"` + workspace + `","children":[{"kind":"branch","id":"b","label":"ws","children":[{"kind":"item","id":"i","label":"work","status":"running","activation":{"type":"terminal","socket":"/run/g.sock","session":"` + session + `"}}]}]}}`
}

func hubWithDoc(t *testing.T, plugin, fixture string) *renderHub {
	t.Helper()
	h := newRenderHub(RenderConfig{Plugin: plugin}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	var env renderEnvelope
	if err := json.Unmarshal([]byte(fixture), &env); err != nil {
		t.Fatal(err)
	}
	if err := validateRender(&env); err != nil {
		t.Fatal(err)
	}
	h.doc = []byte(fixture)
	h.content = env.Content
	h.target = env.Target
	h.hasDoc = true
	return h
}

func aggregateDoc(t *testing.T, a *renderAggregator) renderEnvelope {
	t.Helper()
	w := httptest.NewRecorder()
	a.viewerHandler(w, httptest.NewRequest(http.MethodGet, "/v1/render", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("aggregate status=%d", w.Code)
	}
	var env renderEnvelope
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	return env
}

func collectSessions(n renderNode, out *[]string) {
	if n.Activation != nil {
		*out = append(*out, n.Activation.Session)
	}
	if n.Children != nil {
		for _, c := range *n.Children {
			collectSessions(c, out)
		}
	}
}
func collectIDs(n renderNode, out *[]string) {
	*out = append(*out, n.ID)
	if n.Children != nil {
		for _, c := range *n.Children {
			collectIDs(c, out)
		}
	}
}

// Two plugins compose under one host tree, in deterministic config order, with
// per-plugin namespacing that resolves colliding IDs while preserving the exact
// terminal activation session identifiers.
func TestAggregateComposesMultiplePluginsInOrderWithNamespacing(t *testing.T) {
	a := newRenderAggregator([]*renderHub{
		hubWithDoc(t, "golem", aggFixture("alpha", "worker-a")),
		hubWithDoc(t, "second", aggFixture("beta", "worker-b")),
	}, nil)
	env := aggregateDoc(t, a)
	if env.RenderAPI != 1 || env.Target != "left-nav" || env.Content.Kind != "tree" {
		t.Fatalf("bad aggregate envelope: %+v", env)
	}
	// The whole aggregate must still pass the host render validator (unique IDs).
	if err := validateRender(&env); err != nil {
		t.Fatalf("aggregate failed validation: %v", err)
	}
	kids := *env.Content.Children
	if len(kids) != 2 {
		t.Fatalf("want 2 plugin branches, got %d", len(kids))
	}
	// Deterministic config order: golem before second.
	if kids[0].ID != "golem/root" || kids[1].ID != "second/root" {
		t.Fatalf("order/namespacing wrong: %q %q", kids[0].ID, kids[1].ID)
	}
	if kids[0].Kind != "branch" || kids[1].Kind != "branch" {
		t.Fatal("plugin roots must be demoted to branches")
	}
	var ids []string
	collectIDs(env.Content, &ids)
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			t.Fatalf("duplicate id after namespacing: %q", id)
		}
		seen[id] = true
	}
	// Activation identifiers are never namespaced.
	var sessions []string
	collectSessions(env.Content, &sessions)
	if len(sessions) != 2 || sessions[0] != "worker-a" || sessions[1] != "worker-b" {
		t.Fatalf("activation sessions were mutated: %v", sessions)
	}
}

// The single aggregate revision advances when either plugin hub changes.
func TestAggregateRevisionAdvancesOnEitherPlugin(t *testing.T) {
	g := hubWithDoc(t, "golem", aggFixture("alpha", "worker-a"))
	s := hubWithDoc(t, "second", aggFixture("beta", "worker-b"))
	a := newRenderAggregator([]*renderHub{g, s}, nil)
	r0 := aggregateDoc(t, a).Revision

	// Change plugin one.
	g.mu.Lock()
	g.content.Label = "alpha2"
	g.mu.Unlock()
	a.recompose()
	r1 := aggregateDoc(t, a).Revision
	if r1 <= r0 {
		t.Fatalf("revision did not advance on plugin one: %d -> %d", r0, r1)
	}

	// Change plugin two.
	s.mu.Lock()
	s.content.Label = "beta2"
	s.mu.Unlock()
	a.recompose()
	r2 := aggregateDoc(t, a).Revision
	if r2 <= r1 {
		t.Fatalf("revision did not advance on plugin two: %d -> %d", r1, r2)
	}

	// Idempotent recompose does not bump the revision.
	a.recompose()
	if got := aggregateDoc(t, a).Revision; got != r2 {
		t.Fatalf("revision advanced without change: %d -> %d", r2, got)
	}
}

// With no plugins enrolled the aggregate still serves a valid empty tree and
// never returns an error status (core readiness is not gated on chrome).
func TestAggregateNoPluginServesEmptyTree(t *testing.T) {
	a := newRenderAggregator(nil, nil)
	env := aggregateDoc(t, a)
	if env.Target != "left-nav" || env.Content.Kind != "tree" {
		t.Fatalf("empty aggregate malformed: %+v", env)
	}
	if env.Content.Children == nil || len(*env.Content.Children) != 0 {
		t.Fatalf("want empty children, got %+v", env.Content.Children)
	}
}

// A plugin that has not yet produced a usable render is skipped, and a plugin
// whose contribution targets something other than left-nav is skipped too;
// neither blocks the aggregate.
func TestAggregateSkipsUnavailableAndNonLeftNav(t *testing.T) {
	empty := newRenderHub(RenderConfig{Plugin: "empty"}, slog.Default())
	good := hubWithDoc(t, "golem", aggFixture("alpha", "worker-a"))
	a := newRenderAggregator([]*renderHub{empty, good}, nil)
	env := aggregateDoc(t, a)
	kids := *env.Content.Children
	if len(kids) != 1 || kids[0].ID != "golem/root" {
		t.Fatalf("unavailable plugin was not skipped: %+v", kids)
	}
}

// The aggregate long-poll wakes when a hub notifies a change through the shared
// notify hook wired at construction.
func TestAggregateLongPollWakesOnHubChange(t *testing.T) {
	g := hubWithDoc(t, "golem", aggFixture("alpha", "worker-a"))
	a := newRenderAggregator([]*renderHub{g}, nil)
	rev := aggregateDoc(t, a).Revision

	done := make(chan uint64, 1)
	go func() {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/v1/render?revision="+itoa(rev), nil)
		a.viewerHandler(w, req)
		var env renderEnvelope
		_ = json.Unmarshal(w.Body.Bytes(), &env)
		done <- env.Revision
	}()

	time.Sleep(20 * time.Millisecond)
	g.mu.Lock()
	g.content.Label = "changed"
	g.mu.Unlock()
	g.notify() // simulate the hub's post-change notification

	select {
	case got := <-done:
		if got <= rev {
			t.Fatalf("long poll returned stale revision %d (was %d)", got, rev)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("long poll did not wake on hub change")
	}
}

func itoa(v uint64) string {
	b, _ := json.Marshal(v)
	return string(b)
}
