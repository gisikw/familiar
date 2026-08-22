package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"
)

type ChildStatus struct {
	Name     string `json:"name"`
	State    string `json:"state"`
	PID      int    `json:"pid"`
	Restarts int    `json:"restarts"`
	LastExit string `json:"last_exit,omitempty"`
	Ready    bool   `json:"ready"`
	Required bool   `json:"required"`
}

type child struct {
	cfg                                    ChildConfig
	sup                                    *Supervisor
	mu                                     sync.Mutex
	state                                  string
	proc                                   *exec.Cmd
	ready                                  bool
	restarts                               int
	lastExit                               string
	manualStop, shuttingDown, forceRestart bool
	readinessLost, dependencyFailed        bool
	becameReady                            bool
	probeSuccesses, probeFailures          int
	history                                []time.Time
	wake                                   chan struct{}
	done                                   chan struct{}
}

type Supervisor struct {
	cfg       Config
	log       *slog.Logger
	ctx       context.Context
	cancel    context.CancelFunc
	children  map[string]*child
	closeOnce sync.Once
	stopHook  func(string) // tests observe deterministic shutdown ordering
}

func New(cfg Config, logger *slog.Logger) (*Supervisor, error) {
	if err := ValidateConfig(cfg); err != nil {
		return nil, err
	}
	if logger == nil {
		logger = slog.Default()
	}
	if err := os.MkdirAll(cfg.StateDir, 0700); err != nil {
		return nil, err
	}
	_ = os.Chmod(cfg.StateDir, 0700)
	ctx, cancel := context.WithCancel(context.Background())
	s := &Supervisor{cfg: cfg, log: logger, ctx: ctx, cancel: cancel, children: map[string]*child{}}
	for _, cc := range cfg.Children {
		x := &child{cfg: cc, sup: s, state: "waiting", wake: make(chan struct{}, 1), done: make(chan struct{})}
		s.children[cc.Name] = x
	}
	return s, nil
}

func (s *Supervisor) Start() {
	for _, c := range s.children {
		go c.run()
		go c.probeLoop()
	}
}
func (c *child) setState(st string) {
	c.mu.Lock()
	c.state = st
	if st != "running" {
		c.ready = false
	}
	c.mu.Unlock()
}
func (c *child) status() ChildStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	pid := 0
	if c.proc != nil && c.proc.Process != nil {
		pid = c.proc.Process.Pid
	}
	return ChildStatus{Name: c.cfg.Name, State: c.state, PID: pid, Restarts: c.restarts, LastExit: c.lastExit, Ready: c.ready, Required: c.cfg.Required}
}
func (s *Supervisor) Status() []ChildStatus {
	r := make([]ChildStatus, 0, len(s.children))
	for _, c := range s.children {
		r = append(r, c.status())
	}
	sort.Slice(r, func(i, j int) bool { return r[i].Name < r[j].Name })
	return r
}
func (s *Supervisor) Statuses() map[string]ChildStatus {
	out := make(map[string]ChildStatus, len(s.children))
	for name, c := range s.children {
		out[name] = c.status()
	}
	return out
}
func (s *Supervisor) Ready() bool {
	for _, c := range s.children {
		st := c.status()
		if st.Required && !st.Ready {
			return false
		}
	}
	return true
}

func (c *child) dependenciesReady() bool {
	for _, n := range c.cfg.DependsOn {
		if !c.sup.children[n].status().Ready {
			return false
		}
	}
	return true
}

