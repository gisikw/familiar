package render

import (
	"context"
	"encoding/json"
	"fmt"
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
	s.SetSocketCheck(func(p string) bool { return p == "/live.sock" })
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
