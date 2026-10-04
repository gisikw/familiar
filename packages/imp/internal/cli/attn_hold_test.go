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

func TestParseHoldUntil(t *testing.T) {
	now := time.Date(2026, 10, 3, 20, 0, 0, 0, time.UTC)
	for in, want := range map[string]time.Time{
		"90m":                  now.Add(90 * time.Minute),
		"36h":                  now.Add(36 * time.Hour),
		"2d":                   now.Add(48 * time.Hour),
		"2026-10-05T15:00:00Z": time.Date(2026, 10, 5, 15, 0, 0, 0, time.UTC),
		"09:00":                time.Date(2026, 10, 4, 9, 0, 0, 0, time.UTC),
	} {
		got, err := parseHoldUntil(in, now)
		if err != nil || !got.Equal(want) {
			t.Errorf("%s: got %v %v want %v", in, got, err, want)
		}
	}
	for _, bad := range []string{"tomorrow", "0d", "-1h", "2001-01-01T00:00:00Z", "99d"} {
		if _, err := parseHoldUntil(bad, now); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}

func TestHoldUntilLocalValidation(t *testing.T) {
	for _, argv := range [][]string{
		{"attn", "card", "move", "c1", "review", "--hold-until", "2d"},
		{"attn", "card", "move", "c1", "settling", "--hold-until", "someday"},
	} {
		var out, stderr bytes.Buffer
		if code := Main(argv, strings.NewReader(""), &out, &stderr, func(string) string { return "/never/dialled.sock" }); code != ExitUsage {
			t.Errorf("%v code=%d err=%s", argv, code, stderr.String())
		}
	}
	var out bytes.Buffer
	if Main([]string{"attn", "card", "move", "--help"}, strings.NewReader(""), &out, &out, func(string) string { return "" }) != 0 || !strings.Contains(out.String(), "--hold-until") || !strings.Contains(out.String(), "Kevin's") {
		t.Fatalf("help: %q", out.String())
	}
}

// A held move sends hold_until to the resident and schedules a wake with the
// scheduler for the hold time, targeting the root instance.
func TestHoldUntilSchedulesWake(t *testing.T) {
	hold := time.Now().Add(48 * time.Hour).UTC().Format(time.RFC3339)
	card := `{"ok":true,"result":{"id":"8c5b4deb-0000-4000-8000-000000000000","title":"Ship it","lane":"settling","owner":"kes","hold_until":"` + hold + `"}}` + "\n"
	var gotArgs map[string]any
	impPath := serveOnce(t, []byte(card), func(r Request) { gotArgs = r.Args })

	dir := t.TempDir()
	os.Chmod(dir, 0700)
	svcPath := filepath.Join(dir, "services.sock")
	ln, err := net.Listen("unix", svcPath)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := make(chan serviceRequest, 1)
	go func() {
		c, e := ln.Accept()
		if e != nil {
			return
		}
		defer c.Close()
		line, _ := bufio.NewReader(c).ReadBytes('\n')
		var req serviceRequest
		_ = json.Unmarshal(line, &req)
		got <- req
		c.Write([]byte(`{"ok":true,"result":{"event":{"id":"e1"},"created":true}}` + "\n"))
	}()
	var out, stderr bytes.Buffer
	code := Main([]string{"attn", "card", "move", "8c5b4deb", "settling", "--hold-until", hold}, strings.NewReader(""), &out, &stderr, func(k string) string {
		switch k {
		case "FAMILIAR_IMP_SOCKET":
			return impPath
		case "FAMILIAR_SERVICES_SOCKET":
			return svcPath
		case "FAMILIAR_INSTANCE_ID":
			return "primary-1"
		}
		return ""
	})
	if code != 0 {
		t.Fatalf("code=%d err=%s", code, stderr.String())
	}
	if gotArgs["hold_until"] != hold || gotArgs["lane"] != "settling" {
		t.Fatalf("resident args: %#v", gotArgs)
	}
	req := <-got
	due, _ := time.Parse(time.RFC3339, hold)
	if req.Op != "schedule.enqueue" || req.Args["target"] != "instance:primary-1" || req.Args["due_at"] != float64(due.UnixMilli()) || !strings.Contains(req.Args["summary"].(string), "8c5b4deb") {
		t.Fatalf("wake: %#v", req)
	}
	if !strings.Contains(out.String(), "held until") {
		t.Fatalf("human output: %q", out.String())
	}
}
