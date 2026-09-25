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
