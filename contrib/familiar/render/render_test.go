package render

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func kids(n Node) []Node {
	if n.Children == nil {
		return nil
	}
	return *n.Children
}

// liveSockets builds a socketProbe from an explicit socket -> sessions map.
func liveSockets(m map[string][]string) socketProbe {
	return func(socket string) (map[string]bool, error) {
		names, ok := m[socket]
		if !ok {
			return nil, nil
		}
		set := map[string]bool{}
		for _, n := range names {
			set[n] = true
		}
		return set, nil
	}
}
func TestProjectionActivationSettlementAndRemoteNote(t *testing.T) {
	c, _ := NewClient("http://127.0.0.1:1", "")
	s := New(c, "")
	s.SetSocketProbe(liveSockets(map[string][]string{"/live.sock": {"worker-local"}}))
	now := time.Now()
	s.now = func() time.Time { return now }
	s.replace([]Job{{ID: "local", Prompt: "fix it", State: "running", CWD: "/w/a", UpdatedAt: now, Terminal: &Terminal{Socket: "/live.sock", Target: "worker-local:0.0"}}, {ID: "remote", Prompt: "remote", State: "running", CWD: "/w/a", UpdatedAt: now.Add(-time.Second), Terminal: &Terminal{Socket: "/missing", Target: "worker-r:0"}, Activation: &SSHActivation{Type: "ssh", Host: "azula", Port: 2222, User: "remote"}}, {ID: "done", Prompt: "old prompt", State: "done", CWD: "/w/b", UpdatedAt: now, Settlement: &Settlement{State: "done", Verdict: "All tests passed with a deliberately long explanation that gets clipped for the row"}}, {ID: "expired", State: "done", UpdatedAt: now.Add(-25 * time.Hour)}})
	root := s.project()
	var local, remote, done *Node
	for _, b := range kids(root) {
		for i := range kids(b) {
			n := kids(b)[i]
			switch n.ID {
			case "job:local":
				local = &n
			case "job:remote":
				remote = &n
			case "job:done":
				done = &n
			case "job:expired":
				t.Fatal("expired settlement rendered")
			}
		}
	}
	if local == nil || local.Activation == nil || local.Activation.Socket != "/live.sock" || local.Activation.Session != "worker-local" {
		t.Fatalf("local=%+v", local)
	}
	if remote == nil || remote.Activation != nil || remote.Status != "running" || !strings.Contains(remote.Label, "ssh remote@azula:2222") {
		t.Fatalf("remote=%+v", remote)
	}
	if done == nil || !strings.HasPrefix(done.Label, "All tests passed") || done.Status != "done" {
		t.Fatalf("done=%+v", done)
	}
}
func findJob(root Node, id string) *Node {
	for _, b := range kids(root) {
		for i := range kids(b) {
			n := kids(b)[i]
			if n.ID == id {
				return &n
			}
		}
	}
	return nil
}

// Golems for one project/repository must share ONE sidebar group regardless of
// worktree; the worktree survives as a per-row suffix so rows stay
// distinguishable.
func TestGroupsByProjectAcrossWorktrees(t *testing.T) {
	c, _ := NewClient("http://127.0.0.1:1", "")
	s := New(c, "")
	now := time.Now()
	s.now = func() time.Time { return now }
	s.SetSocketProbe(liveSockets(nil))
	s.replace([]Job{
		{ID: "a", Prompt: "one", State: "running", UpdatedAt: now, Workspace: &Workspace{Project: "familiar", Worktree: "wt-alpha"}},
		{ID: "b", Prompt: "two", State: "running", UpdatedAt: now.Add(-time.Second), Workspace: &Workspace{Project: "familiar", Worktree: "wt-beta"}},
		{ID: "c", Prompt: "three", State: "running", UpdatedAt: now.Add(-2 * time.Second), Workspace: &Workspace{Repo: "https://example.com/org/golem.git", Ref: "main", Worktree: "wt-gamma"}},
	})
	root := s.project()
	branches := map[string]int{}
	for _, b := range kids(root) {
		branches[b.Label] = len(kids(b))
	}
	if branches["familiar"] != 2 {
		t.Fatalf("project worktrees not grouped together: %+v", branches)
	}
	if branches["golem"] != 1 {
		t.Fatalf("repo URL not reduced to repository name: %+v", branches)
	}
	if len(branches) != 2 {
		t.Fatalf("expected exactly two groups, got %+v", branches)
	}
	a := findJob(root, "job:a")
	if a == nil || !strings.Contains(a.Label, "wt-alpha") {
		t.Fatalf("worktree tag missing from row label: %+v", a)
	}
	b := findJob(root, "job:b")
	if b == nil || !strings.Contains(b.Label, "wt-beta") {
		t.Fatalf("worktree tag missing from row label: %+v", b)
	}
}

