package cli

import (
	"strings"
	"testing"
)

func TestAttnAddedNotePicksNewNotNewestOrOldest(t *testing.T) {
	raw := []byte(`{"id":"1e982f40-95b1","notes":[
		{"id":744,"at":"t3","by":"kes","text":"other later note","detail":null},
		{"id":743,"at":"t2","by":"kes","text":"  mine  ","detail":"line a\nline b"},
		{"id":742,"at":"t1","by":"kes","text":"oldest","detail":null}]}`)
	got, err := attnAddedNote(raw, "mine")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got, "noted on 1e982f40 (note 743, t2): ") || !strings.Contains(got, "    line b\n") {
		t.Fatalf("got %q", got)
	}
	if strings.Contains(got, "oldest") {
		t.Fatalf("printed the oldest note: %q", got)
	}
}

func TestAttnAddedNoteMissingFailsLoudly(t *testing.T) {
	raw := []byte(`{"id":"abc","notes":[{"id":1,"at":"t","by":"kes","text":"something else"}]}`)
	if _, err := attnAddedNote(raw, "mine"); err == nil || !strings.Contains(err.Error(), "may not have been saved") {
		t.Fatalf("want loud error, got %v", err)
	}
}
