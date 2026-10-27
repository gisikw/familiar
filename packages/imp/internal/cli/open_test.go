package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func openEnv(t *testing.T) (string, string, func(string) string) {
	t.Helper()
	home := t.TempDir()
	state := t.TempDir()
	env := map[string]string{"HOME": home, "FAMILIAR_STATE_DIR": state}
	return home, state, func(k string) string { return env[k] }
}

func runOpen(getenv func(string) string, args ...string) (int, string, string) {
	var out, errw bytes.Buffer
	code := Main(append([]string{"open"}, args...), nil, &out, &errw, getenv)
	return code, out.String(), errw.String()
}

func TestOpenPushListCloseRoundTrip(t *testing.T) {
	home, state, getenv := openEnv(t)
	dir := filepath.Join(home, "Projects", "hoard", "primers", "attention-harvest")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html><head><title>Attention Harvest &amp; co</title>"), 0o644)
	// a newer writer's item and key must survive our rewrite
	os.WriteFile(filepath.Join(state, "open.json"), []byte(`{"v":1,"items":[{"id":"zz","kind":"future","title":"F","addedAt":"2026-10-05T00:00:00.000Z","x":1}]}`), 0o600)

	code, out, errs := runOpen(getenv, "~/Projects/hoard/primers/attention-harvest")
	if code != 0 || !strings.Contains(out, "opened: Attention Harvest & co") {
		t.Fatalf("open: %d %q %q", code, out, errs)
	}
	if code, out, _ = runOpen(getenv, filepath.Join(dir, "index.html"), "--title", "AH"); code != 0 || !strings.Contains(out, "already open") {
		t.Fatalf("reopen: %d %q", code, out)
	}
	if code, _, errs = runOpen(getenv, "#mail"); code != 0 {
		t.Fatalf("board: %q", errs)
	}
	b, _ := os.ReadFile(filepath.Join(state, "open.json"))
	var doc struct {
		V     int              `json:"v"`
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(b, &doc); err != nil || doc.V != 1 || len(doc.Items) != 3 {
		t.Fatalf("file: %s", b)
	}
	if doc.Items[0]["x"] != float64(1) || doc.Items[1]["title"] != "AH" || doc.Items[2]["slug"] != "mail" || doc.Items[2]["title"] != "#mail" {
		t.Fatalf("items: %v", doc.Items)
	}
	if _, out, _ = runOpen(getenv, "list"); !strings.Contains(out, "#mail") || !strings.Contains(out, "AH") {
		t.Fatalf("list: %q", out)
	}
	if code, out, _ = runOpen(getenv, "close", "#mail"); code != 0 || !strings.Contains(out, "closed: #mail") {
		t.Fatalf("close board: %d %q", code, out)
	}
	id, _ := doc.Items[1]["id"].(string)
	if code, _, _ = runOpen(getenv, "close", id); code != 0 {
		t.Fatalf("close by id")
	}
	if code, _, _ = runOpen(getenv, "close", id); code != ExitUsage {
		t.Fatalf("second close should say nothing matches")
	}
	if hist, _ := os.ReadFile(filepath.Join(state, "open-closed.jsonl")); strings.Count(string(hist), "\n") != 2 || !strings.Contains(string(hist), `"slug":"mail"`) || !strings.Contains(string(hist), `"reason":"manual"`) {
		t.Fatalf("history: %s", hist)
	}
}

func TestOpenRefusesWhatTheReaderCannotShow(t *testing.T) {
	home, _, getenv := openEnv(t)
	inside := filepath.Join(home, "Projects", "wireframes")
	os.MkdirAll(inside, 0o755)
	os.WriteFile(filepath.Join(inside, "archive.zip"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(home, "outside.md"), []byte("# x"), 0o644)
	cases := map[string]string{
		"https://example.com":                    "URLs",
		"card:abc":                               "isn't a card id",
		"#Not_A_Slug":                            "slug",
		filepath.Join(inside, "archive.zip"):     "can't show",
		filepath.Join(home, "missing.md"):        "can't open",
		filepath.Join(home, "Projects", "opcos"): "can't open",
	}
	for target, want := range cases {
		if code, _, errs := runOpen(getenv, target); code != ExitUsage || !strings.Contains(errs, want) {
			t.Errorf("%s: %d %q (want %q)", target, code, errs, want)
		}
	}
	if code, out, _ := runOpen(getenv, "--help"); code != 0 || !strings.Contains(out, "imp open <path|#project|card:ID>") {
		t.Fatalf("help")
	}
}

func TestOpenAcceptsExplicitPathsOutsideTheShelves(t *testing.T) {
	home, state, getenv := openEnv(t)
	spike := filepath.Join(home, "Projects", "cell", "spikes", "x")
	os.MkdirAll(spike, 0o755)
	os.WriteFile(filepath.Join(spike, "QUESTIONS.md"), []byte("# Questions"), 0o644)
	os.Symlink(spike, filepath.Join(home, "link"))
	code, out, errs := runOpen(getenv, filepath.Join(home, "link", "QUESTIONS.md"))
	if code != 0 || !strings.Contains(out, "Questions") {
		t.Fatalf("%d %q %q", code, out, errs)
	}
	raw, _ := os.ReadFile(filepath.Join(state, "open.json"))
	real, _ := filepath.EvalSymlinks(filepath.Join(spike, "QUESTIONS.md"))
	if !strings.Contains(string(raw), `"path": "`+real+`"`) {
		t.Fatalf("outside pushes store the resolved path the bridge grants: %s", raw)
	}
}

func TestDocTitleFallsBackToFolderForIndex(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "my-cool_doc")
	os.MkdirAll(dir, 0o755)
	p := filepath.Join(dir, "index.md")
	os.WriteFile(p, []byte("no heading"), 0o644)
	if got := docTitle(p); got != "my cool doc" {
		t.Fatalf("got %q", got)
	}
	os.WriteFile(p, []byte("intro\n# Real Title\n"), 0o644)
	if got := docTitle(p); got != "Real Title" {
		t.Fatalf("got %q", got)
	}
}

func TestOutsidePushesAreGrantedOnce(t *testing.T) {
	home, state, getenv := openEnv(t)
	doc := filepath.Join(home, "elsewhere", "a.md")
	os.MkdirAll(filepath.Dir(doc), 0o755)
	os.WriteFile(doc, []byte("# A"), 0o644)
	inside := filepath.Join(home, "Projects", "wireframes", "b.md")
	os.MkdirAll(filepath.Dir(inside), 0o755)
	os.WriteFile(inside, []byte("# B"), 0o644)
	for _, p := range []string{doc, doc, inside} {
		if code, _, errs := runOpen(getenv, p); code != 0 {
			t.Fatalf("%s: %s", p, errs)
		}
	}
	real, _ := filepath.EvalSymlinks(doc)
	raw, _ := os.ReadFile(filepath.Join(state, "reader-grants"))
	if string(raw) != real+"\n" {
		t.Fatalf("grants: %q", raw)
	}
}

func TestOpenFoldersAndPlainText(t *testing.T) {
	home, state, getenv := openEnv(t)
	data := filepath.Join(home, "Projects", "opcos", "actabl", "testdata")
	os.MkdirAll(filepath.Join(data, "hilton"), 0o755)
	os.WriteFile(filepath.Join(data, "README.md"), []byte("# Test data"), 0o644)
	os.WriteFile(filepath.Join(data, "hilton", "rows.csv"), []byte("a,b\n"), 0o644)
	os.WriteFile(filepath.Join(data, ".env"), []byte("X=1"), 0o644)
	os.WriteFile(filepath.Join(data, "proto.tfvars"), []byte("x"), 0o644)

	// A folder with only a README opens as a folder (trailing slash), not the README.
	if code, out, errs := runOpen(getenv, data); code != 0 || !strings.Contains(out, "testdata") {
		t.Fatalf("%d %q %q", code, out, errs)
	}
	// Plain text opens; secrets-shaped and hidden names don't.
	if code, _, errs := runOpen(getenv, filepath.Join(data, "hilton", "rows.csv")); code != 0 {
		t.Fatalf("csv: %s", errs)
	}
	os.WriteFile(filepath.Join(data, "bitbucket-token.txt"), []byte("t"), 0o644)
	os.WriteFile(filepath.Join(data, "private.csv"), []byte("a"), 0o600)
	for _, bad := range []string{".env", "proto.tfvars", "bitbucket-token.txt", "private.csv"} {
		if code, _, _ := runOpen(getenv, filepath.Join(data, bad)); code == 0 {
			t.Fatalf("%s should be refused", bad)
		}
	}
	raw, _ := os.ReadFile(filepath.Join(state, "open.json"))
	if !strings.Contains(string(raw), `"path": "`+data+`/"`) || !strings.Contains(string(raw), "rows.csv") {
		t.Fatalf("folder stored with a trailing slash, csv stored: %s", raw)
	}
	// Inside the shelves: no grant needed.
	if g, _ := os.ReadFile(filepath.Join(state, "reader-grants")); len(g) != 0 {
		t.Fatalf("no grants inside the shelves: %q", g)
	}
	// Closing by the folder's plain path finds the slash-stored row.
	if code, out, errs := runOpen(getenv, "close", data); code != 0 || !strings.Contains(out, "closed") {
		t.Fatalf("%d %q %q", code, out, errs)
	}

	// Outside the shelves, a folder push grants the resolved folder (with its slash).
	notes := filepath.Join(home, "notes")
	os.MkdirAll(notes, 0o755)
	if code, _, errs := runOpen(getenv, notes); code != 0 {
		t.Fatalf("outside folder: %s", errs)
	}
	real, _ := filepath.EvalSymlinks(notes)
	g, _ := os.ReadFile(filepath.Join(state, "reader-grants"))
	if !strings.Contains(string(g), real+"/\n") {
		t.Fatalf("folder grant: %q", g)
	}

	// Page folders still open their page.
	primer := filepath.Join(home, "Projects", "hoard", "primers", "p")
	os.MkdirAll(primer, 0o755)
	os.WriteFile(filepath.Join(primer, "index.md"), []byte("# P"), 0o644)
	os.WriteFile(filepath.Join(primer, "README.md"), []byte("# R"), 0o644)
	if code, _, _ := runOpen(getenv, primer); code != 0 {
		t.Fatal("primer")
	}
	raw, _ = os.ReadFile(filepath.Join(state, "open.json"))
	if !strings.Contains(string(raw), filepath.Join(primer, "index.md")) {
		t.Fatalf("primer opens index.md: %s", raw)
	}
}

func TestOpenCard(t *testing.T) {
	_, state, getenv := openEnv(t)
	const full = "a47b193a-fd43-4351-afd4-e7f8b50890ec"
	var asked []string
	prev := openCardLookup
	openCardLookup = func(ref string, _ func(string) string) (string, string, string, error) {
		asked = append(asked, ref)
		if !strings.HasPrefix(full, ref) {
			return "", "", "", errors.New("no card " + ref + ": not found")
		}
		return full, "homelab-rack", "Deploy smaug with the keeper", nil
	}
	t.Cleanup(func() { openCardLookup = prev })

	code, out, errs := runOpen(getenv, "card:A47B193A")
	if code != 0 || !strings.Contains(out, "opened: Deploy smaug with the keeper (card:"+full+")") {
		t.Fatalf("open card: %d %q %q", code, out, errs)
	}
	if asked[0] != "a47b193a" {
		t.Fatalf("lookup got %q", asked[0])
	}
	raw, _ := os.ReadFile(filepath.Join(state, "open.json"))
	var file struct {
		Items []map[string]any `json:"items"`
	}
	json.Unmarshal(raw, &file)
	if len(file.Items) != 1 || file.Items[0]["kind"] != "card" || file.Items[0]["slug"] != "homelab-rack" || file.Items[0]["card"] != full || file.Items[0]["path"] != nil {
		t.Fatalf("item: %v", file.Items)
	}
	// The same card by #project/prefix dedupes onto the same row.
	if code, out, _ := runOpen(getenv, "#homelab-rack/a47b193a", "--title", "Your steps"); code != 0 || !strings.Contains(out, "already open") {
		t.Fatalf("dedupe: %d %q", code, out)
	}
	// Wrong project, unknown card, and a non-hex ref are refused.
	if code, _, errs := runOpen(getenv, "#mail/a47b193a"); code != ExitUsage || !strings.Contains(errs, "is on #homelab-rack") {
		t.Fatalf("wrong project: %d %q", code, errs)
	}
	if code, _, errs := runOpen(getenv, "card:deadbeef"); code != ExitUsage || !strings.Contains(errs, "no card deadbeef") {
		t.Fatalf("unknown: %d %q", code, errs)
	}
	if code, _, errs := runOpen(getenv, "card:a47b"); code != ExitUsage || !strings.Contains(errs, "isn't a card id") {
		t.Fatalf("short: %d %q", code, errs)
	}
	// Closing by card ref removes it and records the card in Recently closed.
	if code, out, errs := runOpen(getenv, "close", "card:a47b193a"); code != 0 || !strings.Contains(out, "closed: Your steps") {
		t.Fatalf("close: %d %q %q", code, out, errs)
	}
	hist, _ := os.ReadFile(filepath.Join(state, "open-closed.jsonl"))
	if !strings.Contains(string(hist), `"card":"`+full+`"`) || !strings.Contains(string(hist), `"kind":"card"`) {
		t.Fatalf("history: %s", hist)
	}
}