func TestRepoNameReduction(t *testing.T) {
	for in, want := range map[string]string{
		"https://github.com/org/repo.git": "repo",
		"git@github.com:org/repo.git":     "repo",
		"/srv/git/repo":                   "repo",
		"repo.git":                        "repo",
		"repo":                            "repo",
	} {
		if got := repoName(in); got != want {
			t.Fatalf("repoName(%q) = %q, want %q", in, got, want)
		}
	}
}

// A worktree named identically to its group label gets no redundant suffix.
func TestWorktreeTagOmittedWhenSameAsGroup(t *testing.T) {
	c, _ := NewClient("http://127.0.0.1:1", "")
	s := New(c, "")
	now := time.Now()
	s.now = func() time.Time { return now }
	s.SetSocketProbe(liveSockets(nil))
	s.replace([]Job{{ID: "j", Prompt: "task", State: "running", UpdatedAt: now, Workspace: &Workspace{Project: "familiar", Worktree: "familiar"}}})
	n := findJob(s.project(), "job:j")
	if n == nil || strings.Contains(n.Label, "·") {
		t.Fatalf("redundant worktree tag rendered: %+v", n)
	}
}

// A settled job whose exact tmux session is still retained must keep terminal
// activation so the viewer can show it as clickable, and it must drop that
// activation the instant the exact session is reaped.
func TestSettledRetainedActivatesAndDropsOnReap(t *testing.T) {
	c, _ := NewClient("http://127.0.0.1:1", "")
	s := New(c, "")
	now := time.Now()
	s.now = func() time.Time { return now }
	live := true
	s.SetSocketProbe(func(socket string) (map[string]bool, error) {
		// Exact target only: normalized session on the per-job socket.
		if socket != "/live.sock" || !live {
			return nil, nil
		}
		return map[string]bool{"worker-settled": true}, nil
	})
	job := Job{ID: "settled", Prompt: "finished task", State: "done", CWD: "/w/a", UpdatedAt: now, Terminal: &Terminal{Socket: "/live.sock", Target: "worker-settled:0.0"}, Settlement: &Settlement{State: "done", Verdict: "done ok"}}
	s.replace([]Job{job})

	n := findJob(s.project(), "job:settled")
	if n == nil || n.Activation == nil {
		t.Fatalf("retained settled job must activate: %+v", n)
	}
	if n.Activation.Session != "worker-settled" || n.Activation.Socket != "/live.sock" {
		t.Fatalf("exact target not preserved: %+v", n.Activation)
	}
	if n.Status != "done" {
		t.Fatalf("state must remain settled: %+v", n)
	}

	// Reap the session: activation must vanish so the viewer's terminal-row
	// policy can drop the row.
	live = false
	n = findJob(s.project(), "job:settled")
	if n == nil || n.Activation != nil {
		t.Fatalf("reaped settled job must lose activation: %+v", n)
	}
}

// A settled job with the wrong exact target (session mismatch) must not
// activate even though the socket has live sessions. Exact set membership, not
// prefix, decides.
func TestExactTargetRequiredForActivation(t *testing.T) {
	c, _ := NewClient("http://127.0.0.1:1", "")
	s := New(c, "")
	now := time.Now()
	s.now = func() time.Time { return now }
	s.SetSocketProbe(liveSockets(map[string][]string{"/live.sock": {"worker-real"}}))
	s.replace([]Job{{ID: "j", Prompt: "p", State: "done", CWD: "/w/a", UpdatedAt: now, Terminal: &Terminal{Socket: "/live.sock", Target: "worker-other:0.0"}}})
	n := findJob(s.project(), "job:j")
	if n == nil || n.Activation != nil {
		t.Fatalf("mismatched session must not activate: %+v", n)
	}
}

