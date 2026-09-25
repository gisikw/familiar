package cli

import (
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func branchEnv(values map[string]string) func(string) string {
	return func(k string) string { return values[k] }
}
func writeForkSession(t *testing.T, path string) {
	t.Helper()
	data := "{\"type\":\"session\",\"version\":3,\"id\":\"fork-1\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"parentSession\":\"parent.jsonl\"}\n" +
		"{\"type\":\"custom\",\"id\":\"mark0001\",\"parentId\":null,\"timestamp\":\"2026-01-01T00:00:01Z\",\"customType\":\"familiar.fork.v1\",\"data\":{\"parentSessionId\":\"parent-1\",\"branchEntryId\":\"branch01\"}}\n" +
		"{\"type\":\"message\",\"id\":\"first001\",\"parentId\":\"mark0001\",\"timestamp\":\"2026-01-01T00:00:02Z\",\"message\":{\"role\":\"user\",\"content\":\"task\"}}\n" +
		"{\"type\":\"message\",\"id\":\"last0001\",\"parentId\":\"first001\",\"timestamp\":\"2026-01-01T00:00:03Z\",\"message\":{\"role\":\"assistant\",\"content\":\"done\"}}\n"
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
}
func jsonServer(t *testing.T, inspect func(map[string]any)) string {
	t.Helper()
	dir := t.TempDir()
	_ = os.Chmod(dir, 0700)
	p := filepath.Join(dir, "s.sock")
	ln, e := net.Listen("unix", p)
	if e != nil {
		t.Fatal(e)
	}
	_ = os.Chmod(p, 0600)
	t.Cleanup(func() { ln.Close() })
	go func() {
		c, e := ln.Accept()
		if e != nil {
			return
		}
		defer c.Close()
		var req map[string]any
		json.NewDecoder(c).Decode(&req)
		inspect(req)
		c.Write([]byte("{\"ok\":true,\"result\":{\"ok\":true}}\n"))
	}()
	return p
}
func TestQuietMergeEnqueuesDetailsAndExit(t *testing.T) {
	dir := t.TempDir()
	session := filepath.Join(dir, "fork.jsonl")
	writeForkSession(t, session)
	imp := jsonServer(t, func(r map[string]any) {
		if r["area"] != "branch" || r["operation"] != "merge" {
			t.Errorf("request=%#v", r)
		}
	})
	scheduler := jsonServer(t, func(r map[string]any) {
		args := r["args"].(map[string]any)
		if r["op"] != "schedule.enqueue" || args["urgency"] != "soft" {
			t.Errorf("request=%#v", r)
		}
		var body map[string]any
		if json.Unmarshal([]byte(args["body"].(string)), &body) != nil || body["mergedAt"] == "" || body["summary"] != "PR deployed" {
			t.Errorf("body=%#v", body)
		}
	})
	env := map[string]string{"FAMILIAR_SESSION_FILE": session, "FAMILIAR_INSTANCE_ID": "fork-1", "FAMILIAR_IMP_SOCKET": imp, "FAMILIAR_SERVICES_SOCKET": scheduler}
	var out, er bytes.Buffer
	if code := branchMain([]string{"merge", "--quiet", "PR deployed"}, &out, &er, branchEnv(env)); code != 0 {
		t.Fatalf("code=%d out=%s err=%s", code, out.String(), er.String())
	}
}
func TestCloseCommandIsGone(t *testing.T) {
	var out, er bytes.Buffer
	if code := branchMain([]string{"close", "done"}, &out, &er, branchEnv(nil)); code != ExitUsage || !strings.Contains(er.String(), "unknown command") {
		t.Fatalf("code=%d err=%q", code, er.String())
	}
}
func TestPrimaryCannotMerge(t *testing.T) {
	session := filepath.Join(t.TempDir(), "primary.jsonl")
	_ = os.WriteFile(session, []byte("{\"type\":\"session\",\"id\":\"primary\"}\n{\"type\":\"message\",\"id\":\"leaf\"}\n"), 0600)
	var out, er bytes.Buffer
	code := branchMain([]string{"merge", "done"}, &out, &er, branchEnv(map[string]string{"FAMILIAR_SESSION_FILE": session, "FAMILIAR_INSTANCE_ID": "primary", "FAMILIAR_IMP_SOCKET": "/unused"}))
	if code != ExitUsage || !strings.Contains(er.String(), "you're the top level; there's nothing to merge into") {
		t.Fatalf("code=%d err=%q", code, er.String())
	}
}

func TestForkDepthLimit(t *testing.T) {
	session := filepath.Join(t.TempDir(), "deep.jsonl")
	writeForkSession(t, session)
	var out, er bytes.Buffer
	env := map[string]string{"FAMILIAR_INSTANCE_ID": "fork-1", "FAMILIAR_SESSION_FILE": session, "FAMILIAR_STATE_DIR": t.TempDir(), "PI_CODING_AGENT_DIR": t.TempDir(), "PI_PACKAGE_DIR": "/pi", "FAMILIAR_FORK_HELPER": "/helper", "FAMILIAR_FORK_MAX_DEPTH": "1"}
	if code := branchMain([]string{"fork", "too deep"}, &out, &er, branchEnv(env)); code != ExitUsage || !strings.Contains(er.String(), "configured maximum") {
		t.Fatalf("code=%d err=%q", code, er.String())
	}
}

func TestForkCreatesStateAndStartsUnit(t *testing.T) {
	root := t.TempDir()
	bin := filepath.Join(root, "bin")
	os.Mkdir(bin, 0700)
	node := filepath.Join(bin, "node")
	os.WriteFile(node, []byte("#!/bin/sh\nmkdir -p \"$5\"; echo header > \"$5/session.jsonl\"; echo '{\"id\":\"fork-new\",\"file\":\"'$5'/session.jsonl\",\"markerEntryId\":\"m\"}'\n"), 0700)
	ctl := filepath.Join(bin, "systemctl")
	os.WriteFile(ctl, []byte("#!/bin/sh\necho \"$*\" > \"$CALLS\"\n"), 0700)
	os.WriteFile(filepath.Join(bin, "sudo"), []byte("#!/bin/sh\nexec \"$@\"\n"), 0700)
	parent := filepath.Join(root, "parent.jsonl")
	os.WriteFile(parent, []byte("{\"type\":\"session\",\"id\":\"parent\"}\n{\"type\":\"message\",\"id\":\"leaf0001\"}\n"), 0600)
	pi := filepath.Join(root, "pi")
	os.Mkdir(pi, 0700)
	calls := filepath.Join(root, "calls")
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	t.Setenv("CALLS", calls)
	env := map[string]string{"FAMILIAR_INSTANCE_ID": "parent", "FAMILIAR_SESSION_FILE": parent, "FAMILIAR_STATE_DIR": root, "PI_CODING_AGENT_DIR": pi, "PI_PACKAGE_DIR": "/pi", "FAMILIAR_FORK_HELPER": "/helper"}
	var out, er bytes.Buffer
	if code := branchMain([]string{"fork", "do work"}, &out, &er, branchEnv(env)); code != 0 {
		t.Fatalf("code=%d err=%s", code, er.String())
	}
	if strings.TrimSpace(out.String()) != "fork-new" {
		t.Fatal(out.String())
	}
	b, _ := os.ReadFile(calls)
	if !strings.Contains(string(b), "familiar-pi@fork-new.service") {
		t.Fatal(string(b))
	}
}
func TestForksListsSystemctlState(t *testing.T) {
	root := t.TempDir()
	d := filepath.Join(root, "forks", "f1")
	os.MkdirAll(d, 0700)
	os.WriteFile(filepath.Join(d, "fork.json"), []byte(`{"id":"f1","task":"work"}`), 0600)
	ctl := filepath.Join(root, "systemctl")
	os.WriteFile(ctl, []byte("#!/bin/sh\nexit 0\n"), 0700)
	t.Setenv("PATH", root+":"+os.Getenv("PATH"))
	var out, er bytes.Buffer
	if code := branchMain([]string{"forks"}, &out, &er, branchEnv(map[string]string{"FAMILIAR_STATE_DIR": root})); code != 0 || !strings.Contains(out.String(), "f1  active  work") {
		t.Fatalf("code=%d out=%q err=%q", code, out.String(), er.String())
	}
}
