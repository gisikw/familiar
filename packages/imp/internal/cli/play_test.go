package cli

import (
	"bytes"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fakeGateway(t *testing.T, played bool) (port string, got *[]byte, gotType *string) {
	var body []byte
	var ctype string
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/play" {
			w.WriteHeader(404)
			return
		}
		body, _ = io.ReadAll(r.Body)
		ctype = r.Header.Get("Content-Type")
		if played {
			io.WriteString(w, `{"played":true,"message_id":3,"index":10000}`)
		} else {
			io.WriteString(w, `{"played":false,"reason":"no-listener"}`)
		}
	}))
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv.Listener = l
	srv.Start()
	t.Cleanup(srv.Close)
	_, port, _ = net.SplitHostPort(l.Addr().String())
	return port, &body, &ctype
}

func TestPlaySendsFileBytes(t *testing.T) {
	dir := t.TempDir()
	clip := filepath.Join(dir, "hi.mp3")
	os.WriteFile(clip, []byte("ID3abc"), 0o644)
	port, body, ctype := fakeGateway(t, true)
	env := map[string]string{"FAMILIAR_STATE_DIR": dir, "FAMILIAR_SUBSCRIBER_PORT": port}
	var out, errw bytes.Buffer
	code := playMain([]string{clip, "--title", "Hello"}, &out, &errw, func(k string) string { return env[k] })
	if code != 0 || string(*body) != "ID3abc" || *ctype != "audio/mpeg" || !strings.Contains(out.String(), "queued") {
		t.Fatalf("code=%d out=%q err=%q body=%q type=%q", code, out.String(), errw.String(), *body, *ctype)
	}
}

func TestPlayNobodyListening(t *testing.T) {
	dir := t.TempDir()
	clip := filepath.Join(dir, "hi.wav")
	os.WriteFile(clip, []byte("RIFF"), 0o644)
	port, _, _ := fakeGateway(t, false)
	env := map[string]string{"FAMILIAR_STATE_DIR": dir, "FAMILIAR_SUBSCRIBER_PORT": port}
	var out, errw bytes.Buffer
	if code := playMain([]string{clip}, &out, &errw, func(k string) string { return env[k] }); code != ExitUnavailable || !strings.Contains(errw.String(), "nobody has the speaker on") {
		t.Fatalf("code=%d err=%q", code, errw.String())
	}
}

func TestPlayRejectsBadTimes(t *testing.T) {
	var out, errw bytes.Buffer
	if code := playMain([]string{"x.mp3", "--start", "soon"}, &out, &errw, func(string) string { return "" }); code != ExitUsage {
		t.Fatalf("code=%d", code)
	}
}

func TestPlayPrefersFamiliarUI(t *testing.T) {
	dir := t.TempDir()
	clip := filepath.Join(dir, "hi.mp3")
	os.WriteFile(clip, []byte("ID3abc"), 0o644)
	var auth, origin, title string
	var body []byte
	ui := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/voice/play" {
			w.WriteHeader(404)
			return
		}
		auth, origin, title = r.Header.Get("Authorization"), r.Header.Get("Origin"), r.Header.Get("X-Clip-Title")
		body, _ = io.ReadAll(r.Body)
		io.WriteString(w, `{"played":true,"message_id":3,"index":10000}`)
	}))
	t.Cleanup(ui.Close)
	desc := filepath.Join(dir, "bridge.json")
	os.WriteFile(desc, []byte(`{"url":"`+ui.URL+`","origin":"https://familiar.gisi.network","token":"tok"}`), 0o600)
	gwPort, gwBody, _ := fakeGateway(t, true)
	env := map[string]string{"FAMILIAR_STATE_DIR": dir, "FAMILIAR_SUBSCRIBER_PORT": gwPort, "FAMILIAR_UI_DESCRIPTOR": desc}
	var out, errw bytes.Buffer
	code := playMain([]string{clip, "--title", "Tom Lehrer"}, &out, &errw, func(k string) string { return env[k] })
	if code != 0 || string(body) != "ID3abc" || auth != "Bearer tok" || origin != "https://familiar.gisi.network" || title != "Tom%20Lehrer" || len(*gwBody) != 0 {
		t.Fatalf("code=%d err=%q auth=%q origin=%q title=%q gw=%q", code, errw.String(), auth, origin, title, *gwBody)
	}
}

func TestPlayFallsBackToGatewayWhenUINotListening(t *testing.T) {
	dir := t.TempDir()
	clip := filepath.Join(dir, "hi.mp3")
	os.WriteFile(clip, []byte("ID3abc"), 0o644)
	ui := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"played":false,"reason":"no-listener"}`)
	}))
	t.Cleanup(ui.Close)
	desc := filepath.Join(dir, "bridge.json")
	os.WriteFile(desc, []byte(`{"url":"`+ui.URL+`","origin":"https://x","token":"tok"}`), 0o600)
	gwPort, gwBody, _ := fakeGateway(t, true)
	env := map[string]string{"FAMILIAR_STATE_DIR": dir, "FAMILIAR_SUBSCRIBER_PORT": gwPort, "FAMILIAR_UI_DESCRIPTOR": desc}
	var out, errw bytes.Buffer
	if code := playMain([]string{clip}, &out, &errw, func(k string) string { return env[k] }); code != 0 || string(*gwBody) != "ID3abc" {
		t.Fatalf("code=%d err=%q", code, errw.String())
	}
}
