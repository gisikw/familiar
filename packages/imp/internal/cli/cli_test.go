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
	"sync/atomic"
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
	var finished atomic.Bool
	t.Cleanup(func() { finished.Store(true); ln.Close() })
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
		if _, err := conn.Write(response); err != nil && !finished.Load() {
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
	cases := [][]string{{"--help"}, {"plate", "--help"}, {"plate", "append-note", "--help"}, {"agent", "--help"}, {"agent", "dispatch", "--help"}, {"agent", "policy", "--help"}, {"attn"}, {"attn", "--help"}, {"attn", "card"}, {"attn", "card", "--help"}, {"attn", "card", "list", "--help"}, {"attn", "status", "--help"}}
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
		{"policy-show", []string{"agent", "policy", "show", "--json"}, "", "policy-show", map[string]any{}},
		{"policy-on", []string{"agent", "policy", "on", "provider/model", "on", "--json"}, "", "policy-set", map[string]any{"action": "set-on", "route": "provider/model", "on": true}},
		{"policy-off", []string{"agent", "policy", "on", "provider/model", "off", "--json"}, "", "policy-set", map[string]any{"action": "set-on", "route": "provider/model", "on": false}},
		{"policy-fallback", []string{"agent", "policy", "fallback", "provider/model", "deny", "--json"}, "", "policy-set", map[string]any{"action": "set-fallback", "route": "provider/model", "fallback": "deny"}},
		{"policy-override", []string{"agent", "policy", "override", "provider/model", "worker", "allow", "--revision", "abc123", "--json"}, "", "policy-set", map[string]any{"action": "set-override", "route": "provider/model", "node": "worker", "decision": "allow", "expected_revision": "abc123"}},
		{"policy-clear", []string{"agent", "policy", "clear-override", "provider/model", "worker", "--json"}, "", "policy-set", map[string]any{"action": "clear-override", "route": "provider/model", "node": "worker"}},
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
		// There is no bypass verb and no approval argument on dispatch.
		{"agent", "dispatch", "--key", "k", "--machine", "m", "--harness", "pi", "--model", "p/m", "--repo", "/r", "--requested-ref", "HEAD", "--task", "t", "--label", "x", "--policy", "allow"},
		{"agent", "policy"},
		{"agent", "policy", "allow-everything"},
		{"agent", "policy", "on", "not-a-route", "on"},
		{"agent", "policy", "on", "provider/model", "maybe"},
		{"agent", "policy", "fallback", "provider/model", "sometimes"},
		{"agent", "policy", "override", "provider/model", "worker"},
		{"agent", "policy", "override", "provider/model", "worker", "allow", "extra"},
		{"agent", "policy", "show", "--revision", "abc"},
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

func TestAgentPolicyHumanOutput(t *testing.T) {
	result := `{"ok":true,"result":{"version":1,"revision":"rev1","nodes":[{"id":"worker","routes":["provider/model"]}],"routes":[{"route":"provider/model","on":true,"fallback":"deny","overrides":{"worker":"allow"}}]}}` + "\n"
	code, out, stderr := runWithSocket(t, []string{"agent", "policy", "show"}, "", result, nil)
	if code != 0 || stderr != "" {
		t.Fatalf("code=%d err=%q", code, stderr)
	}
	want := "revision rev1\nmachine worker\troutes=1\nprovider/model\ton\tfallback=deny\tworker=allow\n"
	if out != want {
		t.Fatalf("out=%q want %q", out, want)
	}
	empty := `{"ok":true,"result":{"version":1,"revision":"rev0","nodes":[],"routes":[]}}` + "\n"
	if _, out, _ = runWithSocket(t, []string{"agent", "policy", "show"}, "", empty, nil); !strings.Contains(out, "every route is denied") {
		t.Fatalf("out=%q", out)
	}
	// A resident policy refusal is surfaced verbatim, never softened to success.
	denied := "{\"ok\":false,\"error\":{\"code\":\"policy_denied\",\"message\":\"Agent policy denies model p/m on machine worker\"}}\n"
	code, out, stderr = runWithSocket(t, []string{"agent", "dispatch", "--key", "k", "--machine", "worker", "--harness", "pi", "--model", "p/m", "--repo", "/r", "--requested-ref", "HEAD", "--task", "t", "--label", "x", "--json"}, "", denied, nil)
	if code != ExitRemote || out != "" || !strings.Contains(stderr, "policy_denied: Agent policy denies model p/m on machine worker") {
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

func TestAttnHelpEnumeratesNounsAndVerbs(t *testing.T) {
	run := func(args ...string) (int, string, string) {
		var out, err bytes.Buffer
		code := Main(args, strings.NewReader(""), &out, &err, func(string) string { return "" })
		return code, out.String(), err.String()
	}
	code, out, _ := run("attn", "--help")
	if code != 0 || !strings.HasPrefix(out, "Usage: imp attn <noun>") {
		t.Fatalf("code=%d out=%q", code, out)
	}
	for _, noun := range attnNouns {
		if !strings.Contains(out, "\n  "+noun) {
			t.Errorf("attn --help omits noun %q", noun)
		}
	}
	for noun, verbs := range attnVerbs {
		code, out, _ := run("attn", noun, "--help")
		if code != 0 || !strings.HasPrefix(out, "Usage: imp attn "+noun+" <command>") {
			t.Fatalf("%s: code=%d out=%q", noun, code, out)
		}
		for _, verb := range verbs {
			if !strings.Contains(out, "\n  imp attn "+noun+" "+verb) {
				t.Errorf("attn %s --help omits verb %q:\n%s", noun, verb, out)
			}
			usage := attnUsage[noun+"."+verb]
			if !strings.HasPrefix(usage, "Usage: imp attn "+noun+" "+verb) {
				t.Errorf("usage for %s.%s is %q", noun, verb, usage)
			}
			if code, out, _ := run("attn", noun, verb, "--help"); code != 0 || out != usage {
				t.Errorf("%s %s --help: code=%d out=%q", noun, verb, code, out)
			}
		}
	}
	if code, out, _ := run("attn", "status", "--help"); code != 0 || out != attnUsage["status"] {
		t.Errorf("status --help: code=%d out=%q", code, out)
	}
	// Unknown nouns and verbs point at the right --help without any request.
	for _, tc := range []struct {
		args []string
		hint string
	}{
		{[]string{"attn", "board"}, "imp attn --help"},
		{[]string{"attn", "card", "archive", "x"}, "imp attn card --help"},
		{[]string{"attn", "card", "list", "--bogus"}, "unknown option"},
	} {
		code, _, stderr := run(tc.args...)
		if code != ExitUsage || !strings.Contains(stderr, tc.hint) {
			t.Errorf("%v: code=%d err=%q", tc.args, code, stderr)
		}
	}
}

func TestAttnRequestSpelling(t *testing.T) {
	card := "{\"ok\":true,\"result\":{\"id\":\"c1\"}}\n"
	cases := []struct {
		name             string
		argv             []string
		stdin, operation string
		args             map[string]any
	}{
		{"project.list", []string{"attn", "project", "list", "--json"}, "", "project.list", map[string]any{}},
		{"project.list-hidden", []string{"attn", "project", "list", "--hidden", "--json"}, "", "project.list", map[string]any{"hidden": true}},
		{"project.get", []string{"attn", "project", "get", "familiar", "--json"}, "", "project.get", map[string]any{"slug": "familiar"}},
		{"project.add", []string{"attn", "project", "add", "familiar", "--label", "Familiar", "--default-policy", "ship-tell", "--repo", "/srv/familiar", "--json"}, "", "project.add", map[string]any{"slug": "familiar", "label": "Familiar", "default_policy": "ship-tell", "repo": "/srv/familiar"}},
		{"project.set", []string{"attn", "project", "set", "familiar", "--default-policy", "pr-evidence", "--json"}, "", "project.set", map[string]any{"slug": "familiar", "default_policy": "pr-evidence"}},
		{"card.list-project", []string{"attn", "card", "list", "--project", "familiar", "--owner", "kes", "--edge", "blocked", "--q", "imp", "--json"}, "", "card.list", map[string]any{"project": "familiar", "owner": "kes", "edge": "blocked", "q": "imp"}},
		{"card.list-lane", []string{"attn", "card", "list", "--lane", "review", "--json"}, "", "card.list", map[string]any{"lane": "review"}},
		{"card.get", []string{"attn", "card", "get", "c1", "--json"}, "", "card.get", map[string]any{"id": "c1"}},
		{"card.add", []string{"attn", "card", "add", "--project", "familiar", "--title", "Build imp attn", "--lane", "clarified", "--summary", "-", "--owner", "kes", "--policy", "ship-quiet", "--json"}, "shape requests\n", "card.add", map[string]any{"project": "familiar", "title": "Build imp attn", "lane": "clarified", "summary": "shape requests", "owner": "kes", "policy": "ship-quiet"}},
		{"card.add-title-stdin", []string{"attn", "card", "add", "--project", "familiar", "--title", "-", "--json"}, "From stdin\n", "card.add", map[string]any{"project": "familiar", "title": "From stdin"}},
		{"card.set", []string{"attn", "card", "set", "c1", "--title", "New", "--summary", "S", "--owner", "kevin", "--policy", "talk-first", "--json"}, "", "card.set", map[string]any{"id": "c1", "title": "New", "summary": "S", "owner": "kevin", "policy": "talk-first"}},
		{"card.set-policy-default", []string{"attn", "card", "set", "c1", "--policy", "default", "--json"}, "", "card.set", map[string]any{"id": "c1", "policy": nil}},
		{"card.move", []string{"attn", "card", "move", "c1", "inflight", "--json"}, "", "card.move", map[string]any{"id": "c1", "lane": "inflight"}},
		{"card.block", []string{"attn", "card", "block", "c1", "--reason", "waiting on Kevin", "--json"}, "", "card.block", map[string]any{"id": "c1", "reason": "waiting on Kevin"}},
		{"card.unblock", []string{"attn", "card", "unblock", "c1", "--json"}, "", "card.unblock", map[string]any{"id": "c1"}},
		{"card.done", []string{"attn", "card", "done", "c1", "--json"}, "", "card.done", map[string]any{"id": "c1", "done": true}},
		{"card.done-undo", []string{"attn", "card", "done", "c1", "--undo", "--json"}, "", "card.done", map[string]any{"id": "c1", "done": false}},
		{"note.add", []string{"attn", "note", "add", "c1", "--text", "one line", "--detail", "-", "--json"}, "more\ndetail\n", "note.add", map[string]any{"card": "c1", "text": "one line", "detail": "more\ndetail"}},
		{"evidence.add", []string{"attn", "evidence", "add", "c1", "--kind", "pr", "--title", "PR 12", "--ref", "https://example/pr/12", "--meta", `{"adds":3,"dels":1}`, "--json"}, "", "evidence.add", map[string]any{"card": "c1", "kind": "pr", "title": "PR 12", "ref": "https://example/pr/12", "meta": map[string]any{"adds": float64(3), "dels": float64(1)}}},
		{"agent.start", []string{"attn", "agent", "start", "c1", "--name", "job-1", "--model", "p/m", "--host", "worker-a", "--harness", "pi", "--json"}, "", "agent.start", map[string]any{"card": "c1", "name": "job-1", "model": "p/m", "host": "worker-a", "harness": "pi"}},
		{"agent.set", []string{"attn", "agent", "set", "c1", "--name", "job-1", "--state", "blocked", "--question", "merge?", "--json"}, "", "agent.set", map[string]any{"card": "c1", "name": "job-1", "state": "blocked", "question": "merge?"}},
		{"jot.add", []string{"attn", "jot", "add", "--title", "call the bank", "--json"}, "", "jot.add", map[string]any{"title": "call the bank"}},
		{"jot.add-kes", []string{"attn", "jot", "add", "--title", "-", "--owner", "kes", "--json"}, "look into the flake\n", "jot.add", map[string]any{"title": "look into the flake", "owner": "kes"}},
		{"jot.list", []string{"attn", "jot", "list", "--json"}, "", "jot.list", map[string]any{}},
		{"jot.clear-done", []string{"attn", "jot", "clear-done", "--json"}, "", "jot.clear-done", map[string]any{}},
		{"status", []string{"attn", "status", "--json"}, "", "status", map[string]any{}},
	}
	seen := map[string]bool{}
	for _, tc := range cases {
		seen[tc.operation] = true
		t.Run(tc.name, func(t *testing.T) {
			code, out, stderr := runWithSocket(t, tc.argv, tc.stdin, card, func(got Request) {
				if got.Version != 1 || got.Area != "attn" || got.Operation != tc.operation {
					t.Errorf("envelope: %#v", got)
				}
				want, _ := json.Marshal(tc.args)
				have, _ := json.Marshal(got.Args)
				if !bytes.Equal(have, want) {
					t.Errorf("args=%s want %s", have, want)
				}
			})
			if code != 0 || stderr != "" || out != "{\"id\":\"c1\"}\n" {
				t.Fatalf("code=%d out=%q err=%q", code, out, stderr)
			}
		})
	}
	for noun, verbs := range attnVerbs {
		for _, verb := range verbs {
			if !seen[noun+"."+verb] {
				t.Errorf("no request-shaping case for %s.%s", noun, verb)
			}
		}
	}
	if !seen["status"] {
		t.Error("no request-shaping case for status")
	}
}

func TestAttnLocalValidation(t *testing.T) {
	// Unscoped card list errors locally with a helpful message and no request.
	var out, stderr bytes.Buffer
	code := Main([]string{"attn", "card", "list"}, strings.NewReader(""), &out, &stderr, func(string) string { return "/never/dialled.sock" })
	if code != ExitUsage || !strings.Contains(stderr.String(), "--project") || !strings.Contains(stderr.String(), "--lane") {
		t.Fatalf("code=%d err=%q", code, stderr.String())
	}
	bad := [][]string{
		{"attn", "card", "list", "--owner", "kes"},
		{"attn", "card", "list", "--lane", "somewhere"},
		{"attn", "card", "add", "--title", "no project"},
		{"attn", "card", "add", "--project", "p"},
		{"attn", "card", "add", "--project", "p", "--title", "-", "--summary", "-"},
		{"attn", "card", "set", "c1"},
		{"attn", "card", "set", "c1", "--policy", "loud"},
		{"attn", "card", "move", "c1"},
		{"attn", "card", "move", "c1", "sideways"},
		{"attn", "card", "block", "c1"},
		{"attn", "card", "done"},
		{"attn", "note", "add", "c1"},
		{"attn", "evidence", "add", "c1", "--kind", "tweet", "--title", "x"},
		{"attn", "evidence", "add", "c1", "--kind", "pr", "--title", "x", "--meta", "[1]"},
		{"attn", "agent", "start", "c1"},
		{"attn", "agent", "set", "c1", "--name", "n", "--state", "sleeping"},
		{"attn", "jot", "add"},
		{"attn", "jot", "list", "extra"},
		{"attn", "status", "--project", "p"},
		{"attn", "project", "add", "--label", "no slug"},
	}
	for _, argv := range bad {
		var out, stderr bytes.Buffer
		if code := Main(argv, strings.NewReader(""), &out, &stderr, func(string) string { return "/never/dialled.sock" }); code != ExitUsage {
			t.Errorf("%v code=%d err=%s", argv, code, stderr.String())
		}
	}
	// Stdin prose is bounded to 64 KiB.
	out.Reset()
	stderr.Reset()
	code = Main([]string{"attn", "jot", "add", "--title", "-"}, strings.NewReader(strings.Repeat("x", MaxProseBytes+1)), &out, &stderr, func(string) string { return "" })
	if code != ExitUsage || !strings.Contains(stderr.String(), "exceeds") {
		t.Fatalf("code=%d err=%q", code, stderr.String())
	}
}

func TestAttnBoundedListRendering(t *testing.T) {
	var cards []string
	for i := 0; i < 64; i++ {
		cards = append(cards, fmt.Sprintf(`{"id":"%08d-aaaa-bbbb","project":"familiar","lane":"inflight","title":"Card %d","owner":"kes","policy":null,"effective_policy":"ship-tell","diverges":false,"blocked":null,"edge":"live","age_s":%d,"moved_s":60,"agents":{"running":1,"blocked":0},"notes":0,"evidence":0}`, i, i, 3600*(i+1)))
	}
	result := `{"ok":true,"result":{"cards":[` + strings.Join(cards, ",") + `],"total":70,"truncated":true}}` + "\n"
	code, out, stderr := runWithSocket(t, []string{"attn", "card", "list", "--project", "familiar"}, "", result, nil)
	if code != 0 || stderr != "" {
		t.Fatalf("code=%d err=%q", code, stderr)
	}
	lines := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	if len(lines) != 65 {
		t.Fatalf("rows=%d want 64 + footer:\n%s", len(lines), out)
	}
	if lines[0] != "00000000  inflight  kes  1h  Card 0" {
		t.Errorf("row=%q", lines[0])
	}
	if lines[64] != "… and 6 more" {
		t.Errorf("footer=%q", lines[64])
	}

	// A bare array larger than 64 rows is clipped locally too.
	extra := append(cards, `{"id":"deadbeef-1","project":"familiar","lane":"review","title":"Diverging","owner":null,"policy":"talk-first","effective_policy":"talk-first","diverges":true,"blocked":"needs Kevin","age_s":200000,"moved_s":1,"agents":{"running":0,"blocked":0}}`)
	result = `{"ok":true,"result":[` + strings.Join(extra, ",") + `]}` + "\n"
	_, out, _ = runWithSocket(t, []string{"attn", "card", "list", "--lane", "review"}, "", result, nil)
	lines = strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	if len(lines) != 65 || lines[64] != "… and 1 more" {
		t.Fatalf("bare array clip: %d lines, last=%q", len(lines), lines[len(lines)-1])
	}

	// Diverging policy and blocked markers, and an empty list.
	result = `{"ok":true,"result":[` + extra[64] + `]}` + "\n"
	_, out, _ = runWithSocket(t, []string{"attn", "jot", "list"}, "", result, nil)
	if out != "deadbeef  review  -  talk-first  !blocked  2d  Diverging\n" {
		t.Errorf("out=%q", out)
	}
	_, out, _ = runWithSocket(t, []string{"attn", "jot", "list"}, "", "{\"ok\":true,\"result\":[]}\n", nil)
	if out != "No jots.\n" {
		t.Errorf("out=%q", out)
	}
}

func TestAttnCardGetHumanOutput(t *testing.T) {
	full := `{"id":"c1","project":"familiar","lane":"review","title":"Build imp attn","owner":"kes","policy":"pr-evidence","effective_policy":"pr-evidence","diverges":true,"blocked":null,"edge":"review","age_s":7200,"moved_s":600,"agents":{"running":0,"blocked":0},"summary":"Shape requests.\nPrint results.","notes":[{"at":"2026-09-21T10:00:00Z","by":"kes","text":"tests pass","detail":"go test ok"}],"evidence":[{"at":"2026-09-21T09:00:00Z","kind":"pr","title":"PR 12","ref":"https://example/pr/12","meta":{"adds":3}}],"agents_list":[],"timeline":[{"at":"2026-09-21T08:00:00Z","actor":"kes","kind":"created","text":"created in captured"},"moved to review"],"event_count":40,"events":[{"id":1,"data":"RAW-EVENT-LOG"}]}`
	code, out, stderr := runWithSocket(t, []string{"attn", "card", "get", "c1"}, "", "{\"ok\":true,\"result\":"+full+"}\n", nil)
	if code != 0 || stderr != "" {
		t.Fatalf("code=%d err=%q", code, stderr)
	}
	want := "Build imp attn\n" +
		"project: familiar  lane: review  owner: kes  policy: pr-evidence\n" +
		"id: c1  captured 2h ago  moved 10m ago\n" +
		"Summary:\n  Shape requests.\n  Print results.\n" +
		"Evidence:\n  pr  PR 12  https://example/pr/12\n" +
		"Timeline:\n  2026-09-21T08:00:00Z  kes  created in captured\n  moved to review\n  (40 events in full history; use --json)\n" +
		"Notes:\n  2026-09-21T10:00:00Z kes: tests pass\n    go test ok\n"
	if out != want {
		t.Fatalf("out=%q\nwant=%q", out, want)
	}
	if strings.Contains(out, "RAW-EVENT-LOG") {
		t.Fatal("raw event log leaked into human output")
	}
	_, out, _ = runWithSocket(t, []string{"attn", "card", "get", "c1", "--json"}, "", "{\"ok\":true,\"result\":"+full+"}\n", nil)
	if out != full+"\n" {
		t.Fatalf("json passthrough altered: %q", out)
	}
}

func TestAttnOtherHumanOutput(t *testing.T) {
	projects := `{"ok":true,"result":[{"slug":"familiar","label":"Familiar","default_policy":"ship-tell","repo":null,"counts":{"captured":2,"clarified":1,"inflight":0,"review":1,"settling":0}}]}` + "\n"
	_, out, _ := runWithSocket(t, []string{"attn", "project", "list"}, "", projects, nil)
	if out != "familiar  Familiar  ship-tell  captured=2 clarified=1 inflight=0 review=1 settling=0\n" {
		t.Errorf("out=%q", out)
	}
	status := `{"ok":true,"result":{"agents":{"running":2,"blocked":1},"needs_attention":3,"inflight":4,"jots":{"open":5,"stale":1}}}` + "\n"
	_, out, _ = runWithSocket(t, []string{"attn", "status"}, "", status, nil)
	if out != "agents: 2 running, 1 blocked  needs attention: 3  in flight: 4  jots: 5 open, 1 stale\n" {
		t.Errorf("out=%q", out)
	}
	_, out, _ = runWithSocket(t, []string{"attn", "jot", "clear-done"}, "", "{\"ok\":true,\"result\":{\"archived\":3}}\n", nil)
	if out != "archived 3\n" {
		t.Errorf("out=%q", out)
	}
	code, out, stderr := runWithSocket(t, []string{"attn", "status"}, "", "{\"ok\":false,\"error\":{\"code\":\"unavailable\",\"message\":\"attn unavailable in this owning Familiar resident\"}}\n", nil)
	if code != ExitUnavailable || out != "" || !strings.Contains(stderr, "unavailable") {
		t.Errorf("code=%d out=%q err=%q", code, out, stderr)
	}
}
