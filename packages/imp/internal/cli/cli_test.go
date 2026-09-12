package cli

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func serveOnce(t *testing.T, response []byte, inspect func(Request)) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "imp.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		line, err := bufio.NewReader(conn).ReadBytes('\n')
		if err != nil {
			t.Errorf("read request: %v", err)
			return
		}
		var req Request
		if err := json.Unmarshal(bytes.TrimSuffix(line, []byte("\n")), &req); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}
		if inspect != nil {
			inspect(req)
		}
		if _, err := conn.Write(response); err != nil {
			t.Errorf("write response: %v", err)
		}
	}()
	return path
}

func runWithSocket(t *testing.T, args []string, stdin string, response string, inspect func(Request)) (int, string, string) {
	t.Helper()
	path := serveOnce(t, []byte(response), inspect)
	var out, err bytes.Buffer
	code := Main(args, strings.NewReader(stdin), &out, &err, func(k string) string {
		if k == "FAMILIAR_IMP_SOCKET" {
			return path
		}
		return ""
	})
	return code, out.String(), err.String()
}

func TestProgressiveHelpNeedsNoResident(t *testing.T) {
	cases := [][]string{{"--help"}, {"plate", "--help"}, {"plate", "append-note", "--help"}, {"agent", "--help"}, {"agent", "dispatch", "--help"}}
	for _, args := range cases {
		var out, err bytes.Buffer
		if code := Main(args, strings.NewReader(""), &out, &err, func(string) string { return "" }); code != 0 {
			t.Fatalf("%v: code=%d err=%s", args, code, err.String())
		}
		if !strings.HasPrefix(out.String(), "Usage: imp ") {
			t.Errorf("%v: missing usage: %q", args, out.String())
		}
		if strings.Contains(out.String(), "\x1b[") {
			t.Errorf("%v: colored help", args)
		}
	}
}

func TestRequestSpelling(t *testing.T) {
	cases := []struct {
		name             string
		argv             []string
		stdin, operation string
		args             map[string]any
	}{
		{"list", []string{"plate", "list", "--archived", "--json"}, "", "list", map[string]any{"archived": true}},
		{"get", []string{"plate", "get", "p1", "--json"}, "", "get", map[string]any{"id": "p1"}},
		{"add", []string{"plate", "add", "-", "--label", "launch", "--assign", "kes", "--accent", "attention", "--json"}, "ship it\n", "add", map[string]any{"summary": "ship it", "label": "launch", "assignedToKes": true, "accent": "attention"}},
		{"summary", []string{"plate", "update-summary", "p1", "--summary", "new", "--json"}, "", "update-summary", map[string]any{"id": "p1", "summary": "new"}},
		{"label", []string{"plate", "set-label", "p1", "--label", "soon", "--json"}, "", "set-label", map[string]any{"id": "p1", "label": "soon"}},
		{"clear-label", []string{"plate", "clear-label", "p1", "--json"}, "", "clear-label", map[string]any{"id": "p1"}},
		{"note", []string{"plate", "append-note", "p1", "-", "--json"}, "from model\n", "append-note", map[string]any{"id": "p1", "text": "from model"}},
		{"assign", []string{"plate", "assign", "p1", "kevin", "--json"}, "", "assign", map[string]any{"id": "p1", "assignedToKes": false}},
		{"accent", []string{"plate", "set-accent", "p1", "caution", "--json"}, "", "set-accent", map[string]any{"id": "p1", "accent": "caution"}},
		{"clear-accent", []string{"plate", "clear-accent", "p1", "--json"}, "", "clear-accent", map[string]any{"id": "p1"}},
		{"close", []string{"plate", "close", "p1", "--json"}, "", "close", map[string]any{"id": "p1"}},
		{"restore", []string{"plate", "restore", "p1", "--json"}, "", "restore", map[string]any{"id": "p1"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, out, stderr := runWithSocket(t, tc.argv, tc.stdin, "{\"ok\":true,\"result\":{\"id\":\"p1\",\"summary\":\"ok\"}}\n", func(got Request) {
				if got.Version != 1 || got.Area != "plate" || got.Operation != tc.operation {
					t.Errorf("envelope: %#v", got)
				}
				want, _ := json.Marshal(tc.args)
				have, _ := json.Marshal(got.Args)
				if !bytes.Equal(have, want) {
					t.Errorf("args=%s want %s", have, want)
				}
			})
			if code != 0 || stderr != "" {
				t.Fatalf("code=%d stderr=%q", code, stderr)
			}
			if out != "{\"id\":\"p1\",\"summary\":\"ok\"}\n" {
				t.Errorf("unstable JSON output %q", out)
			}
		})
	}
}

