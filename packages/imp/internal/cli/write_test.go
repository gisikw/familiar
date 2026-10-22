package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func runWrite(getenv func(string) string, args ...string) (int, string, string) {
	var out, errw bytes.Buffer
	code := Main(append([]string{"write"}, args...), nil, &out, &errw, getenv)
	return code, out.String(), errw.String()
}

func TestWriteOpenReadDiffClose(t *testing.T) {
	home, state, getenv := openEnv(t)
	code, out, errs := runWrite(getenv)
	if code != 0 || !strings.Contains(out, filepath.Join(state, "writing")) {
		t.Fatalf("open default: %d %q %q", code, out, errs)
	}
	s := readWriterSession(filepath.Join(state, "writer.json"))
	if s == nil || s.By != "kes" || !strings.HasSuffix(s.Path, ".md") {
		t.Fatalf("session: %+v", s)
	}
	os.WriteFile(s.Path, []byte("First para here.\n\nSecond one."), 0o600)
	stats := `{"v":1,"sittings":[{"id":"a","startedAt":"2026-10-22T19:00:00Z","lastAt":"2026-10-22T19:10:00Z","activeMs":300000,"wordsStart":0,"wordsEnd":5,"inserted":40,"deleted":10,"pastes":0,"pauses":[{"at":"2026-10-22T19:03:00Z","ms":95000,"words":3,"para":0,"before":"First para here."}]}]}`
	os.WriteFile(s.Path+".stats.json", []byte(stats), 0o600)
	code, out, _ = runWrite(getenv, "read")
	if code != 0 || !strings.Contains(out, "Second one.") || !strings.Contains(out, "+5 words, 1 wpm, rewrite 25%") || !strings.Contains(out, "after “…First para here.”") {
		t.Fatalf("read: %q", out)
	}
	os.WriteFile(s.Path, []byte("First para here.\n\nSecond one, longer.\n\nThird."), 0o600)
	code, out, _ = runWrite(getenv, "diff")
	if code != 0 || !strings.Contains(out, "- Second one.") || !strings.Contains(out, "+ Second one, longer.") || !strings.Contains(out, "+ Third.") || !strings.Contains(out, "(+2 since") {
		t.Fatalf("diff: %q", out)
	}
	if _, out, _ = runWrite(getenv, "diff"); !strings.Contains(out, "no change") {
		t.Fatalf("diff again: %q", out)
	}
	// Fresh typing protects his page from being swapped out.
	other := filepath.Join(home, "essay.md")
	if code, _, errs = runWrite(getenv, other, "--prompt", "Why write?", "--target", "300"); code != ExitUsage || !strings.Contains(errs, "--force") {
		t.Fatalf("guard: %d %q", code, errs)
	}
	if code, out, _ = runWrite(getenv, other, "--prompt", "Why write?", "--target", "300", "--force"); code != 0 || !strings.Contains(out, "target 300") {
		t.Fatalf("force: %d %q", code, out)
	}
	s2 := readWriterSession(filepath.Join(state, "writer.json"))
	// Re-opening the same page keeps its id and fills in what wasn't given.
	runWrite(getenv, other, "--target", "500")
	s3 := readWriterSession(filepath.Join(state, "writer.json"))
	if s3.ID != s2.ID || s3.Prompt != "Why write?" || s3.Target != 500 {
		t.Fatalf("reopen: %+v %+v", s2, s3)
	}
	if code, _, _ = runWrite(getenv, filepath.Join(home, "x.go")); code != ExitUsage {
		t.Fatalf("non-prose path accepted")
	}
	if code, out, _ = runWrite(getenv, "close"); code != 0 || readWriterSession(filepath.Join(state, "writer.json")) != nil {
		t.Fatalf("close: %q", out)
	}
	var f map[string]any
	raw, _ := os.ReadFile(filepath.Join(state, "writer.json"))
	if json.Unmarshal(raw, &f) != nil || f["session"] != nil || f["v"] != float64(1) {
		t.Fatalf("closed file: %s", raw)
	}
	_ = time.Now
}
