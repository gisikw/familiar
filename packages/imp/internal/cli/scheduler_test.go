package cli

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func runSchedulerSocket(t *testing.T, argv []string, inspect func(serviceRequest)) (int, string, string) {
	t.Helper()
	dir := t.TempDir()
	os.Chmod(dir, 0700)
	path := filepath.Join(dir, "scheduler.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, e := ln.Accept()
		if e != nil {
			return
		}
		defer c.Close()
		line, _ := bufio.NewReader(c).ReadBytes('\n')
		var req serviceRequest
		_ = json.Unmarshal(line, &req)
		inspect(req)
		c.Write([]byte(`{"ok":true,"result":{"event":{"id":"e1","due_at":1000},"created":true}}` + "\n"))
	}()
	var out, stderr bytes.Buffer
	code := Main(argv, strings.NewReader(""), &out, &stderr, func(k string) string {
		if k == "FAMILIAR_SERVICES_SOCKET" {
			return path
		}
		if k == "FAMILIAR_INSTANCE_ID" {
			return "session-a"
		}
		return ""
	})
	return code, out.String(), stderr.String()
}
func TestScheduleFakeSocketCarriesInferredOrigin(t *testing.T) {
	code, out, stderr := runSchedulerSocket(t, []string{"schedule", "--in", "30m", "--target", "instance:peer", "--soft", "check deployment"}, func(req serviceRequest) {
		if req.Op != "schedule.enqueue" {
			t.Errorf("op=%s", req.Op)
		}
		if req.Args["origin"] != "session-a" || req.Args["target"] != "instance:peer" || req.Args["urgency"] != "soft" {
			t.Errorf("args=%#v", req.Args)
		}
		if _, ok := req.Args["due_at"].(float64); !ok {
			t.Errorf("missing due_at: %#v", req.Args)
		}
	})
	if code != 0 || stderr != "" || !strings.HasPrefix(out, "e1  ") {
		t.Fatalf("code=%d out=%q err=%q", code, out, stderr)
	}
}
func TestSchedulerParsing(t *testing.T) {
	now := mustTime(t, "2026-01-01T12:00:00Z")
	inv, _, err := parseScheduler([]string{"dnd", "on", "3h"}, now)
	if err != nil || inv.op != "dnd.set" || inv.args["duration_ms"] != int64(10800000) {
		t.Fatalf("dnd: %#v %v", inv, err)
	}
	inv, _, err = parseScheduler([]string{"schedule", "--at", "11:00", "tomorrow"}, now)
	if err != nil || inv.args["due_at"] != mustTime(t, "2026-01-02T11:00:00Z").UnixMilli() {
		t.Fatalf("at: %#v %v", inv, err)
	}
	inv, _, err = parseScheduler([]string{"notify", "--soft", "PR deployed"}, now)
	if err != nil || inv.args["urgency"] != "soft" {
		t.Fatalf("soft notify: %#v %v", inv, err)
	}
}
func mustTime(t *testing.T, s string) time.Time {
	t.Helper()
	v, e := time.Parse(time.RFC3339, s)
	if e != nil {
		t.Fatal(e)
	}
	return v
}

func TestParsePush(t *testing.T) {
	inv, _, err := parseScheduler([]string{"push", "--title", "Kes", "hi love"}, time.Now())
	if err != nil || inv.op != "push.send" || inv.args["body"] != "hi love" || inv.args["title"] != "Kes" {
		t.Fatalf("push parse: %+v %v", inv, err)
	}
	if _, _, err := parseScheduler([]string{"push"}, time.Now()); err == nil {
		t.Fatal("push without a message must fail")
	}
	if _, _, err := parseScheduler([]string{"push", "--soft", "x"}, time.Now()); err == nil {
		t.Fatal("push --soft is meaningless and must fail")
	}
}

