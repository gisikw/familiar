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
	Reaped     bool              `json:"reaped,omitempty"`
	Children   *[]renderNode     `json:"children,omitempty"`
	Activation *renderActivation `json:"activation,omitempty"`
}
type renderActivation struct {
	Type    string `json:"type"`
	Socket  string `json:"socket,omitempty"`
	Session string `json:"session,omitempty"`
	Action  string `json:"action,omitempty"`
}

type renderHub struct {
	cfg        RenderConfig
	log        *slog.Logger
	client     *http.Client
	mu         sync.Mutex
	doc        []byte
	content    renderNode
	target     string
	hasDoc     bool
	revision   uint64
	changed    chan struct{}
	invalidate chan struct{}
	// notify wakes the host aggregator when this hub's cached doc changes. It
	// is called without holding h.mu so the aggregator may snapshot this hub.
	notify func()
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
		h.content = doc.Content
		h.target = doc.Target
		h.hasDoc = true
		h.revision++
		close(h.changed)
		h.changed = make(chan struct{})
	}
	h.mu.Unlock()
	if changed && h.notify != nil {
		h.notify()
	}
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
				switch a.Type {
				case "terminal":
					if !filepath.IsAbs(a.Socket) || a.Session == "" || a.Action != "" || len(a.Socket) > 4096 || len(a.Session) > 128 || strings.ContainsAny(a.Socket+a.Session, "\x00\r\n") {
						return fmt.Errorf("unsafe terminal activation")
					}
				case "action":
					if a.Socket != "" || a.Session != "" || a.Action == "" || len(a.Action) > 128 || strings.ContainsAny(a.Action, "/\\\x00\r\n") {
						return fmt.Errorf("unsafe action activation")
					}
				default:
					return fmt.Errorf("unsafe activation type")
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

// snapshot returns the last validated envelope this hub cached, or ok=false when
// the plugin has not yet produced a usable render.
func (h *renderHub) snapshot() (renderEnvelope, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.hasDoc {
		return renderEnvelope{}, false
	}
	return renderEnvelope{Target: h.target, Content: h.content}, true
}

// renderAggregator is the one host-owned render surface. It composes every
// enrolled plugin's `left-nav` contribution, in deterministic config order,
// under a single host tree. Plugin node IDs are namespaced to prevent
// cross-plugin collisions; terminal activation identifiers are left untouched
// so the viewer's exact tmux target is preserved. TTL and invalidation stay
// internal to each hub; the aggregate exposes one revision/long-poll stream
// that changes whenever any hub's composed contribution changes.
type renderAggregator struct {
	hubs     []*renderHub // deterministic config order
	log      *slog.Logger
	mu       sync.Mutex
	content  []byte // composed content bytes, for change detection
	doc      []byte // full envelope served to viewers
	revision uint64
	changed  chan struct{}
}

func newRenderAggregator(hubs []*renderHub, log *slog.Logger) *renderAggregator {
	if log == nil {
		log = slog.Default()
	}
	a := &renderAggregator{hubs: hubs, log: log, changed: make(chan struct{})}
	for _, h := range hubs {
		h.notify = a.recompose
	}
	a.recompose()
	return a
}

// namespaceNode prefixes every node ID with "<plugin>/" recursively. Terminal
// targets remain exact; action names gain the plugin namespace so the host can
// route a click only to the contribution that advertised it.
func namespaceNode(n renderNode, plugin string) renderNode {
	n.ID = plugin + "/" + n.ID
	if n.Activation != nil {
		activation := *n.Activation
		n.Activation = &activation
	}
	if n.Activation != nil && n.Activation.Type == "action" {
		n.Activation.Action = plugin + "/" + n.Activation.Action
	}
	if n.Children != nil {
		kids := make([]renderNode, len(*n.Children))
		for i, c := range *n.Children {
			kids[i] = namespaceNode(c, plugin)
		}
		n.Children = &kids
	}
	return n
}

func (a *renderAggregator) recompose() {
	children := []renderNode{}
	for _, h := range a.hubs {
		env, ok := h.snapshot()
		if !ok || env.Target != "left-nav" {
			continue
		}
		branch := namespaceNode(env.Content, h.cfg.Plugin)
		// The plugin's own tree root becomes a branch under the host root.
		branch.Kind = "branch"
		children = append(children, branch)
	}
	root := renderNode{Kind: "tree", ID: "root", Children: &children}
	contentBytes, _ := json.Marshal(root)
	a.mu.Lock()
	if !bytes.Equal(a.content, contentBytes) {
		a.content = contentBytes
		a.revision++
		env := renderEnvelope{RenderAPI: 1, Revision: a.revision, TTLMillis: 1000, Target: "left-nav", Content: root}
		a.doc, _ = json.Marshal(env)
		close(a.changed)
		a.changed = make(chan struct{})
	}
	a.mu.Unlock()
}

func (a *renderAggregator) actionHandler(w http.ResponseWriter, r *http.Request, action string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	parts := strings.Split(action, "/")
	if len(parts) != 2 {
		http.NotFound(w, r)
		return
	}
	var hub *renderHub
	for _, candidate := range a.hubs {
		if candidate.cfg.Plugin == parts[0] {
			hub = candidate
			break
		}
	}
	if hub == nil {
		http.NotFound(w, r)
		return
	}
	// Only proxy an action currently advertised by this plugin's validated tree.
	env, ok := hub.snapshot()
	advertised := false
	var walk func(renderNode)
	walk = func(n renderNode) {
		if n.Activation != nil && n.Activation.Type == "action" && n.Activation.Action == parts[1] {
			advertised = true
		}
		if n.Children != nil {
			for _, c := range *n.Children {
				walk(c)
			}
		}
	}
	if ok {
		walk(env.Content)
	}
	if !advertised {
		http.NotFound(w, r)
		return
	}
	u, err := url.Parse(hub.cfg.URL)
	if err != nil {
		http.Error(w, "action unavailable", http.StatusBadGateway)
		return
	}
	u.Path = strings.TrimSuffix(u.Path, "/v1/render") + "/v1/action/" + parts[1]
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, u.String(), http.NoBody)
	res, err := hub.client.Do(req)
	if err != nil {
		http.Error(w, "action unavailable", http.StatusBadGateway)
		return
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
	if res.StatusCode/100 != 2 {
		http.Error(w, "action failed", http.StatusBadGateway)
		return
	}
	select {
	case hub.invalidate <- struct{}{}:
	default:
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(res.StatusCode)
	_, _ = w.Write(body)
}

func (a *renderAggregator) viewerHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	since := r.URL.Query().Get("revision")
	a.mu.Lock()
	revision := a.revision
	ch := a.changed
	body := append([]byte(nil), a.doc...)
	a.mu.Unlock()
	if since == fmt.Sprint(revision) {
		select {
		case <-ch:
			a.mu.Lock()
			revision = a.revision
			body = append([]byte(nil), a.doc...)
			a.mu.Unlock()
		case <-time.After(25 * time.Second):
		case <-r.Context().Done():
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Familiar-Revision", fmt.Sprint(revision))
	_, _ = w.Write(body)
}