func (c *child) waitDependencies() bool {
	if len(c.cfg.DependsOn) == 0 {
		return true
	}
	c.setState("waiting")
	deadline := time.NewTimer(c.cfg.DependencyTimeout.Value())
	defer deadline.Stop()
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for {
		if c.dependenciesReady() {
			c.mu.Lock()
			c.dependencyFailed = false
			c.mu.Unlock()
			return true
		}
		select {
		case <-c.sup.ctx.Done():
			return false
		case <-c.wake:
			c.mu.Lock()
			stop := c.shuttingDown || c.manualStop
			c.mu.Unlock()
			if stop {
				return false
			}
		case <-deadline.C:
			c.mu.Lock()
			c.dependencyFailed = true
			c.ready = false
			if c.cfg.DependencyTimeoutPolicy == "fail-child" {
				c.state = "dependency-failed"
			}
			c.mu.Unlock()
			c.sup.log.Warn("dependency wait timed out", "child", c.cfg.Name, "dependencies", strings.Join(c.cfg.DependsOn, ","), "policy", c.cfg.DependencyTimeoutPolicy)
			if c.cfg.DependencyTimeoutPolicy == "start-degraded" {
				return true
			}
			// A failed dependency gates this child, but recovery remains automatic.
			deadline.Reset(c.cfg.DependencyTimeout.Value())
		case <-tick.C:
		}
	}
}
func (c *child) run() {
	defer close(c.done)
	attempt := 0
	for {
		c.mu.Lock()
		stop := c.shuttingDown
		manual := c.manualStop
		c.mu.Unlock()
		if stop {
			return
		}
		if manual {
			c.setState("stopped")
			select {
			case <-c.sup.ctx.Done():
				return
			case <-c.wake:
				continue
			}
		}
		if !c.waitDependencies() {
			continue
		}
		c.setState("starting")
		logfile, err := openRollingLog(c.sup.cfg.StateDir, c.cfg.Name, c.sup.cfg.LogMaxBytes)
		if err != nil {
			c.failStart(err)
			return
		}
		cmd := exec.Command(c.cfg.Argv[0], c.cfg.Argv[1:]...)
		cmd.Dir = c.cfg.WorkingDir
		cmd.Env = mergedEnv(c.cfg.Env)
		cmd.Stdout = logfile
		cmd.Stderr = logfile
		configureChildProcess(cmd)
		err = cmd.Start()
		if err != nil {
			_ = logfile.Close()
			if !c.afterExit("start error: "+err.Error(), true, &attempt) && !c.waitForRestart() {
				return
			}
			continue
		}
		c.mu.Lock()
		c.proc = cmd
		c.state = "running"
		c.probeSuccesses = 0
		c.probeFailures = 0
		c.becameReady = false
		if c.cfg.Probe.Type == "none" {
			c.ready = !c.dependencyFailed
		}
		c.mu.Unlock()
		c.sup.log.Info("child started", "child", c.cfg.Name, "pid", cmd.Process.Pid)
		err = cmd.Wait()
		_ = logfile.Close()
		desc := exitDescription(cmd.ProcessState)
		failed := err != nil
		c.mu.Lock()
		c.proc = nil
		c.lastExit = desc
		shutdown := c.shuttingDown
		manual = c.manualStop
		force := c.forceRestart
		probeFailed := c.readinessLost
		c.forceRestart = false
		c.readinessLost = false
		c.mu.Unlock()
		if probeFailed {
			desc = "readiness probe failed"
			failed = true
		}
		c.sup.log.Info("child exited", "child", c.cfg.Name, "status", desc)
		if shutdown {
			return
		}
		if manual {
			continue
		}
		if c.cfg.Detached && !failed && !force {
			c.mu.Lock()
			c.state = "running"
			c.ready = c.cfg.Probe.Type == "none"
			c.mu.Unlock()
			select {
			case <-c.sup.ctx.Done():
				return
			case <-c.wake:
				c.mu.Lock()
				lost := c.readinessLost
				c.readinessLost = false
				c.mu.Unlock()
				if lost && !c.afterExit("readiness lost", true, &attempt) && !c.waitForRestart() {
					return
				}
				continue
			}
		}
		if force {
			attempt = 0
			continue
		}
		policy := c.cfg.Restart.Policy
		if policy == "never" || (policy == "on-failure" && !failed) {
			c.setState("stopped")
			if !c.waitForRestart() {
				return
			}
			continue
		}
		if !c.afterExit(desc, failed, &attempt) && !c.waitForRestart() {
			return
		}
	}
}
func (c *child) waitForRestart() bool {
	select {
	case <-c.sup.ctx.Done():
		return false
	case <-c.wake:
		c.mu.Lock()
		defer c.mu.Unlock()
		return !c.shuttingDown
	}
}
func mergedEnv(extra map[string]string) []string {
	values := make(map[string]string, len(os.Environ())+len(extra))
	for _, entry := range os.Environ() {
		if i := strings.IndexByte(entry, '='); i >= 0 {
			values[entry[:i]] = entry[i+1:]
		}
	}
	for k, v := range extra {
		values[k] = v
	}
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	env := make([]string, 0, len(keys))
	for _, k := range keys {
		env = append(env, k+"="+values[k])
	}
	return env
}
func (c *child) failStart(err error) {
	c.mu.Lock()
	c.lastExit = err.Error()
	c.state = "failed"
	c.mu.Unlock()
	c.sup.log.Error("child could not open log", "child", c.cfg.Name, "error", err)
}
func (c *child) afterExit(desc string, failed bool, attempt *int) bool {
	now := time.Now()
	cut := now.Add(-c.cfg.Restart.Window.Value())
	c.mu.Lock()
	c.history = append(c.history, now)
	i := 0
	for i < len(c.history) && c.history[i].Before(cut) {
		i++
	}
	c.history = append([]time.Time(nil), c.history[i:]...)
	if len(c.history) > c.cfg.Restart.MaxRestarts {
		c.state = "failed"
		c.ready = false
		c.lastExit = desc
		c.mu.Unlock()
		c.sup.log.Error("child restart circuit open", "child", c.cfg.Name, "restarts_in_window", len(c.history)-1)
		return false
	}
	c.restarts++
	c.state = "backoff"
	c.ready = false
	c.mu.Unlock()
	*attempt = *attempt + 1
	d, maximum := c.cfg.Restart.InitialBackoff.Value(), c.cfg.Restart.MaxBackoff.Value()
	for i := 1; i < *attempt && d < maximum; i++ {
		if d > maximum/2 {
			d = maximum
		} else {
			d *= 2
		}
	}
	if d > maximum {
		d = maximum
	}
	if j := c.cfg.Restart.Jitter; j > 0 {
		d = time.Duration(float64(d) * (1 - j + rand.Float64()*2*j))
	}
	c.sup.log.Warn("child restart scheduled", "child", c.cfg.Name, "backoff", d, "status", desc)
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-c.sup.ctx.Done():
		return false
	case <-c.wake:
		return true
	case <-t.C:
		return true
	}
}
func (c *child) probeLoop() {
	tick := time.NewTicker(c.cfg.Probe.Interval.Value())
	defer tick.Stop()
	for {
		select {
		case <-c.sup.ctx.Done():
			return
		case <-tick.C:
			st := c.status()
			if st.State != "running" {
				continue
			}
			ok := c.probe()
			depsReady := c.dependenciesReady()
			lost := false
			var proc *exec.Cmd
			c.mu.Lock()
			if c.state == "running" {
				c.dependencyFailed = !depsReady
				if ok {
					c.probeSuccesses++
					c.probeFailures = 0
					c.ready = depsReady && c.probeSuccesses >= c.cfg.Probe.SuccessThreshold
					if c.ready {
						c.becameReady = true
					}
				} else {
					c.probeSuccesses = 0
					c.probeFailures++
					c.ready = false
					// The failure threshold is liveness semantics: it only arms
					// once this process run has been ready at least once. A child
					// still booting (e.g. loading a multi-GB model) is not
					// "losing" readiness it never had; startup time is bounded by
					// the restart/backoff machinery only if the process exits.
					if c.becameReady && c.cfg.Probe.FailureThreshold > 0 && c.probeFailures >= c.cfg.Probe.FailureThreshold && !c.readinessLost {
						c.readinessLost = true
						lost = true
						proc = c.proc
					}
				}
			}
			c.mu.Unlock()
			if lost {
				c.sup.log.Warn("readiness failure threshold reached", "child", c.cfg.Name, "failures", c.cfg.Probe.FailureThreshold)
				if c.cfg.Detached || proc == nil {
					select {
					case c.wake <- struct{}{}:
					default:
					}
				} else {
					c.terminateAfterProbeFailure(proc)
				}
			}
		}
	}
}

