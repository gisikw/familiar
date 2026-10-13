package session

import (
	"strings"
	"testing"
	"time"
)

func TestCleanStripsMachinery(t *testing.T) {
	in := "🗣 lunch with Derek\n\n[familiar-ui:attachments v1]\n{...}\n[/familiar-ui:attachments]\n<familiar-merge at=\"x\">fork said Vanta</familiar-merge>\n\n[Mon 7:01 PM, queued 26m] fork merged: blah"
	if got := Clean(in); got != "lunch with Derek" {
		t.Fatalf("got %q", got)
	}
	if Clean("You are a fork of 01a0; do things") != "" {
		t.Fatal("fork brief counted as Kev")
	}
}

func TestReadWindowAndDocs(t *testing.T) {
	jl := strings.Join([]string{
		`{"type":"message","id":"a","timestamp":"2026-10-10T00:00:00Z","message":{"role":"user","content":[{"type":"text","text":"old"}]}}`,
		`{"type":"message","id":"b","timestamp":"2026-10-12T00:00:00Z","message":{"role":"user","content":[{"type":"text","text":"new words"}]}}`,
		`{"type":"message","id":"c","timestamp":"2026-10-12T00:01:00Z","message":{"role":"assistant","content":[{"type":"text","text":"mine"}]}}`,
		`{"type":"message","id":"d","timestamp":"2026-10-12T00:02:00Z","message":{"role":"toolResult","content":[{"type":"text","text":"` + strings.Repeat("doc ", 80) + `"}]}}`,
	}, "\n")
	since, _ := time.Parse(time.RFC3339, "2026-10-11T00:00:00Z")
	ts, err := Read(strings.NewReader(jl), since, time.Time{})
	if err != nil || len(ts) != 1 || ts[0].Text != "new words" || ts[0].Role != "kev" {
		t.Fatalf("kev turns: %+v %v", ts, err)
	}
	all, _ := read(strings.NewReader(jl), since, time.Time{}, true)
	if len(all) != 2 || all[1].Role != "doc" {
		t.Fatalf("docs: %+v", all)
	}
}
