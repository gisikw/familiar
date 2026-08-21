package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
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
	return Config{MaxBody: 1024, MaxInput: 100, Concurrency: 2, ModelMinSize: 4, StartupTimeout: 2 * time.Second, DownloadTimeout: 2 * time.Second, RequestTimeout: 2 * time.Second, ShutdownTimeout: time.Second}
}
func TestProxyBinaryVoiceAndHeaders(t *testing.T) {
	var got map[string]any
	var gotHeaders http.Header
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHeaders = r.Header.Clone()
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.Header().Set("Content-Type", "audio/wav")
		w.Header().Set("Connection", "close")
		w.Write([]byte{0, 1, 2, 255})
	}))
	defer up.Close()
	c := baseConfig()
	c.Upstream = up.URL
	c.UpstreamAuthorization = "Bearer configured-secret"
	c.UpstreamHeaders = http.Header{"X-Service-Key": {"configured-key"}}
	s, _ := New(c, logger())
	defer s.Close()
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/audio/speech", strings.NewReader(`{"input":"hello","voice":"af_exo"}`))
	req.Header.Set("Authorization", "Bearer client-secret")
	req.Header.Set("Cookie", "client=cookie")
	s.Handler().ServeHTTP(rr, req)
	if rr.Code != 200 || !bytes.Equal(rr.Body.Bytes(), []byte{0, 1, 2, 255}) {
		t.Fatalf("response %d %v", rr.Code, rr.Body.Bytes())
	}
	if got["voice"] != "af_exo" || got["input"] != "hello" {
		t.Fatalf("forwarded: %#v", got)
	}
	if gotHeaders.Get("Authorization") != "Bearer configured-secret" || gotHeaders.Get("Cookie") != "" || gotHeaders.Get("X-Service-Key") != "configured-key" {
		t.Fatalf("unsafe/auth headers: %#v", gotHeaders)
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
	if delay := argAfter("--delay"); delay != "" {
		d, _ := time.ParseDuration(delay)
		time.Sleep(d)
	}
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
func TestBackendSelectionAndKokoroStartup(t *testing.T) {
	c := baseConfig()
	c.LocalBackend = "bogus"
	if _, err := New(c, logger()); err == nil {
		t.Fatal("unknown backend accepted")
	}

	dir := t.TempDir()
	model := []byte("pytorch-model")
	config := []byte(`{"vocab":{}}`)
	write := func(name string, data []byte) string {
		p := dir + "/" + name
		if err := os.WriteFile(p, data, 0600); err != nil {
			t.Fatal(err)
		}
		h := sha256.Sum256(data)
		return hex.EncodeToString(h[:])
	}
	c = baseConfig()
	c.LocalBackend = "kokoro"
	c.Model = dir + "/model.pth"
	c.ModelSHA256 = write("model.pth", model)
	c.ModelSize = int64(len(model))
	c.KokoroConfig = dir + "/config.json"
	c.KokoroConfigSHA256 = write("config.json", config)
	c.KokoroConfigSize = int64(len(config))
	c.VoicesSource = dir // custom .pt provisioning means no default voice download
	c.Voice = "af_custom"
	count := dir + "/count"
	port := freePort(t)
	c.Backend = "http://127.0.0.1:" + port
	c.BackendCommand = os.Args[0]
	c.BackendArgs = []string{"-test.run=TestHelperProcess", "--", "--fake-backend", "--count-path", count}
	m := NewManager(c, logger())
	defer m.Close()
	if err := m.Ensure(context.Background()); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(count); strings.Count(string(b), "start") != 1 {
		t.Fatalf("starts=%q", b)
	}
}

func TestLazySingleFlightCrashRestartAndShutdown(t *testing.T) {
	dir := t.TempDir()
	model := dir + "/model.gguf"
	os.WriteFile(model, []byte("GGUFtest-model"), 0600)
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
	// The baker implementation hash participates in invalidation.
	os.WriteFile(baker, []byte("#!/bin/sh\n# version 2\ncp \"$1\" \"$2\" && echo bake >> \""+bakeCount+"\"\n"), 0700)
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
	bakes, _ = os.ReadFile(bakeCount)
	if strings.Count(string(bakes), "bake") != 2 {
		t.Fatalf("baker invalidation failed: %q", bakes)
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

func TestSharedStartSurvivesFirstCallerCancellation(t *testing.T) {
	dir := t.TempDir()
	model := dir + "/model.gguf"
	os.WriteFile(model, []byte("GGUFmodel"), 0600)
	count := dir + "/count"
	port := freePort(t)
	c := baseConfig()
	c.Model = model
	c.ModelURL = ""
	c.Backend = "http://127.0.0.1:" + port
	c.BackendCommand = os.Args[0]
	c.BackendArgs = []string{"-test.run=TestHelperProcess", "--", "--fake-backend", "--delay", "150ms", "--count-path", count}
	m := NewManager(c, logger())
	defer m.Close()
	first, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	firstResult := make(chan error, 1)
	go func() { firstResult <- m.Ensure(first) }()
	time.Sleep(10 * time.Millisecond)
	if err := m.Ensure(context.Background()); err != nil {
		t.Fatalf("shared startup failed: %v", err)
	}
	if err := <-firstResult; !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("first caller: %v", err)
	}
	b, _ := os.ReadFile(count)
	if strings.Count(string(b), "start") != 1 {
		t.Fatalf("starts=%q", b)
	}
}

func TestDownloadResumeValidationAndAtomicity(t *testing.T) {
	data := []byte("GGUF0123456789")
	var ranges []string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ranges = append(ranges, r.Header.Get("Range"))
		start := 0
		if r.Header.Get("Range") != "" {
			start = 8
			w.Header().Set("Content-Range", "bytes 8-13/14")
			w.WriteHeader(http.StatusPartialContent)
		}
		w.Write(data[start:])
	}))
	defer up.Close()
	dir := t.TempDir()
	dest := dir + "/model"
	os.WriteFile(dest+".part", data[:8], 0600)
	c := baseConfig()
	c.ModelURL = up.URL
	c.ModelMinSize = 4
	c.ModelSize = int64(len(data))
	m := NewManager(c, logger())
	if err := m.download(context.Background(), dest); err != nil {
		t.Fatal(err)
	}
	if ranges[0] != "bytes=8-" {
		t.Fatalf("range=%q", ranges[0])
	}
	got, _ := os.ReadFile(dest)
	if !bytes.Equal(got, data) {
		t.Fatalf("got %q", got)
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("<html>not a model</html>")) }))
	defer bad.Close()
	old := []byte("GGUFexisting")
	os.WriteFile(dest, old, 0600)
	os.Remove(dest + ".part")
	m.cfg.ModelURL = bad.URL
	m.cfg.ModelSize = 0
	if err := m.download(context.Background(), dest); err == nil {
		t.Fatal("accepted HTML")
	}
	got, _ = os.ReadFile(dest)
	if !bytes.Equal(got, old) {
		t.Fatal("invalid download replaced destination")
	}
}

