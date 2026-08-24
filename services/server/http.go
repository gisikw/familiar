package server

import (
	"encoding/json"
	"net/http"
	"strings"
)

type statusDocument struct {
	Ready    bool          `json:"ready"`
	Children []ChildStatus `json:"children"`
}

func (s *Supervisor) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/live", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/ready", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		code := http.StatusOK
		if !s.Ready() {
			code = http.StatusServiceUnavailable
		}
		writeJSON(w, code, map[string]bool{"ready": s.Ready()})
	})
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		writeJSON(w, http.StatusOK, statusDocument{Ready: s.Ready(), Children: s.Status()})
	})
	mux.HandleFunc("/children/", s.childAction)
	// Viewer data is read-only. Invalidation URLs carry a boot-random scoped
	// token and only coalesce a refetch; they never expose plugin data.
	mux.HandleFunc("/v1/render/", func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/v1/render/")
		if hub := s.renders[id]; hub != nil {
			hub.viewerHandler(w, r)
			return
		}
		http.NotFound(w, r)
	})
	mux.HandleFunc("/internal/render-invalidate/", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/internal/render-invalidate/"), "/")
		if len(parts) == 2 {
			if hub := s.renders[parts[0]]; hub != nil && parts[1] == hub.cfg.Token {
				hub.invalidateHandler(w, r)
				return
			}
		}
		http.NotFound(w, r)
	})
	return mux
}
func (s *Supervisor) childAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/children/"), "/")
	if len(parts) != 2 || parts[0] == "" {
		http.NotFound(w, r)
		return
	}
	var err error
	switch parts[1] {
	case "restart":
		err = s.Restart(parts[0])
	case "stop":
		err = s.StopChild(parts[0])
	default:
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"child": parts[0], "action": parts[1]})
}
func methodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
}
func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