func TestAgentRequestSpelling(t *testing.T) {
	cases := []struct {
		name             string
		argv             []string
		stdin, operation string
		args             map[string]any
	}{
		{"capabilities", []string{"agent", "capabilities", "--machine", "worker", "--json"}, "", "capabilities", map[string]any{"machine": "worker"}},
		{"dispatch", []string{"agent", "dispatch", "--key", "admit-1", "--machine", "worker", "--harness", "pi", "--model", "provider/model", "--thinking", "high", "--repo", "/remote/repo", "--requested-ref", "main", "-", "--label", "review", "--json"}, "do work\n", "dispatch", map[string]any{"key": "admit-1", "machine": "worker", "harness": "pi", "model": "provider/model", "thinking": "high", "repo": "/remote/repo", "requested_ref": "main", "task": "do work", "label": "review"}},
		{"status-page", []string{"agent", "status", "--offset", "5", "--json"}, "", "status", map[string]any{"offset": float64(5)}},
		{"status-id", []string{"agent", "status", "agent-1", "--json"}, "", "status", map[string]any{"id": "agent-1"}},
		{"steer", []string{"agent", "steer", "agent-1", "--key", "s1", "--text", "review", "--json"}, "", "steer", map[string]any{"id": "agent-1", "key": "s1", "text": "review"}},
		{"answer", []string{"agent", "answer", "agent-1", "--key", "a1", "-", "--json"}, "yes\n", "answer", map[string]any{"id": "agent-1", "key": "a1", "text": "yes"}},
		{"cancel", []string{"agent", "cancel", "agent-1", "--key", "c1", "--json"}, "", "cancel", map[string]any{"id": "agent-1", "key": "c1"}},
		{"reconcile", []string{"agent", "reconcile", "--json"}, "", "reconcile", map[string]any{}},
		{"abandon", []string{"agent", "abandon", "agent-1", "--reason", "superseded", "--json"}, "", "abandon", map[string]any{"id": "agent-1", "reason": "superseded"}},
		{"settle", []string{"agent", "settle", "agent-1", "done", "--summary", "inspected", "--json"}, "", "settle", map[string]any{"id": "agent-1", "verdict": "done", "summary": "inspected"}},
		{"resolve-operation", []string{"agent", "resolve-operation", "agent-1", "prompt", "prompt-confirmed-delivered", "--reason", "native proof", "--json"}, "", "resolve-operation", map[string]any{"id": "agent-1", "operation": "prompt", "resolution": "prompt-confirmed-delivered", "reason": "native proof"}},
		{"resolve-intent", []string{"agent", "resolve-intent", "agent-1", "s1", "-", "--json"}, "inspected natively\n", "resolve-intent", map[string]any{"id": "agent-1", "key": "s1", "reason": "inspected natively"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, out, stderr := runWithSocket(t, tc.argv, tc.stdin, "{\"ok\":true,\"result\":{\"accepted\":true}}\n", func(got Request) {
				if got.Area != "agent" || got.Operation != tc.operation {
					t.Errorf("envelope: %#v", got)
				}
				want, _ := json.Marshal(tc.args)
				have, _ := json.Marshal(got.Args)
				if !bytes.Equal(have, want) {
					t.Errorf("args=%s want=%s", have, want)
				}
			})
			if code != 0 || stderr != "" || out != "{\"accepted\":true}\n" {
				t.Fatalf("code=%d out=%q err=%q", code, out, stderr)
			}
		})
	}
}

func TestAgentValidation(t *testing.T) {
	bad := [][]string{
		{"agent", "dispatch", "--key", "k"},
		{"agent", "dispatch", "--key", "k", "--machine", "m", "--harness", "pi", "--model", "p/m", "--repo", "/r", "--requested-ref", "HEAD", "--task", strings.Repeat("x", 24577), "--label", "x"},
		{"agent", "status", "--offset", "-1"},
		{"agent", "settle", "id", "maybe", "--summary", "x"},
		{"agent", "cancel", "id", "--key", "k", "--text", "not allowed"},
	}
	for _, argv := range bad {
		var out, stderr bytes.Buffer
		if code := Main(argv, strings.NewReader(""), &out, &stderr, func(string) string { return "" }); code != ExitUsage {
			t.Errorf("%v code=%d err=%s", argv, code, stderr.String())
		}
	}
}
func TestUsageAndUnavailableFailures(t *testing.T) {
	var out, err bytes.Buffer
	if code := Main([]string{"plate", "add", "--summary", "x", "-"}, strings.NewReader("y"), &out, &err, func(string) string { return "" }); code != ExitUsage {
		t.Fatalf("usage code=%d", code)
	}
	out.Reset()
	err.Reset()
	if code := Main([]string{"plate", "list"}, strings.NewReader(""), &out, &err, func(string) string { return "" }); code != ExitUnavailable {
		t.Fatalf("unavailable code=%d", code)
	}
	if !strings.Contains(err.String(), "FAMILIAR_IMP_SOCKET") {
		t.Fatal(err.String())
	}
}

