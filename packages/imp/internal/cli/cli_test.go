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
	cases := [][]string{{"--help"}, {"attn"}, {"attn", "--help"}, {"attn", "card"}, {"attn", "card", "--help"}, {"attn", "card", "list", "--help"}, {"attn", "status", "--help"}}
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

func TestUsageAndUnavailableFailures(t *testing.T) {
	var out, err bytes.Buffer
	if code := Main([]string{"removed", "status"}, strings.NewReader(""), &out, &err, func(string) string { return "" }); code != ExitUsage {
		t.Fatalf("usage code=%d", code)
	}
	out.Reset()
	err.Reset()
	if code := Main([]string{"attn", "status"}, strings.NewReader(""), &out, &err, func(string) string { return "" }); code != ExitUnavailable {
		t.Fatalf("unavailable code=%d", code)
	}
	if !strings.Contains(err.String(), "FAMILIAR_IMP_SOCKET") {
		t.Fatal(err.String())
	}
}

func TestRemoteFailure(t *testing.T) {
	code, out, stderr := runWithSocket(t, []string{"attn", "status"}, "", "{\"ok\":false,\"error\":{\"code\":\"not_found\",\"message\":\"no such item\"}}\n", nil)
	if code != ExitRemote || out != "" || !strings.Contains(stderr, "not_found: no such item") {
		t.Fatalf("code=%d out=%q err=%q", code, out, stderr)
	}
}

func TestBoundedAndStrictResponse(t *testing.T) {
	oversized := append(bytes.Repeat([]byte("x"), MaxWireBytes+1), '\n')
	path := serveOnce(t, oversized, nil)
	var out, stderr bytes.Buffer
	code := Main([]string{"attn", "status"}, strings.NewReader(""), &out, &stderr, func(string) string { return path })
	if code != ExitProtocol || !strings.Contains(stderr.String(), "exceeds") {
		t.Fatalf("code=%d err=%q", code, stderr.String())
	}

	code, _, msg := runWithSocket(t, []string{"attn", "status"}, "", "{\"ok\":true,\"result\":[]}\n{\"ok\":true,\"result\":[]}\n", nil)
	if code != ExitProtocol || !strings.Contains(msg, "more or fewer") {
		t.Fatalf("code=%d err=%q", code, msg)
	}
}

