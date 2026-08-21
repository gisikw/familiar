package service

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func logger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }
func baseConfig() Config {
	return Config{MaxBody: 1024, MaxInput: 100, Concurrency: 2, StartupTimeout: 2 * time.Second, RequestTimeout: 2 * time.Second, ShutdownTimeout: time.Second}
}
func TestProxyBinaryVoiceAndHeaders(t *testing.T) {
	var got map[string]any
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.Header().Set("Content-Type", "audio/wav")
		w.Header().Set("Connection", "close")
		w.Write([]byte{0, 1, 2, 255})
	}))
	defer up.Close()
	c := baseConfig()
	c.Upstream = up.URL
	s, _ := New(c, logger())
	defer s.Close()
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/audio/speech", strings.NewReader(`{"input":"hello","voice":"af_exo"}`))
	s.Handler().ServeHTTP(rr, req)
	if rr.Code != 200 || !bytes.Equal(rr.Body.Bytes(), []byte{0, 1, 2, 255}) {
		t.Fatalf("response %d %v", rr.Code, rr.Body.Bytes())
	}
	if got["voice"] != "af_exo" || got["input"] != "hello" {
		t.Fatalf("forwarded: %#v", got)
	}
	if rr.Header().Get("Connection") != "" {
		t.Fatal("hop header forwarded")
	}
}
func TestBoundsAndConcurrency(t *testing.T) {
	block := make(chan struct{})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-block }))
	defer up.Close()
	c := baseConfig()
	c.Upstream = up.URL
	c.Concurrency = 1
	s, _ := New(c, logger())
	defer s.Close()
	go s.Handler().ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/v1/audio/speech", strings.NewReader(`{"input":"ok"}`)))
	time.Sleep(30 * time.Millisecond)
	rr := httptest.NewRecorder()
	s.Handler().ServeHTTP(rr, httptest.NewRequest("POST", "/v1/audio/speech", strings.NewReader(`{"input":"ok"}`)))
	if rr.Code != 429 {
		t.Fatalf("want 429 got %d", rr.Code)
	}
	close(block)
	c2 := baseConfig()
	c2.Upstream = up.URL
	c2.MaxBody = 5
	s2, _ := New(c2, logger())
	rr = httptest.NewRecorder()
	s2.Handler().ServeHTTP(rr, httptest.NewRequest("POST", "/v1/audio/speech", strings.NewReader(`{"input":"too big"}`)))
	if rr.Code != 413 {
		t.Fatalf("want 413 got %d", rr.Code)
	}
}

func TestHelperProcess(t *testing.T) {
	if !hasArg("--fake-backend") {
		return
	}
	port := argAfter("--port")
	count := argAfter("--count-path")
	f, _ := os.OpenFile(count, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	f.WriteString("start\n")
	f.Close()
	ln, e := net.Listen("tcp", "127.0.0.1:"+port)
	if e != nil {
		os.Exit(3)
	}
	http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if bytes.Contains(b, []byte(`"crash"`)) {
			os.Exit(4)
		}
		w.Write([]byte("audio"))
	}))
	os.Exit(0)
}
func hasArg(s string) bool {
	for _, a := range os.Args {
		if a == s {
			return true
		}
	}
	return false
}
func argAfter(s string) string {
	for i, a := range os.Args {
		if a == s && i+1 < len(os.Args) {
			return os.Args[i+1]
		}
	}
	return ""
}
func freePort(t *testing.T) string {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	defer l.Close()
	return strconv.Itoa(l.Addr().(*net.TCPAddr).Port)
}
func TestLazySingleFlightCrashRestartAndShutdown(t *testing.T) {
	dir := t.TempDir()
	model := dir + "/model.gguf"
	os.WriteFile(model, []byte("x"), 0600)
	count := dir + "/count"
	bakeCount := dir + "/bakes"
	voices := dir + "/source"
	os.Mkdir(voices, 0700)
	os.WriteFile(voices+"/af_test.pt", []byte("voice"), 0600)
	baker := dir + "/baker"
	os.WriteFile(baker, []byte("#!/bin/sh\ncp \"$1\" \"$2\" && echo bake >> \""+bakeCount+"\"\n"), 0700)
	port := freePort(t)
	c := baseConfig()
	c.Concurrency = 8
	c.Backend = "http://127.0.0.1:" + port
	c.BackendCommand = os.Args[0]
	c.BackendArgs = []string{"-test.run=TestHelperProcess", "--", "--fake-backend", "--count-path", count}
	c.Model = model
	c.ModelURL = ""
	c.StateDir = dir + "/state"
	c.VoicesSource = voices
	c.Baker = baker
	s, _ := New(c, logger())
	var wg sync.WaitGroup
	var ok atomic.Int32
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rr := httptest.NewRecorder()
			s.Handler().ServeHTTP(rr, httptest.NewRequest("POST", "/v1/audio/speech", strings.NewReader(`{"input":"hello"}`)))
			if rr.Code == 200 {
				ok.Add(1)
			}
		}()
	}
	wg.Wait()
	b, _ := os.ReadFile(count)
	if strings.Count(string(b), "start") != 1 || ok.Load() != 8 {
		t.Fatalf("starts=%q ok=%d", b, ok.Load())
	}
	bakes, _ := os.ReadFile(bakeCount)
	if strings.Count(string(bakes), "bake") != 1 {
		t.Fatalf("bakes=%q", bakes)
	}
	rr := httptest.NewRecorder()
	s.Handler().ServeHTTP(rr, httptest.NewRequest("POST", "/v1/audio/speech", strings.NewReader(`{"input":"crash"}`)))
	time.Sleep(100 * time.Millisecond)
	rr = httptest.NewRecorder()
	s.Handler().ServeHTTP(rr, httptest.NewRequest("POST", "/v1/audio/speech", strings.NewReader(`{"input":"again"}`)))
	if rr.Code != 200 {
		t.Fatalf("restart status %d", rr.Code)
	}
	b, _ = os.ReadFile(count)
	if strings.Count(string(b), "start") != 2 {
		t.Fatalf("restart count %q", b)
	}
	s.Close()
	time.Sleep(30 * time.Millisecond)
	if s.mgr.ready() {
		t.Fatal("child still ready")
	}
}
func TestAtomicCommandFailurePreservesDestination(t *testing.T) {
	p := t.TempDir() + "/artifact"
	os.WriteFile(p, []byte("old"), 0600)
	e := atomicCommand(context.Background(), p, 0600, "sh", "-c", "echo broken > {output}; exit 1")
	if e == nil {
		t.Fatal("expected failure")
	}
	b, _ := os.ReadFile(p)
	if string(b) != "old" {
		t.Fatalf("destination changed: %q", b)
	}
}
func TestTimeoutNoRetry(t *testing.T) {
	var calls atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); time.Sleep(200 * time.Millisecond) }))
	defer up.Close()
	c := baseConfig()
	c.Upstream = up.URL
	c.RequestTimeout = 30 * time.Millisecond
	s, _ := New(c, logger())
	rr := httptest.NewRecorder()
	s.Handler().ServeHTTP(rr, httptest.NewRequest("POST", "/v1/audio/speech", strings.NewReader(`{"input":"hi"}`)))
	if rr.Code != 502 || calls.Load() != 1 {
		t.Fatalf("status=%d calls=%d", rr.Code, calls.Load())
	}
}
