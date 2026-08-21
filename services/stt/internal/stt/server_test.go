package stt

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func config(t *testing.T) Config {
	t.Helper()
	d := t.TempDir()
	model := filepath.Join(d, "model")
	os.WriteFile(model, []byte("m"), 0600)
	ff := script(t, d, "ffmpeg", `#!/bin/sh
out=""; in=""; prev=""; for x in "$@"; do [ "$prev" = "-i" ] && in="$x"; prev="$x"; out="$x"; done; cp "$in" "$out"
`)
	tr := script(t, d, "transcribe", `#!/bin/sh
out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && { shift; out="$1"; }; shift; done; printf 'hello world\n' > "$out"
`)
	return Config{Model: model, FFmpeg: ff, Transcribe: tr, TempDir: d, MaxBody: 1024, MaxAudio: 16, Concurrency: 2, Deadline: time.Second, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
}
func script(t *testing.T, d, n, s string) string {
	t.Helper()
	p := filepath.Join(d, n)
	if e := os.WriteFile(p, []byte(s), 0700); e != nil {
		t.Fatal(e)
	}
	return p
}
func request(h http.Handler, ct string, b []byte) *httptest.ResponseRecorder {
	return requestPath(h, "/v1/audio/transcriptions", ct, b)
}
func requestPath(h http.Handler, path, ct string, b []byte) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", path, bytes.NewReader(b))
	if ct != "" {
		r.Header.Set("Content-Type", ct)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func text(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var v map[string]string
	if e := json.Unmarshal(w.Body.Bytes(), &v); e != nil {
		t.Fatal(e)
	}
	return v["text"]
}
func multipartBody(t *testing.T, name string, b []byte) (string, []byte) {
	t.Helper()
	var x bytes.Buffer
	m := multipart.NewWriter(&x)
	p, e := m.CreateFormFile(name, "a.webm")
	if e != nil {
		t.Fatal(e)
	}
	p.Write(b)
	m.Close()
	return m.FormDataContentType(), x.Bytes()
}

func TestLocalRawAndMultipart(t *testing.T) {
	for _, tc := range []struct {
		name, ct string
		body     func(*testing.T) (string, []byte)
	}{
		{name: "raw", body: func(t *testing.T) (string, []byte) { return "audio/webm", []byte("sound") }},
		{name: "multipart", body: func(t *testing.T) (string, []byte) { return multipartBody(t, "file", []byte("sound")) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := config(t)
			s, _ := New(c)
			ct, b := tc.body(t)
			w := request(s.Handler(), ct, b)
			if w.Code != 200 || text(t, w) != "hello world" {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
			entries, _ := os.ReadDir(c.TempDir)
			for _, e := range entries {
				if strings.HasPrefix(e.Name(), "familiar-stt-") {
					t.Fatal("temporary directory leaked")
				}
			}
		})
	}
}

// Regression for server/src/ingress.ts, which posts raw bytes to the configured
// base URL rather than appending the OpenAI path.
func TestLegacyRootAliasRaw(t *testing.T) {
	c := config(t)
	s, _ := New(c)
	httpServer := httptest.NewServer(s.Handler())
	defer httpServer.Close()
	res, err := http.Post(httpServer.URL+"/", "audio/webm", strings.NewReader("sound"))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body map[string]string
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK || body["text"] != "hello world" {
		t.Fatalf("POST /: %d %#v", res.StatusCode, body)
	}
}

func TestBoundsAndMalformed(t *testing.T) {
	c := config(t)
	s, _ := New(c)
	for _, tc := range []struct {
		name, ct string
		b        []byte
		want     int
	}{{"exact", "", bytes.Repeat([]byte("x"), 16), 200}, {"over", "", bytes.Repeat([]byte("x"), 17), 413}, {"empty", "", nil, 400}, {"bad multipart", "multipart/form-data", []byte("x"), 400}} {
		t.Run(tc.name, func(t *testing.T) {
			w := request(s.Handler(), tc.ct, tc.b)
			if w.Code != tc.want {
				t.Fatalf("got %d: %s", w.Code, w.Body.String())
			}
		})
	}
	ct, b := multipartBody(t, "other", []byte("x"))
	if w := request(s.Handler(), ct, b); w.Code != 400 {
		t.Fatal(w.Code)
	}
}
func TestTimeoutAndCleanup(t *testing.T) {
	c := config(t)
	c.Deadline = 30 * time.Millisecond
	c.FFmpeg = script(t, c.TempDir, "slow", `#!/bin/sh
sleep 2
`)
	s, _ := New(c)
	w := request(s.Handler(), "", []byte("x"))
	if w.Code != 504 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	es, _ := os.ReadDir(c.TempDir)
	for _, e := range es {
		if strings.HasPrefix(e.Name(), "familiar-stt-") {
			t.Fatal("leak")
		}
	}
}
func TestUnavailable(t *testing.T) {
	c := config(t)
	c.Model = filepath.Join(t.TempDir(), "absent")
	s, _ := New(c)
	w := request(s.Handler(), "", []byte("x"))
	if w.Code != 503 {
		t.Fatal(w.Code)
	}
}

func TestConcurrency(t *testing.T) {
	c := config(t)
	c.Concurrency = 1
	c.FFmpeg = script(t, c.TempDir, "blocking", `#!/bin/sh
sleep .2
out=""; in=""; prev=""; for x in "$@"; do [ "$prev" = "-i" ] && in="$x"; prev="$x"; out="$x"; done; cp "$in" "$out"
`)
	s, _ := New(c)
	done := make(chan struct{})
	go func() { request(s.Handler(), "", []byte("x")); close(done) }()
	time.Sleep(30 * time.Millisecond)
	w := request(s.Handler(), "", []byte("x"))
	if w.Code != 429 {
		t.Fatalf("%d", w.Code)
	}
	<-done
}
func TestSingleFlightInitialization(t *testing.T) {
	c := config(t)
	s, _ := New(c)
	var wg sync.WaitGroup
	wg.Add(2)
	for range 2 {
		go func() { defer wg.Done(); _ = s.initialize(context.Background()) }()
	}
	wg.Wait()
	if !s.initialized {
		t.Fatal("not initialized")
	}
}

func TestUpstreamPassthroughAndRootCanonicalization(t *testing.T) {
	var calls atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/base/v1/audio/transcriptions" {
			t.Errorf("legacy alias routed upstream as %s", r.URL.Path)
		}
		b, _ := io.ReadAll(r.Body)
		if string(b) != "payload" {
			t.Errorf("body %q", b)
		}
		if r.Header.Get("Connection") != "" || r.Header.Get("X-Test") != "yes" {
			t.Error("headers")
		}
		w.Header().Set("Connection", "close")
		w.Header().Set("X-Upstream", "ok")
		w.WriteHeader(201)
		w.Write([]byte(`{"text":"remote"}`))
	}))
	defer up.Close()
	u, _ := url.Parse(up.URL + "/base")
	c := config(t)
	c.Upstream = u
	s, _ := New(c)
	r := httptest.NewRequest("POST", "/", strings.NewReader("payload"))
	r.Header.Set("Connection", "keep-alive")
	r.Header.Set("X-Test", "yes")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 201 || w.Header().Get("X-Upstream") != "ok" || w.Header().Get("Connection") != "" || calls.Load() != 1 {
		t.Fatalf("%d %#v %d", w.Code, w.Header(), calls.Load())
	}
}
func TestUpstreamTimeoutNoRetry(t *testing.T) {
	var calls atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); time.Sleep(100 * time.Millisecond) }))
	defer up.Close()
	u, _ := url.Parse(up.URL)
	c := config(t)
	c.Upstream = u
	c.Deadline = 10 * time.Millisecond
	s, _ := New(c)
	w := request(s.Handler(), "", []byte("x"))
	if w.Code != 504 || calls.Load() != 1 {
		t.Fatalf("%d calls=%d", w.Code, calls.Load())
	}
}
func TestHealthAndMethods(t *testing.T) {
	c := config(t)
	s, _ := New(c)
	for _, p := range []string{"/healthz", "/readyz"} {
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, httptest.NewRequest("GET", p, nil))
		if w.Code != 200 {
			t.Fatal(p)
		}
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/v1/audio/transcriptions", nil))
	if w.Code != 405 {
		t.Fatal(w.Code)
	}
}