func TestTimeoutIsBounded(t *testing.T) {
	old := ioTimeout
	ioTimeout = 30 * time.Millisecond
	defer func() { ioTimeout = old }()
	path := serveOnce(t, nil, func(Request) { time.Sleep(100 * time.Millisecond) })
	var out, stderr bytes.Buffer
	start := time.Now()
	code := Main([]string{"attn", "status"}, strings.NewReader(""), &out, &stderr, func(string) string { return path })
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
	_, _, err = call(path, Request{Version: 1, Area: "attn", Operation: "status", Args: map[string]any{}})
	if err == nil || !strings.Contains(err.Error(), "not private") {
		t.Fatalf("err=%v", err)
	}
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
	pinAttnNow(t)
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
		{"card.list-project", []string{"attn", "card", "list", "--project", "familiar", "--owner", "kes", "--edge", "blocked", "--q", "imp", "--json"}, "", "card.list", map[string]any{"project": "familiar", "owner": "kes", "edge": "blocked", "q": "imp", "order": "updated", "offset": float64(0), "limit": float64(64)}},
		{"card.list-paged", []string{"attn", "card", "list", "--project", "actabl", "--order", "created", "--offset", "64", "--limit", "10", "--since", "6h", "--created-since", "2026-10-14", "--json"}, "", "card.list", map[string]any{"project": "actabl", "order": "created", "offset": float64(64), "limit": float64(10), "since": "2026-10-14T22:30:00Z", "created_since": "2026-10-14T05:00:00Z"}},
		{"card.list-lane", []string{"attn", "card", "list", "--lane", "review", "--json"}, "", "card.list", map[string]any{"lane": "review", "order": "updated", "offset": float64(0), "limit": float64(64)}},
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
		{"jot.add-due", []string{"attn", "jot", "add", "--title", "septic", "--due", "fri", "--json"}, "", "jot.add", map[string]any{"title": "septic", "due": "2026-10-16"}},
		{"jot.list-all", []string{"attn", "jot", "list", "--all", "--json"}, "", "jot.list", map[string]any{"all": true}},
		{"card.set-due", []string{"attn", "card", "set", "c1", "--due", "tomorrow", "--json"}, "", "card.set", map[string]any{"id": "c1", "due": "2026-10-15"}},
		{"card.set-due-none", []string{"attn", "card", "set", "c1", "--due", "none", "--maybe-on", "2026-11-02", "--json"}, "", "card.set", map[string]any{"id": "c1", "due": nil, "maybe_on": "2026-11-02"}},
		{"card.set-maybe-none", []string{"attn", "card", "set", "c1", "--maybe-on", "none", "--json"}, "", "card.set", map[string]any{"id": "c1", "maybe_on": nil}},
		{"ask.add", []string{"attn", "ask", "add", "--json-in", "--json"}, `{"card":"6c5e0e39","question":"Close M4?","actions":[{"key":"close","label":"Close it","primary":true,"ops":[{"op":"card.move","id":"6c5e0e39","lane":"archived"}]}]}` + "\n", "ask.add", map[string]any{"card": "6c5e0e39", "question": "Close M4?", "actions": []any{map[string]any{"key": "close", "label": "Close it", "primary": true, "ops": []any{map[string]any{"op": "card.move", "id": "6c5e0e39", "lane": "archived"}}}}}},
		{"ask.add-stage", []string{"attn", "ask", "add", "--json-in", "--stage", "--json"}, `{"card":"6c5e0e39","question":"Q?","actions":[]}`, "ask.add", map[string]any{"card": "6c5e0e39", "question": "Q?", "actions": []any{}, "stage": true}},
		{"ask.list", []string{"attn", "ask", "list", "--json"}, "", "ask.list", map[string]any{}},
		{"ask.list-all", []string{"attn", "ask", "list", "--all", "--json"}, "", "ask.list", map[string]any{"all": true}},
		{"ask.resolve", []string{"attn", "ask", "resolve", "7", "close", "--json"}, "", "ask.resolve", map[string]any{"id": 7, "choice": "close"}},
		{"ask.resolve-not-now", []string{"attn", "ask", "resolve", "#7", "not-now", "--json"}, "", "ask.resolve", map[string]any{"id": 7, "choice": "not-now"}},
		{"ask.more", []string{"attn", "ask", "more", "--json"}, "", "ask.more", map[string]any{}},
		{"ask.drop", []string{"attn", "ask", "drop", "7", "--json"}, "", "ask.drop", map[string]any{"id": 7}},
		{"ask.surface", []string{"attn", "ask", "surface", "7", "--json"}, "", "ask.surface", map[string]any{"id": 7}},
		{"ask.talk", []string{"attn", "ask", "talk", "7", "--json"}, "", "ask.talk", map[string]any{"id": 7}},
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
		{"attn", "card", "list", "--project", "p", "--order", "oldest"},
		{"attn", "card", "list", "--project", "p", "--limit", "65"},
		{"attn", "card", "list", "--project", "p", "--limit", "0"},
		{"attn", "card", "list", "--project", "p", "--offset", "-1"},
		{"attn", "card", "list", "--project", "p", "--since", "last week"},
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
	if lines[64] != "… and 6 more (next: --offset 64)" {
		t.Errorf("footer=%q", lines[64])
	}

	// A bare array larger than 64 rows is clipped locally too.
	extra := append(cards, `{"id":"deadbeef-1","project":"familiar","lane":"review","title":"Diverging","owner":null,"policy":"talk-first","effective_policy":"talk-first","diverges":true,"blocked":"needs Kevin","age_s":200000,"moved_s":1,"agents":{"running":0,"blocked":0}}`)
	result = `{"ok":true,"result":[` + strings.Join(extra, ",") + `]}` + "\n"
	_, out, _ = runWithSocket(t, []string{"attn", "card", "list", "--lane", "review"}, "", result, nil)
	lines = strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	if len(lines) != 65 || lines[64] != "… and 1 more (next: --offset 64)" {
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

// pinAttnNow fixes the DATE clock at Wed 2026-10-14 23:30 America/Chicago,
// which is already Thursday in UTC.
func pinAttnNow(t *testing.T) {
	t.Helper()
	old := attnNow
	attnNow = func() time.Time { return time.Date(2026, 10, 15, 4, 30, 0, 0, time.UTC) }
	t.Cleanup(func() { attnNow = old })
}

func TestParseAttnDate(t *testing.T) {
	// Wednesday evening in Chicago (Thursday in UTC).
	now := time.Date(2026, 10, 15, 4, 30, 0, 0, time.UTC)
	for in, want := range map[string]string{
		"2026-12-25": "2026-12-25",
		"today":      "2026-10-14",
		"Tomorrow":   "2026-10-15",
		"wed":        "2026-10-14", // today counts
		"Wednesday":  "2026-10-14",
		"thu":        "2026-10-15",
		"thurs":      "2026-10-15",
		"fri":        "2026-10-16",
		"sat":        "2026-10-17",
		"sun":        "2026-10-18",
		"mon":        "2026-10-19",
		"tue":        "2026-10-20", // furthest: 6 days out
		"tuesday":    "2026-10-20",
	} {
		got, err := parseAttnDate(in, now)
		if err != nil || got != want {
			t.Errorf("%s: got %q %v want %q", in, got, err, want)
		}
	}
	// Month rollover and Sunday-as-today.
	if got, _ := parseAttnDate("fri", time.Date(2026, 10, 30, 18, 0, 0, 0, time.UTC)); got != "2026-10-30" {
		t.Errorf("fri on Fri 10-30: %q", got)
	}
	if got, _ := parseAttnDate("mon", time.Date(2026, 10, 30, 18, 0, 0, 0, time.UTC)); got != "2026-11-02" {
		t.Errorf("mon rollover: %q", got)
	}
	for _, bad := range []string{"", "someday", "2026-13-01", "2026-02-30", "10/14/2026", "next fri", "none"} {
		if got, err := parseAttnDate(bad, now); err == nil {
			t.Errorf("%q accepted as %q", bad, got)
		}
	}
}

func TestAttnDateFlagValidation(t *testing.T) {
	pinAttnNow(t)
	for _, argv := range [][]string{
		{"attn", "jot", "add", "--title", "x", "--due", "none"},
		{"attn", "jot", "add", "--title", "x", "--due", "someday"},
		{"attn", "card", "set", "c1", "--due", "soon"},
		{"attn", "card", "set", "c1", "--maybe-on", "2026-99-01"},
		{"attn", "ask", "add"},                   // --json-in required
		{"attn", "ask", "add", "--json-in"},      // empty stdin
		{"attn", "ask", "resolve", "7"},          // no choice
		{"attn", "ask", "resolve", "x", "close"}, // bad id
		{"attn", "ask", "drop", "0"},             // bad id
		{"attn", "ask", "more", "extra"},         // stray arg
		{"attn", "ask", "list", "--stage"},       // flag not for list
	} {
		var out, stderr bytes.Buffer
		if code := Main(argv, strings.NewReader(""), &out, &stderr, func(string) string { return "/never/dialled.sock" }); code != ExitUsage {
			t.Errorf("%v code=%d err=%s", argv, code, stderr.String())
		}
	}
	for _, body := range []string{`[1]`, `"x"`, `null`, `{"a":1} {"b":2}`, `{`} {
		var out, stderr bytes.Buffer
		if code := Main([]string{"attn", "ask", "add", "--json-in"}, strings.NewReader(body), &out, &stderr, func(string) string { return "/never/dialled.sock" }); code != ExitUsage {
			t.Errorf("body %q code=%d err=%s", body, code, stderr.String())
		}
	}
}

func TestAskListHumanOutput(t *testing.T) {
	list := `{"surfaced":[` +
		`{"id":7,"card":{"id":"6c5e0e39-0000","project":"familiar-services","title":"M4"},"question":"Close M4?","actions":[{"key":"close","label":"Close it","primary":true},{"key":"keep","label":"Keep"}],"state":"surfaced"},` +
		`{"id":8,"card":{"id":"aaaaaaaa-0000","project":"familiar","title":"T"},"question":"Two\nlines?","actions":[{"key":"yes","label":"Y"}],"state":"surfaced"}],` +
		`"staged":[{"id":9,"card":{"id":"bbbbbbbb-0000","project":"familiar","title":"T"},"question":"Later?","actions":[{"key":"ok","label":"OK"},{"key":"no","label":"No"}],"state":"staged"}]`
	resolved := `,"resolved":[{"id":3,"card":{"id":"cccccccc","project":"familiar","title":"T"},"question":"Old?","actions":[{"key":"a","label":"A"}],"state":"resolved","resolution":"a"}]`
	_, out, stderr := runWithSocket(t, []string{"attn", "ask", "list"}, "", `{"ok":true,"result":`+list+`}}`+"\n", nil)
	want := "#7 [surfaced] familiar-services · Close M4? — close|keep\n" +
		"#8 [surfaced] familiar · Two lines? — yes\n" +
		"#9 [staged] familiar · Later? — ok|no\n"
	if out != want || stderr != "" {
		t.Fatalf("out=%q err=%q", out, stderr)
	}
	_, out, _ = runWithSocket(t, []string{"attn", "ask", "list", "--all"}, "", `{"ok":true,"result":`+list+resolved+`}}`+"\n", nil)
	if out != want+"#3 [resolved] familiar · Old? — a\n" {
		t.Fatalf("--all out=%q", out)
	}
	_, out, _ = runWithSocket(t, []string{"attn", "ask", "list"}, "", `{"ok":true,"result":{"surfaced":[],"staged":[]}}`+"\n", nil)
	if out != "No asks.\n" {
		t.Errorf("empty out=%q", out)
	}
	_, out, _ = runWithSocket(t, []string{"attn", "ask", "list", "--json"}, "", `{"ok":true,"result":{"surfaced":[],"staged":[]}}`+"\n", nil)
	if out != `{"surfaced":[],"staged":[]}`+"\n" {
		t.Errorf("json out=%q", out)
	}
}

func TestAskConfirmations(t *testing.T) {
	ask := `{"id":7,"card":{"id":"c1","project":"p","title":"t"},"question":"Q?","actions":[],"state":"%s","resolution":%s}`
	for _, tc := range []struct {
		argv   []string
		stdin  string
		result string
		want   string
	}{
		{[]string{"attn", "ask", "add", "--json-in"}, `{"card":"c1","question":"Q?","actions":[]}`, fmt.Sprintf(ask, "surfaced", "null"), "asked #7 [surfaced]\n"},
		{[]string{"attn", "ask", "add", "--json-in", "--stage"}, `{"card":"c1","question":"Q?","actions":[]}`, fmt.Sprintf(ask, "staged", "null"), "asked #7 [staged]\n"},
		{[]string{"attn", "ask", "resolve", "7", "close"}, "", `{"resolved":` + fmt.Sprintf(ask, "resolved", `"close"`) + `,"card":{"id":"c1"}}`, "resolved #7 (close)\n"},
		{[]string{"attn", "ask", "more"}, "", `{"surfaced":2,"staged_left":1}`, "surfaced 2 more; 1 staged left\n"},
		{[]string{"attn", "ask", "drop", "7"}, "", fmt.Sprintf(ask, "dropped", `"dropped"`), "dropped #7\n"},
		{[]string{"attn", "ask", "surface", "7"}, "", fmt.Sprintf(ask, "surfaced", "null"), "surfaced #7\n"},
		{[]string{"attn", "ask", "talk", "7"}, "", fmt.Sprintf(ask, "surfaced", "null"), "noted conversation about #7\n"},
	} {
		code, out, stderr := runWithSocket(t, tc.argv, tc.stdin, `{"ok":true,"result":`+tc.result+"}\n", nil)
		if code != 0 || out != tc.want || stderr != "" {
			t.Errorf("%v: code=%d out=%q err=%q want %q", tc.argv, code, out, stderr, tc.want)
		}
	}
}

func TestJotRowsShowDueAndMaybe(t *testing.T) {
	pinAttnNow(t) // Wed 2026-10-14 in Chicago
	row := func(due, maybe string) string {
		return `{"id":"deadbeef-1","project":"_today","lane":"captured","title":"Septic","owner":"kevin","effective_policy":"ship-tell","age_s":7200,"agents":{"running":0,"blocked":0},"due":` + due + `,"maybe_on":` + maybe + `}`
	}
	result := `{"ok":true,"result":[` + strings.Join([]string{
		row(`"2026-10-14"`, `null`),
		row(`"2026-10-16"`, `null`),
		row(`"2026-10-12"`, `null`),
		row(`"2027-01-05"`, `null`),
		row(`null`, `"2026-10-14"`),
		row(`null`, `null`),
	}, ",") + `]}` + "\n"
	_, out, _ := runWithSocket(t, []string{"attn", "jot", "list", "--all"}, "", result, nil)
	want := "deadbeef  captured  kevin  due today  2h  Septic\n" +
		"deadbeef  captured  kevin  due Fri  2h  Septic\n" +
		"deadbeef  captured  kevin  due Mon  2h  Septic\n" +
		"deadbeef  captured  kevin  due 2027-01-05  2h  Septic\n" +
		"deadbeef  captured  kevin  maybe  2h  Septic\n" +
		"deadbeef  captured  kevin  maybe  2h  Septic\n"
	if out != want {
		t.Fatalf("out=%q\nwant=%q", out, want)
	}
}

func TestStatusAsksLine(t *testing.T) {
	status := `{"ok":true,"result":{"agents":{"running":2,"blocked":1},"needs_attention":3,"inflight":4,"asks":{"surfaced":3,"staged":2},"jots":{"open":5,"stale":1}}}` + "\n"
	_, out, _ := runWithSocket(t, []string{"attn", "status"}, "", status, nil)
	if out != "agents: 2 running, 1 blocked  asks: 3 surfaced, 2 staged  jots: 5 open, 1 stale\n" {
		t.Errorf("out=%q", out)
	}
}

func TestAskHelp(t *testing.T) {
	var out bytes.Buffer
	if Main([]string{"attn", "ask", "add", "--help"}, strings.NewReader(""), &out, &out, func(string) string { return "" }) != 0 || !strings.Contains(out.String(), "--json-in") || !strings.Contains(out.String(), "--stage") {
		t.Fatalf("help: %q", out.String())
	}
	for _, key := range []string{"jot.add", "card.set", "jot.list"} {
		if u := attnUsage[key]; !strings.Contains(u, "DATE") && key != "jot.list" || (key == "jot.list" && !strings.Contains(u, "--all")) {
			t.Errorf("usage %s lacks new flags: %q", key, u)
		}
	}
}

func TestParseAttnSince(t *testing.T) {
	now := time.Date(2026, 10, 15, 4, 30, 0, 0, time.UTC) // Wed 23:30 Chicago (CDT)
	for in, want := range map[string]string{
		"90m":                  "2026-10-15T03:00:00Z",
		"6h":                   "2026-10-14T22:30:00Z",
		"2d":                   "2026-10-13T04:30:00Z",
		"today":                "2026-10-14T05:00:00Z",
		"yesterday":            "2026-10-13T05:00:00Z",
		"2026-10-01":           "2026-10-01T05:00:00Z",
		"2026-10-14T19:23:00Z": "2026-10-14T19:23:00Z",
	} {
		got, err := parseAttnSince(in, now)
		if err != nil || got != want {
			t.Errorf("%s: got %q %v, want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "-2h", "-1d", "last week", "2026-13-01"} {
		if _, err := parseAttnSince(bad, now); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestAttnPagedFooter(t *testing.T) {
	row := `{"id":"%08d-aaaa","project":"actabl","lane":"captured","title":"C%d","owner":"kevin","policy":null,"effective_policy":"ship-tell","diverges":false,"blocked":null,"edge":null,"age_s":60,"moved_s":60,"agents":{"running":0,"blocked":0}}`
	var items []string
	for i := 0; i < 10; i++ {
		items = append(items, fmt.Sprintf(row, i, i))
	}
	result := `{"ok":true,"result":{"items":[` + strings.Join(items, ",") + `],"total":151,"offset":64,"truncated":true}}` + "\n"
	_, out, _ := runWithSocket(t, []string{"attn", "card", "list", "--project", "actabl", "--offset", "64", "--limit", "10"}, "", result, nil)
	lines := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	if len(lines) != 11 || lines[10] != "… and 77 more (next: --offset 74)" {
		t.Fatalf("%d lines, footer %q", len(lines), lines[len(lines)-1])
	}
	result = `{"ok":true,"result":{"items":[` + strings.Join(items[:5], ",") + `],"total":69,"offset":64,"truncated":false}}` + "\n"
	_, out, _ = runWithSocket(t, []string{"attn", "card", "list", "--project", "actabl", "--offset", "64"}, "", result, nil)
	if strings.Contains(out, "more") {
		t.Fatalf("last page has a footer:\n%s", out)
	}
}