func pushArgsWith(t *testing.T, env map[string]string) map[string]any {
	t.Helper()
	dir := t.TempDir()
	os.Chmod(dir, 0700)
	path := filepath.Join(dir, "s.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := make(chan map[string]any, 1)
	go func() {
		c, e := ln.Accept()
		if e != nil {
			return
		}
		defer c.Close()
		line, _ := bufio.NewReader(c).ReadBytes('\n')
		var req serviceRequest
		_ = json.Unmarshal(line, &req)
		got <- req.Args
		c.Write([]byte(`{"ok":true,"result":{"sent":1,"failed":0}}` + "\n"))
	}()
	var out, stderr bytes.Buffer
	env["FAMILIAR_SERVICES_SOCKET"] = path
	if code := Main([]string{"push", "hi"}, strings.NewReader(""), &out, &stderr, func(k string) string { return env[k] }); code != 0 {
		t.Fatalf("code=%d err=%q", code, stderr.String())
	}
	return <-got
}

func TestPushFromForkCarriesItsSessionForTapDeepLink(t *testing.T) {
	fork := pushArgsWith(t, map[string]string{"FAMILIAR_PI_FORK": "1", "FAMILIAR_INSTANCE_ID": "fork-1"})
	if fork["session"] != "fork-1" || fork["origin"] != nil {
		t.Fatalf("fork push args=%#v", fork)
	}
	primary := pushArgsWith(t, map[string]string{"FAMILIAR_INSTANCE_ID": "primary-1"})
	if _, ok := primary["session"]; ok {
		t.Fatalf("primary push must not name a session (tap goes home): %#v", primary)
	}
}

func TestScheduleEveryForkCarriesRuleTypeAndTaskBody(t *testing.T) {
	code, out, stderr := runSchedulerSocket(t, []string{"schedule", "--every", "weekday 06:00", "--fork", "--label", "daily briefing", "Write today's briefing"}, func(req serviceRequest) {
		if req.Op != "schedule.enqueue" || req.Args["rule"] != "weekday 06:00" || req.Args["type"] != "fork" {
			t.Errorf("args=%#v", req.Args)
		}
		if _, has := req.Args["due_at"]; has {
			t.Errorf("--every alone lets the service pick the first occurrence: %#v", req.Args)
		}
		var body struct{ Task, Label string }
		if json.Unmarshal([]byte(req.Args["body"].(string)), &body) != nil || body.Task != "Write today's briefing" || body.Label != "daily briefing" {
			t.Errorf("body=%v", req.Args["body"])
		}
		// No fork.json for session-a: it is its own root, so the fork targets itself.
		if req.Args["target"] != "instance:session-a" {
			t.Errorf("target=%v", req.Args["target"])
		}
	})
	if code != 0 || !strings.Contains(out, "e1") {
		t.Fatalf("code=%d out=%q stderr=%q", code, out, stderr)
	}
}

func TestScheduleRejectsConfusedCombinations(t *testing.T) {
	for _, argv := range [][]string{
		{"schedule", "reason"},
		{"schedule", "--in", "1h", "--at", "06:00", "reason"},
		{"schedule", "--in", "1h", "--label", "x", "reason"},
		{"schedule", "--every", "day 06:00", "--fork", "--soft", "reason"},
	} {
		if _, _, err := parseScheduler(argv, time.Now()); err == nil {
			t.Errorf("%v: want error", argv)
		}
	}
	inv, _, err := parseScheduler([]string{"schedule", "list", "--all"}, time.Now())
	if err != nil || inv.args["all"] != true {
		t.Fatalf("list --all: %#v %v", inv, err)
	}
}

func TestRootInstanceFollowsForkParents(t *testing.T) {
	state := t.TempDir()
	for id, parent := range map[string]string{"grandchild": "child", "child": "primary"} {
		os.MkdirAll(filepath.Join(state, "forks", id), 0700)
		os.WriteFile(filepath.Join(state, "forks", id, "fork.json"), []byte(`{"parentSessionId":"`+parent+`"}`), 0600)
	}
	got := rootInstance(func(k string) string {
		return map[string]string{"FAMILIAR_INSTANCE_ID": "grandchild", "FAMILIAR_STATE_DIR": state}[k]
	})
	if got != "primary" {
		t.Fatalf("root=%q", got)
	}
}

func TestScheduleListHumanShowsKindRuleAndTarget(t *testing.T) {
	var buf, errw bytes.Buffer
	result := []byte(`[{"id":"brief-at-1","summary":"Daily briefing","state":"pending","target":"instance:01a015ff-13bd","type":"fork","urgency":"wake","rule":"day 06:00","series":"brief","due_at":1790395200000}]`)
	if code := writeSchedulerHuman(&buf, "schedule.list", result, &errw); code != 0 {
		t.Fatal(code)
	}
	line := buf.String()
	for _, want := range []string{"fork", "pending", "every day 06:00", "01a015ff", "brief-at-1", "Daily briefing"} {
		if !strings.Contains(line, want) {
			t.Errorf("list line %q missing %q", line, want)
		}
	}
}

func TestCarriesKesAllowlist(t *testing.T) {
	cases := []struct {
		model, list string
		want        bool
	}{
		{"tiamat-anthropic-tiamat/claude-opus-5-5-interactive", "", true},
		{"tiamat-anthropic-tiamat/claude-sonnet-5-interactive", "", true},
		{"tiamat-responses-codex-personal/gpt-5.6-sol", "", true},
		{"tiamat-openai-qwen-next-flash/Qwen3.8-Flash-Next-IQ4_NL-PROJFIX", "", true},
		{"tiamat-anthropic-claude-code-personal/claude-haiku-5", "", false},
		{"tiamat-anthropic/claude-sonnet-5", "", false},
		{"tiamat-anthropic/claude-sonnet-5", "*/claude-opus-*, */claude-sonnet-5", true},
		{"tiamat-responses-codex-personal/gpt-5.6-sol", "*/claude-*", false},
		{"x/claude-opus-5", "x/claude-opus-5", true},
	}
	for _, c := range cases {
		if got := carriesKes(c.model, c.list); got != c.want {
			t.Errorf("carriesKes(%q, %q) = %v, want %v", c.model, c.list, got, c.want)
		}
	}
}

func TestScheduleForkFreshModelRunner(t *testing.T) {
	t.Setenv("FAMILIAR_FORK_MODELS", "")
	now := time.Date(2026, 9, 25, 22, 0, 0, 0, time.UTC)
	inv, _, err := parseScheduler([]string{"schedule", "--every", "day 06:00", "--fork", "--fresh", "--model", "tiamat-anthropic-tiamat/claude-opus-5-5-interactive", "--label", "daily briefing", "Brief Kev"}, now)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(inv.args["body"].(string)), &body); err != nil {
		t.Fatal(err)
	}
	if body["fresh"] != true || body["model"] != "tiamat-anthropic-tiamat/claude-opus-5-5-interactive" || body["runner"] != nil {
		t.Fatalf("body = %v", body)
	}
	// A model that can't carry Kes is refused unless declared a runner.
	if _, _, err := parseScheduler([]string{"schedule", "--in", "1h", "--fork", "--model", "tiamat-anthropic/claude-haiku-5", "task"}, now); err == nil || !strings.Contains(err.Error(), "--runner") {
		t.Fatalf("expected refusal pointing at --runner, got %v", err)
	}
	inv, _, err = parseScheduler([]string{"schedule", "--in", "1h", "--fork", "--fresh", "--runner", "--model", "tiamat-anthropic/claude-haiku-5", "task"}, now)
	if err != nil {
		t.Fatal(err)
	}
	body = nil
	json.Unmarshal([]byte(inv.args["body"].(string)), &body)
	if body["runner"] != true {
		t.Fatalf("runner not carried: %v", body)
	}
	for _, bad := range [][]string{
		{"schedule", "--in", "1h", "--fresh", "not a fork"},
		{"schedule", "--in", "1h", "--fork", "--runner", "no model"},
		{"schedule", "--in", "1h", "--fork", "--model", "nomodelslash", "task"},
	} {
		if _, _, err := parseScheduler(bad, now); err == nil {
			t.Errorf("expected error for %v", bad)
		}
	}
}
