package render

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"
)

const settledAge = 24 * time.Hour

type Terminal struct {
	Host   string `json:"host"`
	Socket string `json:"socket"`
	Target string `json:"target"`
}
type SSHActivation struct {
	Type string `json:"type"`
	Host string `json:"host"`
	Port int    `json:"port"`
	User string `json:"user"`
}
type Settlement struct {
	State, Verdict string
	Artifacts      []Artifact `json:"artifacts,omitempty"`
	Worktree       *Worktree  `json:"worktree,omitempty"`
}
type Artifact struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}
type Worktree struct {
	Name, Head string
	Dirty      bool
}
type Question struct {
	Prompt  string   `json:"prompt"`
	Options []string `json:"options,omitempty"`
}
type Workspace struct {
	Project  string `json:"project"`
	Repo     string `json:"repo"`
	Ref      string `json:"ref"`
	Worktree string `json:"worktree"`
	Path     string `json:"path"`
}
type Job struct {
	ID         string         `json:"id"`
	Harness    string         `json:"harness"`
	Model      string         `json:"model"`
	CWD        string         `json:"cwd"`
	Prompt     string         `json:"prompt"`
	Host       string         `json:"host"`
	State      string         `json:"state"`
	Workspace  *Workspace     `json:"workspace,omitempty"`
	Question   *Question      `json:"question,omitempty"`
	Terminal   *Terminal      `json:"terminal,omitempty"`
	Activation *SSHActivation `json:"activation,omitempty"`
	Settlement *Settlement    `json:"settlement,omitempty"`
	CreatedAt  time.Time      `json:"created_at"`
	UpdatedAt  time.Time      `json:"updated_at"`
}
type Event struct {
	Seq      int64     `json:"seq"`
	Kind     string    `json:"kind"`
	JobID    string    `json:"job_id"`
	State    string    `json:"state"`
	Question *Question `json:"question,omitempty"`
}
type Activation struct {
	Type    string `json:"type"`
	Socket  string `json:"socket"`
	Session string `json:"session"`
}
type Node struct {
	Kind       string      `json:"kind"`
	ID         string      `json:"id"`
	Label      string      `json:"label,omitempty"`
	Status     string      `json:"status,omitempty"`
	Children   *[]Node     `json:"children,omitempty"`
	Activation *Activation `json:"activation,omitempty"`
}
type Document struct {
	RenderAPI int    `json:"render_api"`
	Revision  uint64 `json:"revision"`
	TTL       int64  `json:"ttl_ms"`
	Target    string `json:"target"`
	Content   Node   `json:"content"`
}

type Client struct {
	base, token string
	http        *http.Client
}

func NewClient(endpoint, token string) (*Client, error) {
	c := &Client{base: strings.TrimRight(endpoint, "/"), token: token, http: &http.Client{}}
	if strings.HasPrefix(endpoint, "unix://") {
		path := strings.TrimPrefix(endpoint, "unix://")
		if path == "" {
			return nil, fmt.Errorf("empty unix socket")
		}
		c.base = "http://unix"
		c.http.Transport = &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", path)
		}}
	}
	if !strings.HasPrefix(c.base, "http://") && !strings.HasPrefix(c.base, "https://") {
		return nil, fmt.Errorf("GOLEM_ENDPOINT must be http(s):// or unix://")
	}
	return c, nil
}
func (c *Client) request(ctx context.Context, method, path string, out any) error {
	req, _ := http.NewRequestWithContext(ctx, method, c.base+path, nil)
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return fmt.Errorf("golemd %s: %s", res.Status, strings.TrimSpace(string(b)))
	}
	return json.NewDecoder(res.Body).Decode(out)
}
func (c *Client) List(ctx context.Context) ([]Job, error) {
	var jobs []Job
	err := c.request(ctx, "GET", "/v1/jobs", &jobs)
	return jobs, err
}
func (c *Client) Job(ctx context.Context, id string) (Job, error) {
	var j Job
	err := c.request(ctx, "GET", "/v1/jobs/"+url.PathEscape(id), &j)
	return j, err
}
func (c *Client) Stream(ctx context.Context, since int64, receive func(Event)) error {
	req, _ := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("%s/v1/events?since=%d", c.base, since), nil)
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("SSE returned %s", res.Status)
	}
	scan := bufio.NewScanner(res.Body)
	scan.Buffer(make([]byte, 4096), 1<<20)
	for scan.Scan() {
		line := scan.Text()
		if strings.HasPrefix(line, "data: ") {
			var e Event
			if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &e) == nil {
				receive(e)
			}
		}
	}
	return scan.Err()
}

