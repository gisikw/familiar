//go:build unix

package server

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testConfig(t *testing.T, cs ...ChildConfig) Config {
	t.Helper()
	c := DefaultConfig()
	c.StateDir = t.TempDir()
	c.ShutdownGrace = Duration(500 * time.Millisecond)
	c.LogMaxBytes = 4096
	c.Children = cs
	for i := range c.Children {
		applyChildDefaults(&c.Children[i])
		c.Children[i].Restart.Jitter = 0
	}
	return c
}
func testLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }
func startSupervisor(t *testing.T, c Config) *Supervisor {
	t.Helper()
	s, e := New(c, testLog())
	if e != nil {
		t.Fatal(e)
	}
	s.Start()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = s.Close(ctx)
	})
	return s
}
func waitFor(t *testing.T, d time.Duration, f func() bool) {
	t.Helper()
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		if f() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met before timeout")
}
func fakeChild(name, script string) ChildConfig {
	return ChildConfig{Name: name, Argv: []string{"/bin/sh", "-c", script}, Required: true, Probe: ProbeConfig{Type: "none", Interval: Duration(10 * time.Millisecond), Timeout: Duration(100 * time.Millisecond)}, Restart: RestartConfig{Policy: "on-failure", InitialBackoff: Duration(40 * time.Millisecond), MaxBackoff: Duration(80 * time.Millisecond), MaxRestarts: 2, Window: Duration(time.Second)}}
}

func TestRestartBackoffAndCircuitBreaker(t *testing.T) {
	for _, tc := range []struct {
		name  string
		max   int
		delay time.Duration
	}{{"two", 2, 40 * time.Millisecond}, {"one", 1, 80 * time.Millisecond}} {
		t.Run(tc.name, func(t *testing.T) {
			count := filepath.Join(t.TempDir(), "count")
			x := fakeChild("bad", "echo x >> '"+count+"'; exit 7")
			x.Restart.MaxRestarts = tc.max
			x.Restart.InitialBackoff = Duration(tc.delay)
			x.Restart.MaxBackoff = Duration(tc.delay)
			start := time.Now()
			s := startSupervisor(t, testConfig(t, x))
			waitFor(t, 2*time.Second, func() bool { st, _ := s.Child("bad"); return st.State == "failed" })
			st, _ := s.Child("bad")
			if st.Restarts != tc.max {
				t.Fatalf("restarts=%d want %d", st.Restarts, tc.max)
			}
			if time.Since(start) < tc.delay*time.Duration(tc.max) {
				t.Fatal("backoff not applied")
			}
			b, _ := os.ReadFile(count)
			if len(strings.Fields(string(b))) != tc.max+1 {
				t.Fatalf("starts=%q", b)
			}
		})
	}
}
func TestOneForOneIsolation(t *testing.T) {
	stable := fakeChild("stable", "sleep 30")
	bad := fakeChild("bad", "exit 3")
	bad.Restart.MaxRestarts = 1
	s := startSupervisor(t, testConfig(t, stable, bad))
	waitFor(t, time.Second, func() bool { st, _ := s.Child("stable"); return st.PID > 0 })
	before, _ := s.Child("stable")
	waitFor(t, time.Second, func() bool { st, _ := s.Child("bad"); return st.State == "failed" })
	after, _ := s.Child("stable")
	if before.PID != after.PID || after.State != "running" {
		t.Fatalf("sibling affected: %+v", after)
	}
}
func TestReadinessAggregation(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "ready")
	req := fakeChild("required", "sleep 30")
	req.Probe = ProbeConfig{Type: "exec", Argv: []string{"/bin/sh", "-c", "test -f '" + marker + "'"}, Interval: Duration(10 * time.Millisecond), Timeout: Duration(100 * time.Millisecond)}
	optional := fakeChild("optional", "sleep 30")
	optional.Required = false
	s := startSupervisor(t, testConfig(t, req, optional))
	time.Sleep(40 * time.Millisecond)
	if s.Ready() {
		t.Fatal("ready while required child unready")
	}
	_ = os.WriteFile(marker, []byte("x"), 0600)
	waitFor(t, time.Second, s.Ready)
}
func TestDependencyDelayAndTimeout(t *testing.T) {
	for _, tc := range []struct {
		name    string
		ready   bool
		minimum time.Duration
	}{{"ready", true, 60 * time.Millisecond}, {"timeout", false, 100 * time.Millisecond}} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			mark := filepath.Join(dir, "ready")
			started := filepath.Join(dir, "started")
			dep := fakeChild("dep", "sleep 30")
			dep.Probe = ProbeConfig{Type: "exec", Argv: []string{"/bin/sh", "-c", "test -f '" + mark + "'"}, Interval: Duration(10 * time.Millisecond), Timeout: Duration(50 * time.Millisecond)}
			consumer := fakeChild("consumer", "touch '"+started+"'; sleep 30")
			consumer.DependsOn = []string{"dep"}
			consumer.DependencyTimeout = Duration(120 * time.Millisecond)
			begin := time.Now()
			s := startSupervisor(t, testConfig(t, dep, consumer))
			_ = s
			if tc.ready {
				time.Sleep(70 * time.Millisecond)
				_ = os.WriteFile(mark, []byte("x"), 0600)
			}
			waitFor(t, time.Second, func() bool { _, e := os.Stat(started); return e == nil })
			if time.Since(begin) < tc.minimum {
				t.Fatal("dependent started too early")
			}
		})
	}
}
func TestGracefulShutdownReverseDependencyOrder(t *testing.T) {
	base := fakeChild("base", "sleep 30")
	top := fakeChild("top", "sleep 30")
	top.DependsOn = []string{"base"}
	s := startSupervisor(t, testConfig(t, base, top))
	var order []string
	s.stopHook = func(n string) { order = append(order, n) }
	waitFor(t, time.Second, func() bool { a, _ := s.Child("base"); b, _ := s.Child("top"); return a.PID > 0 && b.PID > 0 })
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if e := s.Close(ctx); e != nil {
		t.Fatal(e)
	}
	if strings.Join(order, ",") != "top,base" {
		t.Fatalf("order=%v", order)
	}
}
func TestPresenceNotKilledByDefault(t *testing.T) {
	for _, teardown := range []bool{false, true} {
		t.Run(map[bool]string{false: "preserved", true: "teardown"}[teardown], func(t *testing.T) {
			dir := t.TempDir()
			alive := filepath.Join(dir, "alive")
			stopped := filepath.Join(dir, "stopped")
			p := fakeChild("presence", "touch '"+alive+"'")
			p.Presence = true
			p.Detached = true
			p.StopArgv = []string{"/bin/sh", "-c", "touch '" + stopped + "'"}
			p.Probe = ProbeConfig{Type: "exec", Argv: []string{"/bin/sh", "-c", "test -f '" + alive + "'"}, Interval: Duration(10 * time.Millisecond), Timeout: Duration(50 * time.Millisecond)}
			c := testConfig(t, p)
			c.TeardownPresence = teardown
			s := startSupervisor(t, c)
			waitFor(t, time.Second, s.Ready)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if e := s.Close(ctx); e != nil {
				t.Fatal(e)
			}
			_, e := os.Stat(stopped)
			if teardown != (e == nil) {
				t.Fatalf("teardown=%v stop marker err=%v", teardown, e)
			}
		})
	}
}
