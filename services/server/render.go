package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	maxRenderBytes = 256 << 10
	maxRenderNodes = 512
	maxRenderDepth = 8
	maxRenderText  = 256
	minRenderTTL   = 250 * time.Millisecond
	maxRenderTTL   = 5 * time.Minute
)

type renderEnvelope struct {
	RenderAPI int        `json:"render_api"`
	Revision  uint64     `json:"revision"`
	TTLMillis int64      `json:"ttl_ms"`
	Target    string     `json:"target"`
	Content   renderNode `json:"content"`
}
type renderNode struct {
	Kind       string            `json:"kind"`
	ID         string            `json:"id"`
	Label      string            `json:"label,omitempty"`
	Status     string            `json:"status,omitempty"`
	Children   *[]renderNode     `json:"children,omitempty"`
	Activation *renderActivation `json:"activation,omitempty"`
}
type renderActivation struct {
	Type    string `json:"type"`
	Socket  string `json:"socket"`
	Session string `json:"session"`
}

type renderHub struct {
	cfg        RenderConfig
	log        *slog.Logger
	client     *http.Client
	mu         sync.Mutex
	doc        []byte
	revision   uint64
	changed    chan struct{}
	invalidate chan struct{}
}

func newRenderHub(cfg RenderConfig, log *slog.Logger) *renderHub {
	return &renderHub{cfg: cfg, log: log, client: &http.Client{Timeout: 2 * time.Second}, changed: make(chan struct{}), invalidate: make(chan struct{}, 1)}
}
func (h *renderHub) start(ctx context.Context) { go h.loop(ctx) }
func (h *renderHub) loop(ctx context.Context) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-h.invalidate:
		case <-timer.C:
		}
		ttl, err := h.fetch(ctx)
		if err != nil {
			h.log.Warn("plugin render fetch failed", "plugin", h.cfg.Plugin, "error", err)
			ttl = time.Second
		}
		timer.Reset(ttl)
	}
}
func (h *renderHub) fetch(ctx context.Context) (time.Duration, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.cfg.URL, nil)
	if err != nil {
		return time.Second, err
	}
	res, err := h.client.Do(req)
	if err != nil {
		return time.Second, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return time.Second, fmt.Errorf("render returned %s", res.Status)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, maxRenderBytes+1))
	if err != nil {
		return time.Second, err
	}
	if len(body) > maxRenderBytes {
		return time.Second, fmt.Errorf("render exceeds %d bytes", maxRenderBytes)
	}
	var doc renderEnvelope
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err = dec.Decode(&doc); err != nil {
		return time.Second, fmt.Errorf("malformed render: %w", err)
	}
	if dec.Decode(&struct{}{}) != io.EOF {
		return time.Second, fmt.Errorf("render has trailing data")
	}
	if err = validateRender(&doc); err != nil {
		return time.Second, err
	}
	canonical, _ := json.Marshal(doc)
	h.mu.Lock()
	changed := !bytes.Equal(h.doc, canonical)
	if changed {
		h.doc = canonical
		h.revision++
		close(h.changed)
		h.changed = make(chan struct{})
	}
	h.mu.Unlock()
	ttl := time.Duration(doc.TTLMillis) * time.Millisecond
	if ttl < minRenderTTL {
		ttl = minRenderTTL
	}
	if ttl > maxRenderTTL {
		ttl = maxRenderTTL
	}
	return ttl, nil
}
func validateRender(doc *renderEnvelope) error {
	if doc.RenderAPI != 1 {
		return fmt.Errorf("unsupported render_api %d", doc.RenderAPI)
	}
	if doc.Target != "left-nav" {
		return fmt.Errorf("unsupported render target %q", doc.Target)
	}
	if doc.TTLMillis <= 0 {
		return fmt.Errorf("ttl_ms must be positive")
	}
	seen := map[string]bool{}
	count := 0
	var walk func(renderNode, int) error
	walk = func(n renderNode, depth int) error {
		count++
		if count > maxRenderNodes || depth > maxRenderDepth {
			return fmt.Errorf("render tree exceeds bounds")
		}
		if n.Kind != "tree" && n.Kind != "branch" && n.Kind != "item" {
			return fmt.Errorf("unsupported node kind %q", n.Kind)
		}
		if n.ID == "" || len(n.ID) > maxRenderText || strings.ContainsAny(n.ID, "\x00\r\n") {
			return fmt.Errorf("unsafe node id")
		}
		if seen[n.ID] {
			return fmt.Errorf("duplicate node id %q", n.ID)
		}
		seen[n.ID] = true
		if len(n.Label) > maxRenderText || len(n.Status) > 64 || strings.ContainsAny(n.Label+n.Status, "\x00\r\n") {
			return fmt.Errorf("unsafe node text")
		}
		if n.Kind == "item" {
			if n.Children != nil {
				return fmt.Errorf("item cannot have children")
			}
			if n.Activation != nil {
				a := n.Activation
				if a.Type != "terminal" || !filepath.IsAbs(a.Socket) || a.Session == "" || len(a.Socket) > 4096 || len(a.Session) > 128 || strings.ContainsAny(a.Socket+a.Session, "\x00\r\n") {
					return fmt.Errorf("unsafe terminal activation")
				}
			}
			return nil
		}
		if n.Activation != nil {
			return fmt.Errorf("only items activate")
		}
		if n.Children == nil {
			return fmt.Errorf("%s requires children", n.Kind)
		}
		for _, c := range *n.Children {
			if err := walk(c, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	if doc.Content.Kind != "tree" {
		return fmt.Errorf("content root must be tree")
	}
	return walk(doc.Content, 1)
}
func (h *renderHub) invalidateHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1))
	if r.ContentLength > 0 || len(body) > 0 {
		http.Error(w, "empty body required", http.StatusBadRequest)
		return
	}
	select {
	case h.invalidate <- struct{}{}:
	default:
	}
	w.WriteHeader(http.StatusAccepted)
}
func (h *renderHub) viewerHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	since := r.URL.Query().Get("revision")
	h.mu.Lock()
	revision := h.revision
	ch := h.changed
	body := append([]byte(nil), h.doc...)
	h.mu.Unlock()
	if since == fmt.Sprint(revision) && body != nil {
		select {
		case <-ch:
			h.mu.Lock()
			revision = h.revision
			body = append([]byte(nil), h.doc...)
			h.mu.Unlock()
		case <-time.After(25 * time.Second):
		case <-r.Context().Done():
			return
		}
	}
	if body == nil {
		http.Error(w, "render unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Familiar-Revision", fmt.Sprint(revision))
	_, _ = w.Write(body)
}
func validRenderURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "http" && u.Host != ""
}