// sessionProbe reports whether the exact tmux target is live on the local
// server. problem is non-nil only for diagnosable failures (permission denied,
// tmux missing) — not for the ordinary "session absent / server gone" case,
// which is reported as live=false, problem=nil.
type sessionProbe func(socket, session string) (live bool, problem error)

type Server struct {
	client      *Client
	sessionLive sessionProbe
	invalidate  string
	mu          sync.Mutex
	jobs        map[string]Job
	revision    uint64
	cacheFresh  bool
	now         func() time.Time
	problemMu   sync.Mutex
	problemSeen map[string]time.Time
}

func New(c *Client, invalidate string) *Server {
	return &Server{client: c, invalidate: invalidate, jobs: map[string]Job{}, revision: 1, now: time.Now, sessionLive: tmuxHasSession, problemSeen: map[string]time.Time{}}
}

// SetSessionCheck overrides the tmux liveness probe (tests inject a stub).
func (s *Server) SetSessionCheck(f sessionProbe) { s.sessionLive = f }

// tmuxHasSession verifies the exact tmux session on a per-job local socket via
// `tmux -S <socket> has-session -t =<session>`. The `=` forces exact-name
// matching so a prefix collision cannot masquerade as a live target. A missing
// server or unknown session is a normal negative; only permission/tooling
// failures surface as a problem to diagnose.
func tmuxHasSession(socket, session string) (bool, error) {
	if socket == "" || session == "" {
		return false, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "tmux", "-S", socket, "has-session", "-t", "="+session)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		return true, nil
	}
	msg := strings.ToLower(stderr.String())
	// tmux exits non-zero for a missing session or absent server; those are the
	// expected steady-state negatives, not problems.
	if strings.Contains(msg, "permission denied") || strings.Contains(msg, "access") {
		return false, fmt.Errorf("tmux -S %s: %s", socket, strings.TrimSpace(stderr.String()))
	}
	if _, ok := err.(*exec.Error); ok {
		// tmux binary not found / not executable.
		return false, fmt.Errorf("tmux unavailable: %w", err)
	}
	return false, nil
}