func (c *child) terminateAfterProbeFailure(cmd *exec.Cmd) {
	signalProcessGroup(cmd, false)
	go func() {
		t := time.NewTimer(c.sup.cfg.ShutdownGrace.Value())
		defer t.Stop()
		select {
		case <-c.sup.ctx.Done():
			return
		case <-t.C:
			c.mu.Lock()
			stillRunning := c.proc == cmd
			c.mu.Unlock()
			if stillRunning {
				signalProcessGroup(cmd, true)
			}
		}
	}()
}
func (c *child) probe() bool {
	ctx, cancel := context.WithTimeout(c.sup.ctx, c.cfg.Probe.Timeout.Value())
	defer cancel()
	switch c.cfg.Probe.Type {
	case "none":
		return true
	case "http":
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, c.cfg.Probe.URL, nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return false
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return resp.StatusCode >= 200 && resp.StatusCode < 300
	case "exec":
		cmd := exec.CommandContext(ctx, c.cfg.Probe.Argv[0], c.cfg.Probe.Argv[1:]...)
		cmd.Dir = c.cfg.WorkingDir
		cmd.Env = mergedEnv(c.cfg.Env)
		cmd.Stdout = io.Discard
		cmd.Stderr = io.Discard
		configureChildProcess(cmd)
		err := cmd.Run()
		if ctx.Err() != nil && cmd.Process != nil {
			signalProcessGroup(cmd, true)
		}
		return err == nil
	}
	return false
}