// Many jobs sharing one socket trigger exactly one list-sessions snapshot per
// projection — no process per row.
func TestSingleProbePerSocketForManyJobs(t *testing.T) {
	c, _ := NewClient("http://127.0.0.1:1", "")
	s := New(c, "")
	now := time.Now()
	s.now = func() time.Time { return now }
	calls := map[string]int{}
	s.SetSocketProbe(func(socket string) (map[string]bool, error) {
		calls[socket]++
		if socket == "/a.sock" {
			return map[string]bool{"worker-1": true, "worker-2": true, "worker-3": true}, nil
		}
		return map[string]bool{"worker-4": true}, nil
	})
	jobs := []Job{
		{ID: "1", Prompt: "p", State: "running", CWD: "/w/a", UpdatedAt: now, Terminal: &Terminal{Socket: "/a.sock", Target: "worker-1:0.0"}},
		{ID: "2", Prompt: "p", State: "running", CWD: "/w/a", UpdatedAt: now, Terminal: &Terminal{Socket: "/a.sock", Target: "worker-2:0.0"}},
		{ID: "3", Prompt: "p", State: "done", CWD: "/w/a", UpdatedAt: now, Terminal: &Terminal{Socket: "/a.sock", Target: "worker-3:0.0"}},
		{ID: "4", Prompt: "p", State: "running", CWD: "/w/b", UpdatedAt: now, Terminal: &Terminal{Socket: "/b.sock", Target: "worker-4:0.0"}},
	}
	s.replace(jobs)
	root := s.project()
	if calls["/a.sock"] != 1 || calls["/b.sock"] != 1 {
		t.Fatalf("expected exactly one probe per unique socket, got %+v", calls)
	}
	for _, id := range []string{"job:1", "job:2", "job:3", "job:4"} {
		if n := findJob(root, id); n == nil || n.Activation == nil {
			t.Fatalf("job %s should be activated by its shared-socket snapshot: %+v", id, n)
		}
	}
}

// project() must not run any external probe while holding s.mu, so a concurrent
// update() (which takes s.mu) is never blocked behind a slow tmux snapshot.
func TestProjectDoesNotHoldLockDuringProbe(t *testing.T) {
	c, _ := NewClient("http://127.0.0.1:1", "")
	s := New(c, "")
	now := time.Now()
	s.now = func() time.Time { return now }
	enter := make(chan struct{})
	release := make(chan struct{})
	s.SetSocketProbe(func(socket string) (map[string]bool, error) {
		close(enter)
		<-release // block inside the probe
		return map[string]bool{"worker-x": true}, nil
	})
	s.replace([]Job{{ID: "j", Prompt: "p", State: "running", CWD: "/w/a", UpdatedAt: now, Terminal: &Terminal{Socket: "/live.sock", Target: "worker-x:0.0"}}})
	done := make(chan struct{})
	go func() { s.project(); close(done) }()
	<-enter // projection is now inside the blocked probe
	// s.mu must be free: an update proceeds without waiting for the probe.
	updated := make(chan struct{})
	go func() {
		s.update(Job{ID: "j2", Prompt: "q", State: "running", CWD: "/w/a", UpdatedAt: now})
		close(updated)
	}()
	select {
	case <-updated:
	case <-time.After(2 * time.Second):
		t.Fatal("update() blocked behind probe: project() held s.mu during external probe")
	}
	close(release)
	<-done
}

// A diagnosable tmux failure (permission denied) is logged at most once per
// socket per minute, so frequent projection cannot flood the log. The global
// logger writer is saved and restored to keep the package logger clean.
func TestTmuxProblemLoggedOncePerMinute(t *testing.T) {
	c, _ := NewClient("http://127.0.0.1:1", "")
	s := New(c, "")
	base := time.Now()
	cur := base
	s.now = func() time.Time { return cur }
	s.SetSocketProbe(func(socket string) (map[string]bool, error) {
		return nil, fmt.Errorf("permission denied")
	})
	oldOut := log.Writer()
	oldFlags := log.Flags()
	oldPrefix := log.Prefix()
	var buf strings.Builder
	log.SetOutput(&buf)
	defer func() {
		log.SetOutput(oldOut)
		log.SetFlags(oldFlags)
		log.SetPrefix(oldPrefix)
	}()
	job := Job{ID: "j", Prompt: "p", State: "running", CWD: "/w/a", UpdatedAt: base, Terminal: &Terminal{Socket: "/live.sock", Target: "worker-x:0.0"}}
	s.replace([]Job{job})
	s.project()
	s.project()
	if got := strings.Count(buf.String(), "tmux liveness check failed"); got != 1 {
		t.Fatalf("expected 1 log within the minute, got %d: %q", got, buf.String())
	}
	cur = base.Add(2 * time.Minute)
	s.project()
	if got := strings.Count(buf.String(), "tmux liveness check failed"); got != 2 {
		t.Fatalf("expected a second log after the window, got %d", got)
	}
}