// logProblem records a tmux probe failure at most once per socket per minute so
// frequent polling cannot flood the log while a fault (e.g. permission denied)
// stays diagnosable.
func (s *Server) logProblem(socket string, err error) {
	if err == nil {
		return
	}
	s.problemMu.Lock()
	last, seen := s.problemSeen[socket]
	now := s.now()
	if !seen || now.Sub(last) > time.Minute {
		s.problemSeen[socket] = now
		s.problemMu.Unlock()
		log.Printf("golem-render: tmux liveness check failed: %v", err)
		return
	}
	s.problemMu.Unlock()
}
func terminalState(x string) bool {
	return x == "done" || x == "failed" || x == "cancelled" || x == "timeout"
}
func session(target string) string {
	if i := strings.IndexByte(target, ':'); i >= 0 {
		return target[:i]
	}
	return target
}
func brief(j Job) string {
	p := strings.Join(strings.Fields(j.Prompt), " ")
	if j.Settlement != nil && j.Settlement.Verdict != "" {
		p = strings.Join(strings.Fields(j.Settlement.Verdict), " ")
	}
	r := []rune(p)
	if len(r) > 48 {
		p = string(r[:48]) + "…"
	}
	if p == "" {
		p = j.ID
	}
	return p
}
func branch(j Job) string {
	if j.Workspace != nil {
		if j.Workspace.Project != "" {
			return j.Workspace.Project
		}
		if j.Workspace.Worktree != "" {
			return j.Workspace.Worktree
		}
	}
	x := strings.TrimRight(j.CWD, "/")
	if i := strings.LastIndexByte(x, '/'); i >= 0 {
		x = x[i+1:]
	}
	if x == "" {
		return "unknown"
	}
	return x
}
func (s *Server) project() Node {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	jobs := make([]Job, 0, len(s.jobs))
	for _, j := range s.jobs {
		if terminalState(j.State) && now.Sub(j.UpdatedAt) > settledAge {
			continue
		}
		jobs = append(jobs, j)
	}
	sort.Slice(jobs, func(i, k int) bool { return jobs[i].UpdatedAt.After(jobs[k].UpdatedAt) })
	if len(jobs) > 20 {
		jobs = jobs[:20]
	}
	groups := map[string][]Node{}
	for _, j := range jobs {
		label := brief(j)
		if j.State == "blocked" && j.Question != nil {
			label += " — " + brief(Job{Prompt: j.Question.Prompt})
		}
		n := Node{Kind: "item", ID: "job:" + j.ID, Label: label, Status: j.State}
		// A live local tmux session activates any job — running or settled. Golem
		// retains a settled tmux session for its linger window, so a settled row
		// stays attachable until the exact session is reaped. Only the exact
		// target counts, verified per job.
		live := false
		if j.Terminal != nil && j.Terminal.Socket != "" && j.Terminal.Target != "" {
			sess := session(j.Terminal.Target)
			ok, problem := s.sessionLive(j.Terminal.Socket, sess)
			s.logProblem(j.Terminal.Socket, problem)
			if ok {
				live = true
				n.Activation = &Activation{Type: "terminal", Socket: j.Terminal.Socket, Session: sess}
			}
		}
		if !live && !terminalState(j.State) && j.Activation != nil && j.Activation.Type == "ssh" {
			n.Label += fmt.Sprintf(" [ssh %s@%s:%d; use golem attach]", j.Activation.User, j.Activation.Host, j.Activation.Port)
		}
		groups[branch(j)] = append(groups[branch(j)], n)
	}
	names := make([]string, 0, len(groups))
	for x := range groups {
		names = append(names, x)
	}
	sort.Strings(names)
	kids := []Node{}
	for _, x := range names {
		v := groups[x]
		kids = append(kids, Node{Kind: "branch", ID: "workspace:" + x, Label: x, Children: &v})
	}
	return Node{Kind: "tree", ID: "golem:jobs", Label: "agents", Children: &kids}
}
func (s *Server) replace(jobs []Job) {
	s.mu.Lock()
	changed := len(jobs) != len(s.jobs)
	next := map[string]Job{}
	for _, j := range jobs {
		next[j.ID] = j
		b, _ := json.Marshal(j)
		a, _ := json.Marshal(s.jobs[j.ID])
		changed = changed || !bytes.Equal(a, b)
	}
	if changed {
		s.jobs = next
		s.revision++
	}
	fresh := s.cacheFresh
	if changed {
		s.cacheFresh = false
	}
	s.mu.Unlock()
	if changed && fresh {
		s.poke()
	}
}
func (s *Server) update(j Job) {
	s.mu.Lock()
	a, _ := json.Marshal(s.jobs[j.ID])
	b, _ := json.Marshal(j)
	changed := !bytes.Equal(a, b)
	if changed {
		s.jobs[j.ID] = j
		s.revision++
	}
	fresh := s.cacheFresh
	if changed {
		s.cacheFresh = false
	}
	s.mu.Unlock()
	if changed && fresh {
		s.poke()
	}
}
func (s *Server) poke() {
	if s.invalidate == "" {
		return
	}
	req, _ := http.NewRequest("POST", s.invalidate, http.NoBody)
	res, e := (&http.Client{Timeout: 2 * time.Second}).Do(req)
	if e == nil {
		res.Body.Close()
	}
}
func (s *Server) Refresh(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	j, e := s.client.List(ctx)
	if e == nil {
		s.replace(j)
	}
	return e
}
func (s *Server) Run(ctx context.Context) {
	_ = s.Refresh(ctx)
	since := int64(0)
	fail := 0
	for ctx.Err() == nil {
		_ = s.client.Stream(ctx, since, func(e Event) {
			if e.Seq > since {
				since = e.Seq
			}
			fetchCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			if j, x := s.client.Job(fetchCtx, e.JobID); x == nil {
				s.update(j)
			}
		})
		if ctx.Err() != nil {
			return
		}
		// Any stream return is a disconnect; a healthy SSE request remains open.
		fail++
		if fail >= 3 {
			_ = s.Refresh(ctx)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Duration(min(fail+1, 5)) * time.Second):
		}
	}
}
func (s *Server) Handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /live", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})
	m.HandleFunc("GET /v1/render", func(w http.ResponseWriter, r *http.Request) {
		root := s.project()
		s.mu.Lock()
		d := Document{1, s.revision, 30000, "left-nav", root}
		s.cacheFresh = true
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(d)
	})
	return m
}
