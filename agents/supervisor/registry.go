package supervisor

import (
	"encoding/json"
	"errors"
	"familiar.dev/agents/harnesses"
	"familiar.dev/agents/protocol"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Worker struct {
	Job          protocol.Job     `json:"job"`
	Launch       harnesses.Launch `json:"launch"`
	Session      string           `json:"session"`
	Target       string           `json:"target"`
	Worktree     string           `json:"worktree,omitempty"`
	RestartUntil time.Time        `json:"restart_until"`
	LastState    protocol.State   `json:"last_state"`
	LastExit     *int             `json:"last_exit,omitempty"`
	AnsweredKey  string           `json:"answered_key,omitempty"`
	StartedAt    time.Time        `json:"started_at"`
}
type Registry struct {
	path    string
	mu      sync.Mutex
	Workers map[string]Worker `json:"workers"`
}

func OpenRegistry(path string) (*Registry, error) {
	r := &Registry{path: path, Workers: map[string]Worker{}}
	b, e := os.ReadFile(path)
	if errors.Is(e, os.ErrNotExist) {
		return r, nil
	}
	if e != nil {
		return nil, e
	}
	if e = json.Unmarshal(b, r); e != nil {
		return nil, e
	}
	if r.Workers == nil {
		r.Workers = map[string]Worker{}
	}
	return r, nil
}
func (r *Registry) Snapshot() map[string]Worker {
	r.mu.Lock()
	defer r.mu.Unlock()
	x := map[string]Worker{}
	for k, v := range r.Workers {
		x[k] = v
	}
	return x
}
func (r *Registry) Put(w Worker) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Workers[w.Job.ID] = w
	return r.save()
}
func (r *Registry) Delete(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.Workers, id)
	return r.save()
}
func (r *Registry) save() error {
	if e := os.MkdirAll(filepath.Dir(r.path), 0700); e != nil {
		return e
	}
	b, e := json.MarshalIndent(r, "", "  ")
	if e != nil {
		return e
	}
	tmp := r.path + ".tmp"
	if e = os.WriteFile(tmp, b, 0600); e != nil {
		return e
	}
	return os.Rename(tmp, r.path)
}