func (s *Supervisor) Restart(name string) error {
	c, ok := s.children[name]
	if !ok {
		return errors.New("unknown child")
	}
	c.mu.Lock()
	c.manualStop = false
	c.shuttingDown = false
	c.history = nil
	p := c.proc
	c.forceRestart = p != nil
	c.mu.Unlock()
	if p != nil {
		signalProcessGroup(p, false)
	}
	select {
	case c.wake <- struct{}{}:
	default:
	}
	return nil
}
func (s *Supervisor) RestartChild(name string) error { return s.Restart(name) }
func (s *Supervisor) StopChild(name string) error {
	c, ok := s.children[name]
	if !ok {
		return errors.New("unknown child")
	}
	return s.stopOne(c, false, false)
}
func (s *Supervisor) stopOne(c *child, shutdown, preserve bool) error {
	if s.stopHook != nil {
		s.stopHook(c.cfg.Name)
	}
	c.mu.Lock()
	c.manualStop = !shutdown
	c.shuttingDown = shutdown
	p := c.proc
	c.ready = false
	if preserve {
		c.state = "preserved"
	}
	c.mu.Unlock()
	select {
	case c.wake <- struct{}{}:
	default:
	}
	if preserve {
		return nil
	}
	if p != nil {
		signalProcessGroup(p, false)
		timer := time.NewTimer(s.cfg.ShutdownGrace.Value())
		defer timer.Stop()
		for {
			c.mu.Lock()
			alive := c.proc == p
			c.mu.Unlock()
			if !alive {
				break
			}
			select {
			case <-timer.C:
				signalProcessGroup(p, true)
				goto stopped
			case <-time.After(10 * time.Millisecond):
			}
		}
	}
stopped:
	if c.cfg.Detached && len(c.cfg.StopArgv) > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), s.cfg.ShutdownGrace.Value())
		defer cancel()
		cmd := exec.CommandContext(ctx, c.cfg.StopArgv[0], c.cfg.StopArgv[1:]...)
		cmd.Dir = c.cfg.WorkingDir
		cmd.Env = mergedEnv(c.cfg.Env)
		configureChildProcess(cmd)
		if out, err := cmd.CombinedOutput(); err != nil {
			s.log.Warn("detached child stop failed", "child", c.cfg.Name, "error", err, "output", string(out))
		}
	}
	return nil
}
func (s *Supervisor) shutdownOrder() []*child {
	seen := map[string]bool{}
	var topo []*child
	var add func(string)
	add = func(n string) {
		if seen[n] {
			return
		}
		seen[n] = true
		for _, d := range s.children[n].cfg.DependsOn {
			add(d)
		}
		topo = append(topo, s.children[n])
	}
	names := make([]string, 0, len(s.children))
	for n := range s.children {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		add(n)
	}
	out := make([]*child, len(topo))
	for i := range topo {
		out[i] = topo[len(topo)-1-i]
	}
	return out
}
func (s *Supervisor) Close(ctx context.Context) error {
	var result error
	s.closeOnce.Do(func() {
		for _, c := range s.shutdownOrder() {
			preserve := c.cfg.Presence && !s.cfg.TeardownPresence
			if err := s.stopOne(c, true, preserve); err != nil && result == nil {
				result = err
			}
		}
		s.cancel()
		for _, c := range s.children {
			select {
			case <-c.done:
			case <-ctx.Done():
				if result == nil {
					result = ctx.Err()
				}
				return
			}
		}
	})
	return result
}
func (s *Supervisor) Shutdown(ctx context.Context) error { return s.Close(ctx) }
func (s *Supervisor) Child(name string) (ChildStatus, error) {
	c, ok := s.children[name]
	if !ok {
		return ChildStatus{}, fmt.Errorf("unknown child %q", name)
	}
	return c.status(), nil
}