func TestCheckedArtifactDownloadResumeAndIntegrity(t *testing.T) {
	data := []byte("pytorch-artifact")
	h := sha256.Sum256(data)
	hash := hex.EncodeToString(h[:])
	var gotRange string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotRange = r.Header.Get("Range")
		if gotRange != "" {
			w.WriteHeader(http.StatusPartialContent)
			_, _ = w.Write(data[7:])
			return
		}
		_, _ = w.Write(data)
	}))
	defer up.Close()
	dest := t.TempDir() + "/model.pth"
	if err := os.WriteFile(dest+".part", data[:7], 0600); err != nil {
		t.Fatal(err)
	}
	m := NewManager(baseConfig(), logger())
	if err := m.downloadChecked(context.Background(), dest, up.URL, hash, int64(len(data))); err != nil {
		t.Fatal(err)
	}
	if gotRange != "bytes=7-" {
		t.Fatalf("range=%q", gotRange)
	}
	got, _ := os.ReadFile(dest)
	if !bytes.Equal(got, data) {
		t.Fatalf("got %q", got)
	}

	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("same-size-corrupt")) }))
	defer bad.Close()
	os.Remove(dest)
	os.Remove(dest + ".part")
	if err := m.downloadChecked(context.Background(), dest, bad.URL, hash, int64(len(data))); err == nil {
		t.Fatal("accepted corrupt artifact")
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatal("corrupt artifact installed")
	}
}

func TestDownloadTimeoutIsIndependentOfStartupTimeout(t *testing.T) {
	data := []byte("GGUFdownloaded-model")
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { time.Sleep(120 * time.Millisecond); w.Write(data) }))
	defer up.Close()
	dir := t.TempDir()
	count := dir + "/count"
	port := freePort(t)
	c := baseConfig()
	c.Model = dir + "/model"
	c.ModelURL = up.URL
	c.ModelSize = int64(len(data))
	c.DownloadTimeout = time.Second
	c.StartupTimeout = 100 * time.Millisecond
	c.Backend = "http://127.0.0.1:" + port
	c.BackendCommand = os.Args[0]
	c.BackendArgs = []string{"-test.run=TestHelperProcess", "--", "--fake-backend", "--count-path", count}
	m := NewManager(c, logger())
	defer m.Close()
	if err := m.Ensure(context.Background()); err != nil {
		t.Fatalf("download was incorrectly bounded by startup timeout: %v", err)
	}
}
