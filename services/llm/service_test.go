package llm

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if os.Getenv("FAMILIAR_LLM_TEST_HELPER") == "1" {
		helperBackend()
		return
	}
	os.Exit(m.Run())
}
func helperBackend() {
	args := os.Args
	port := ""
	for i := range args {
		if args[i] == "--port" && i+1 < len(args) {
			port = args[i+1]
		}
	}
	if f := os.Getenv("FAMILIAR_LLM_TEST_COUNT"); f != "" {
		x, _ := os.OpenFile(f, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		fmt.Fprintln(x, "start")
		x.Close()
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok") })
	mux.HandleFunc("/crash", func(w http.ResponseWriter, r *http.Request) {
		go func() { time.Sleep(10 * time.Millisecond); os.Exit(3) }()
		io.WriteString(w, "bye")
	})
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		w.Header().Set("X-Backend", "yes")
		w.WriteHeader(201)
		w.Write(b)
	})
	_ = http.ListenAndServe("127.0.0.1:"+port, mux)
}
func logger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }
func runService(t *testing.T, s *Service) *httptest.Server {
	t.Helper()
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(func() {
		ts.Close()
		ctx, c := context.WithTimeout(context.Background(), time.Second)
		defer c()
		_ = s.Close(ctx)
	})
	return ts
}

func TestUpstreamPassthroughAndHopHeaders(t *testing.T) {
	var gotPath string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.RequestURI()
		if r.Header.Get("X-Remove") != "" {
			t.Error("connection-nominated header forwarded")
		}
		w.Header().Set("Connection", "X-Secret")
		w.Header().Set("X-Secret", "no")
		w.Header().Set("X-Keep", "yes")
		w.WriteHeader(418)
		io.WriteString(w, "teapot")
	}))
	defer up.Close()
	c := DefaultConfig()
	c.Upstream = up.URL + "/base"
	s, _ := New(c, logger())
	ts := runService(t, s)
	req, _ := http.NewRequest("POST", ts.URL+"/v1/chat/completions?q=1", strings.NewReader("x"))
	req.Header.Set("Connection", "X-Remove")
	req.Header.Set("X-Remove", "secret")
	resp, e := http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 418 || string(b) != "teapot" || gotPath != "/base/v1/chat/completions?q=1" {
		t.Fatalf("bad passthrough: %d %q %q", resp.StatusCode, b, gotPath)
	}
	if resp.Header.Get("X-Keep") != "yes" || resp.Header.Get("X-Secret") != "" {
		t.Fatal("bad response hop headers")
	}
}
func TestStreamingIsFlushed(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f := w.(http.Flusher)
		io.WriteString(w, "one\n")
		f.Flush()
		time.Sleep(250 * time.Millisecond)
		io.WriteString(w, "two\n")
	}))
	defer up.Close()
	c := DefaultConfig()
	c.Upstream = up.URL
	s, _ := New(c, logger())
	ts := runService(t, s)
	start := time.Now()
	resp, e := http.Get(ts.URL + "/v1/chat/completions")
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	line, e := bufio.NewReader(resp.Body).ReadString('\n')
	if e != nil || line != "one\n" || time.Since(start) > 180*time.Millisecond {
		t.Fatalf("not streamed promptly: %q %v", line, time.Since(start))
	}
}
func TestLimitsAndHeaderTimeout(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		io.WriteString(w, "late")
	}))
	defer up.Close()
	c := DefaultConfig()
	c.Upstream = up.URL
	c.MaxBody = 4
	c.HeaderTimeout = 40 * time.Millisecond
	s, _ := New(c, logger())
	ts := runService(t, s)
	resp, _ := http.Post(ts.URL+"/x", "text/plain", strings.NewReader("12345"))
	if resp.StatusCode != 413 {
		t.Fatalf("body status %d", resp.StatusCode)
	}
	resp.Body.Close()
	req, _ := http.NewRequest("POST", ts.URL+"/chunked", strings.NewReader("12345"))
	req.ContentLength = -1
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != 413 {
		t.Fatalf("chunked body status %d", resp.StatusCode)
	}
	resp.Body.Close()
	resp, _ = http.Get(ts.URL + "/slow")
	if resp.StatusCode != 502 {
		t.Fatalf("timeout status %d", resp.StatusCode)
	}
	resp.Body.Close()
}
func localConfig(t *testing.T) (Config, string) {
	t.Helper()
	d := t.TempDir()
	os.WriteFile(filepath.Join(d, "model.gguf"), []byte("fake"), 0600)
	ln, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	count := filepath.Join(d, "count")
	c := DefaultConfig()
	c.Backend = "127.0.0.1:" + strconv.Itoa(port)
	c.LlamaServer = os.Args[0]
	c.ModelDir = d
	c.ModelFile = "model.gguf"
	c.StartupTimeout = 2 * time.Second
	t.Setenv("FAMILIAR_LLM_TEST_HELPER", "1")
	t.Setenv("FAMILIAR_LLM_TEST_COUNT", count)
	return c, count
}
func starts(path string) int { b, _ := os.ReadFile(path); return strings.Count(string(b), "start") }
func TestLocalLazySingleFlightCrashRestartAndShutdown(t *testing.T) {
	c, count := localConfig(t)
	s, _ := New(c, logger())
	ts := runService(t, s)
	if s.mgr.ready() {
		t.Fatal("eagerly started")
	}
	resp, _ := http.Get(ts.URL + "/live")
	if resp.StatusCode != 200 {
		t.Fatalf("live status=%d", resp.StatusCode)
	}
	resp.Body.Close()
	resp, _ = http.Get(ts.URL + "/ready")
	if resp.StatusCode != 503 {
		t.Fatalf("early ready status=%d", resp.StatusCode)
	}
	resp.Body.Close()
	var wg sync.WaitGroup
	errs := make(chan error, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, e := http.Post(ts.URL+"/v1/chat/completions", "application/json", strings.NewReader("{}"))
			if e == nil {
				if resp.StatusCode != 201 {
					e = fmt.Errorf("status %d", resp.StatusCode)
				}
				resp.Body.Close()
			}
			errs <- e
		}()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	if n := starts(count); n != 1 {
		t.Fatalf("starts=%d", n)
	}
	resp, _ = http.Get(ts.URL + "/ready")
	if resp.StatusCode != 204 {
		t.Fatalf("ready status=%d", resp.StatusCode)
	}
	resp.Body.Close()
	resp, e := http.Get(ts.URL + "/crash")
	if e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	deadline := time.Now().Add(time.Second)
	for s.mgr.ready() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	resp, e = http.Post(ts.URL+"/v1/chat/completions", "application/json", strings.NewReader("{}"))
	if e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	if n := starts(count); n != 2 {
		t.Fatalf("restart count=%d", n)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if e = s.Close(ctx); e != nil {
		t.Fatal(e)
	}
	if s.mgr.ready() {
		t.Fatal("backend survived close")
	}
}
func TestLocalMissingModelFailsWithoutSpawn(t *testing.T) {
	c := DefaultConfig()
	c.ModelDir = t.TempDir()
	c.ModelFile = "absent.gguf"
	c.LlamaServer = "should-not-run"
	c.StartupTimeout = 100 * time.Millisecond
	s, _ := New(c, logger())
	ts := runService(t, s)
	resp, e := http.Post(ts.URL+"/v1/chat/completions", "application/json", strings.NewReader("{}"))
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 503 {
		t.Fatalf("status %d", resp.StatusCode)
	}
}