func TestRemoteFailure(t *testing.T) {
	code, out, stderr := runWithSocket(t, []string{"plate", "get", "missing"}, "", "{\"ok\":false,\"error\":{\"code\":\"not_found\",\"message\":\"no such item\"}}\n", nil)
	if code != ExitRemote || out != "" || !strings.Contains(stderr, "not_found: no such item") {
		t.Fatalf("code=%d out=%q err=%q", code, out, stderr)
	}
}

func TestBoundedAndStrictResponse(t *testing.T) {
	oversized := append(bytes.Repeat([]byte("x"), MaxWireBytes+1), '\n')
	path := serveOnce(t, oversized, nil)
	var out, stderr bytes.Buffer
	code := Main([]string{"plate", "list"}, strings.NewReader(""), &out, &stderr, func(string) string { return path })
	if code != ExitProtocol || !strings.Contains(stderr.String(), "exceeds") {
		t.Fatalf("code=%d err=%q", code, stderr.String())
	}

	code, _, msg := runWithSocket(t, []string{"plate", "list"}, "", "{\"ok\":true,\"result\":[]}\n{\"ok\":true,\"result\":[]}\n", nil)
	if code != ExitProtocol || !strings.Contains(msg, "more or fewer") {
		t.Fatalf("code=%d err=%q", code, msg)
	}
}

func TestBoundedStdin(t *testing.T) {
	var out, stderr bytes.Buffer
	code := Main([]string{"plate", "add", "-"}, strings.NewReader(strings.Repeat("x", MaxProseBytes+1)), &out, &stderr, func(string) string { return "" })
	if code != ExitUsage || !strings.Contains(stderr.String(), "exceeds") {
		t.Fatalf("code=%d err=%q", code, stderr.String())
	}
}

func TestTimeoutIsBounded(t *testing.T) {
	old := ioTimeout
	ioTimeout = 30 * time.Millisecond
	defer func() { ioTimeout = old }()
	path := serveOnce(t, nil, func(Request) { time.Sleep(100 * time.Millisecond) })
	var out, stderr bytes.Buffer
	start := time.Now()
	code := Main([]string{"plate", "list"}, strings.NewReader(""), &out, &stderr, func(string) string { return path })
	if code != ExitProtocol || time.Since(start) > time.Second {
		t.Fatalf("code=%d elapsed=%s err=%s", code, time.Since(start), stderr.String())
	}
}

func TestSocketPermissionsFailClosed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "imp.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if err := os.Chmod(path, 0666); err != nil {
		t.Fatal(err)
	}
	_, _, err = call(path, Request{Version: 1, Area: "plate", Operation: "list", Args: map[string]any{}})
	if err == nil || !strings.Contains(err.Error(), "not private") {
		t.Fatalf("err=%v", err)
	}
}

func TestAgentHumanOutputAndUnavailableArea(t *testing.T) {
	result := `{"ok":true,"result":{"total":1,"offset":0,"limit":5,"jobs":[{"job_id":"agent-1","semantic_state":"blocked","reachability":"fresh","label":"review"}]}}` + "\n"
	code, out, stderr := runWithSocket(t, []string{"agent", "status"}, "", result, nil)
	if code != 0 || stderr != "" || out != "agent-1\tblocked\tfresh\treview\nShowing 1 of 1 (offset 0).\n" {
		t.Fatalf("code=%d out=%q err=%q", code, out, stderr)
	}
	code, out, stderr = runWithSocket(t, []string{"agent", "status", "--json"}, "", "{\"ok\":false,\"error\":{\"code\":\"unavailable\",\"message\":\"agent owner absent\"}}\n", nil)
	if code != ExitUnavailable || out != "" || !strings.Contains(stderr, "unavailable") {
		t.Fatalf("code=%d out=%q err=%q", code, out, stderr)
	}
}

func TestHumanOutput(t *testing.T) {
	result := `{"ok":true,"result":[{"id":"a1","summary":"Do thing","label":"today","notes":[],"assignedToKes":true,"accent":"caution","materialMtime":"2026-01-01"}]}` + "\n"
	code, out, stderr := runWithSocket(t, []string{"plate", "list"}, "", result, nil)
	if code != 0 || stderr != "" || out != "a1\tDo thing [label=today, assigned=kes, accent=caution]\n" {
		t.Fatalf("code=%d out=%q err=%q", code, out, stderr)
	}
}

func ExampleMain_help() {
	var out, err bytes.Buffer
	code := Main([]string{"plate", "assign", "--help"}, strings.NewReader(""), &out, &err, os.Getenv)
	fmt.Printf("%d %s", code, out.String())
	// Output:
	// 0 Usage: imp plate assign <id> <kes|kevin> [--json]
}
