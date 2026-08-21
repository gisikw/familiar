package supervisor

import (
	"familiar.dev/agents/protocol"
	"path/filepath"
	"testing"
	"time"
)

func TestRegistryRecovery(t *testing.T) {
	p := filepath.Join(t.TempDir(), "workers.json")
	r, e := OpenRegistry(p)
	if e != nil {
		t.Fatal(e)
	}
	w := Worker{Job: protocol.Job{ID: "j", Harness: "fake"}, Session: "worker-j", RestartUntil: time.Now().Add(time.Hour)}
	if e = r.Put(w); e != nil {
		t.Fatal(e)
	}
	r2, e := OpenRegistry(p)
	if e != nil {
		t.Fatal(e)
	}
	if got := r2.Snapshot()["j"]; got.Session != "worker-j" {
		t.Fatalf("not recovered: %#v", got)
	}
}