func TestRetireActionDeletesOnlySettledJobs(t *testing.T) {
	deleted := []string{}
	mux := http.NewServeMux()
	mux.HandleFunc("DELETE /v1/jobs/{id}", func(w http.ResponseWriter, r *http.Request) {
		deleted = append(deleted, r.PathValue("id"))
		w.WriteHeader(http.StatusNoContent)
	})
	stub := httptest.NewServer(mux)
	defer stub.Close()
	c, _ := NewClient(stub.URL, "")
	s := New(c, "")
	now := time.Now()
	s.replace([]Job{
		{ID: "running", State: "running", UpdatedAt: now},
		{ID: "blocked", State: "blocked", UpdatedAt: now},
		{ID: "done", State: "done", UpdatedAt: now},
		{ID: "failed", State: "failed", UpdatedAt: now},
	})
	root := s.project()
	foundAction := false
	for _, n := range kids(root) {
		if n.Activation != nil && n.Activation.Type == "action" {
			foundAction = n.Label == "Retire Golems"
		}
	}
	if !foundAction {
		t.Fatal("settled jobs must advertise Retire Golems")
	}
	rr := httptest.NewRecorder()
	s.Handler().ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/v1/action/retire-settled", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("action: %d %s", rr.Code, rr.Body.String())
	}
	if strings.Join(deleted, ",") != "done,failed" {
		t.Fatalf("deleted %v", deleted)
	}
	if s.jobs["running"].State != "running" || s.jobs["blocked"].State != "blocked" {
		t.Fatal("active jobs were affected")
	}
	if findJob(s.project(), "job:done") != nil {
		t.Fatal("retired job remains projected")
	}
}

func TestSSERefreshesRenderFromFakeGolemd(t *testing.T) {
	now := time.Now().UTC()
	calls := make(chan struct{}, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/jobs", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "[]") })
	mux.HandleFunc("GET /v1/events", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, `data: {"seq":7,"kind":"job.state","job_id":"j1","state":"blocked"}

`)
	})
	mux.HandleFunc("GET /v1/jobs/j1", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(Job{ID: "j1", Prompt: "question job", State: "blocked", CWD: "/w/demo", UpdatedAt: now, Question: &Question{Prompt: "Which option?"}})
		select {
		case calls <- struct{}{}:
		default:
		}
	})
	stub := httptest.NewServer(mux)
	defer stub.Close()
	c, _ := NewClient(stub.URL, "")
	s := New(c, "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	select {
	case <-calls:
	case <-time.After(2 * time.Second):
		t.Fatal("event did not trigger job fetch")
	}
	var d Document
	deadline := time.Now().Add(2 * time.Second)
	for {
		rr := httptest.NewRecorder()
		s.Handler().ServeHTTP(rr, httptest.NewRequest("GET", "/v1/render", nil))
		if e := json.Unmarshal(rr.Body.Bytes(), &d); e != nil {
			t.Fatal(e)
		}
		if len(kids(d.Content)) > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("job fetch was not committed to render")
		}
		time.Sleep(time.Millisecond)
	}
	item := kids(kids(d.Content)[0])[0]
	if item.Status != "blocked" || !strings.Contains(item.Label, "Which option?") || d.RenderAPI != 1 || d.Target != "left-nav" {
		t.Fatalf("doc=%+v item=%+v", d, item)
	}
	body, _ := json.Marshal(d)
	if strings.Contains(string(body), `"Kind"`) || !strings.Contains(string(body), `"kind":"tree"`) {
		t.Fatalf("render keys are not API-1 shape: %s", body)
	}
}
