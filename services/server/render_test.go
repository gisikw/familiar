package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const renderFixture = `{"render_api":1,"revision":1,"ttl_ms":5000,"target":"left-nav","content":{"kind":"tree","id":"root","children":[{"kind":"branch","id":"b","label":"alpha","children":[{"kind":"item","id":"i","label":"work","status":"running","activation":{"type":"terminal","socket":"/run/g.sock","session":"worker-i"}}]}]}}`

func TestRenderValidationBoundsTargetAndDuplicates(t *testing.T) {
	cases := []string{renderFixture, strings.Replace(renderFixture, `"target":"left-nav",`, "", 1), strings.Replace(renderFixture, "left-nav", "right", 1), strings.Replace(renderFixture, `"id":"i"`, `"id":"b"`, 1), strings.Replace(renderFixture, `"kind":"item"`, `"kind":"paint"`, 1)}
	for i, s := range cases {
		var d renderEnvelope
		if err := jsonUnmarshal([]byte(s), &d); err != nil {
			t.Fatal(err)
		}
		err := validateRender(&d)
		if (i == 0) != (err == nil) {
			t.Fatalf("case %d: %v", i, err)
		}
	}
}
func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }
func TestRenderInvalidationRefetchesEarlyAndCoalesces(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1); io.WriteString(w, renderFixture) }))
	defer srv.Close()
	h := newRenderHub(RenderConfig{Plugin: "p", URL: srv.URL, Token: "secret"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h.start(ctx)
	deadline := time.Now().Add(time.Second)
	for hits.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	for i := 0; i < 100; i++ {
		h.invalidateHandler(httptest.NewRecorder(), req)
	}
	deadline = time.Now().Add(time.Second)
	for hits.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if n := hits.Load(); n < 2 || n > 4 {
		t.Fatalf("bounded invalidation hits=%d", n)
	}
	bad := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("x"))
	bad.ContentLength = 1
	w := httptest.NewRecorder()
	h.invalidateHandler(w, bad)
	if w.Code != http.StatusBadRequest {
		t.Fatal(w.Code)
	}
}
func TestRenderTTLTriggersEventualRefetch(t *testing.T) {
	var hits atomic.Int32
	short := strings.Replace(renderFixture, `"ttl_ms":5000`, `"ttl_ms":1`, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { hits.Add(1); _, _ = io.WriteString(w, short) }))
	defer srv.Close()
	h := newRenderHub(RenderConfig{Plugin: "p", URL: srv.URL}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h.start(ctx)
	deadline := time.Now().Add(time.Second)
	for hits.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if hits.Load() < 2 {
		t.Fatalf("TTL did not refetch: %d", hits.Load())
	}
}

func TestViewerFanoutReturnsCachedDocument(t *testing.T) {
	h := newRenderHub(RenderConfig{Plugin: "p"}, slog.Default())
	h.doc = []byte(renderFixture)
	h.revision = 3
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		h.viewerHandler(w, httptest.NewRequest(http.MethodGet, "/v1/render/p", nil))
		if w.Code != 200 || w.Header().Get("X-Familiar-Revision") != "3" {
			t.Fatal(fmt.Sprint(w.Code, w.Header()))
		}
	}
}
