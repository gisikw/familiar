package supervisor

import (
	"context"
	"familiar.dev/agents/harnesses"
	"familiar.dev/agents/harnesses/claude"
	"familiar.dev/agents/protocol"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestDiff(t *testing.T) {
	j := protocol.Job{ID: "a"}
	a := Diff([]protocol.Assignment{{Job: j, DesiredState: protocol.Assigned}}, map[string]Worker{})
	if len(a) != 1 || a[0].Kind != Start {
		t.Fatalf("%#v", a)
	}
	a = Diff([]protocol.Assignment{{Job: protocol.Job{ID: "a", CancelRequested: true}, DesiredState: protocol.Cancelling}}, map[string]Worker{"a": {Job: j}})
	if len(a) != 1 || a[0].Kind != Cancel {
		t.Fatalf("%#v", a)
	}
}
func TestRegistryRecovery(t *testing.T) {
	p := filepath.Join(t.TempDir(), "registry.json")
	r, e := OpenRegistry(p)
	if e != nil {
		t.Fatal(e)
	}
	w := Worker{Job: protocol.Job{ID: "job"}, Session: "worker-job", RestartUntil: time.Now().Add(time.Hour)}
	if e = r.Put(w); e != nil {
		t.Fatal(e)
	}
	r, e = OpenRegistry(p)
	if e != nil || r.Workers["job"].Session != "worker-job" {
		t.Fatalf("%#v %v", r, e)
	}
}
func TestFakeShellAdapterContract(t *testing.T) {
	d := t.TempDir()
	script := filepath.Join(d, "fake.sh")
	if e := os.WriteFile(script, []byte("#!/bin/sh\necho ok\n"), 0700); e != nil {
		t.Fatal(e)
	}
	a := claude.Adapter{ArgvTemplate: []string{script, "{prompt}"}}
	j := protocol.Job{ID: "j", CWD: d, Prompt: "hello", Artifacts: protocol.ArtifactMetadata{Directory: d}}
	l, e := a.Start(context.Background(), j)
	if e != nil {
		t.Fatal(e)
	}
	if o, e := exec.Command(l.Argv[0], l.Argv[1:]...).CombinedOutput(); e != nil || string(o) != "ok\n" {
		t.Fatalf("%q %v", o, e)
	}
}
func TestPrivateTmux(t *testing.T) {
	if _, e := exec.LookPath("tmux"); e != nil {
		t.Skip("tmux absent")
	}
	d := t.TempDir()
	tm := Tmux{Binary: "tmux", Socket: filepath.Join(d, "tmux.sock"), Config: filepath.Join(d, "tmux.conf")}
	if e := tm.Prepare(); e != nil {
		t.Fatal(e)
	}
	l := structLaunch(d)
	s, target, e := tm.Start(context.Background(), "test", l)
	if e != nil {
		t.Fatal(e)
	}
	defer tm.Kill(context.Background(), s)
	if !tm.Has(context.Background(), s) || target == "" {
		t.Fatal("session missing")
	}
}
func structLaunch(d string) (l harnesses.Launch) {
	l.Argv = []string{"sh", "-c", "sleep 2"}
	l.Dir = d
	l.Transcript = filepath.Join(d, "out")
	return
}
