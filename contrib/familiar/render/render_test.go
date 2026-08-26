package render

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
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
func TestProjectionActivationSettlementAndRemoteNote(t *testing.T) {
	c, _ := NewClient("http://127.0.0.1:1", "")
	s := New(c, "")
	s.SetSessionCheck(func(socket, sess string) (bool, error) {
		return socket == "/live.sock" && sess == "worker-local", nil
	})
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

// A settled job whose exact tmux session is still retained must keep terminal
// activation so the viewer can show it as clickable, and it must drop that
// activation the instant the exact session is reaped.
func TestSettledRetainedActivatesAndDropsOnReap(t *testing.T) {
	c, _ := NewClient("http://127.0.0.1:1", "")
	s := New(c, "")
	now := time.Now()
	s.now = func() time.Time { return now }
	live := true
	s.SetSessionCheck(func(socket, sess string) (bool, error) {
		// Exact target only: normalized session, per-job socket.
		if socket != "/live.sock" || sess != "worker-settled" {
			return false, nil
		}
		return live, nil
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
// activate even though the socket exists.
func TestExactTargetRequiredForActivation(t *testing.T) {
	c, _ := NewClient("http://127.0.0.1:1", "")
	s := New(c, "")
	now := time.Now()
	s.now = func() time.Time { return now }
	s.SetSessionCheck(func(socket, sess string) (bool, error) {
		return socket == "/live.sock" && sess == "worker-real", nil
	})
	s.replace([]Job{{ID: "j", Prompt: "p", State: "done", CWD: "/w/a", UpdatedAt: now, Terminal: &Terminal{Socket: "/live.sock", Target: "worker-other:0.0"}}})
	n := findJob(s.project(), "job:j")
	if n == nil || n.Activation != nil {
		t.Fatalf("mismatched session must not activate: %+v", n)
	}
}

// A diagnosable tmux failure (permission denied) is logged at most once per
// socket per minute, so frequent projection cannot flood the log.
func TestTmuxProblemLoggedOncePerMinute(t *testing.T) {
	c, _ := NewClient("http://127.0.0.1:1", "")
	s := New(c, "")
	base := time.Now()
	cur := base
	s.now = func() time.Time { return cur }
	s.SetSessionCheck(func(socket, sess string) (bool, error) {
		return false, fmt.Errorf("permission denied")
	})
	var buf strings.Builder
	log.SetOutput(&buf)
	defer log.SetOutput(io.Discard)
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
