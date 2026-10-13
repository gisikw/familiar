package store

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func open(t *testing.T) *Store {
	s, err := Open(filepath.Join(t.TempDir(), "l1.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestCueFirstMentionOnce(t *testing.T) {
	s := open(t)
	id, _ := s.UpsertEntity(Entity{Name: "Derek Rymers", Kind: "person", Aliases: []string{"derek"}})
	if err := s.SetEdge(id, "employer", "Vanta", "q", "src", "test", 1); err != nil {
		t.Fatal(err)
	}
	lines, _ := s.Cue("s1", "lunch with Derek's crew tomorrow", 3)
	if len(lines) != 1 || !strings.Contains(lines[0], "Vanta") {
		t.Fatalf("want one gloss, got %v", lines)
	}
	if again, _ := s.Cue("s1", "Derek again", 3); len(again) != 0 {
		t.Fatalf("second mention in session glossed: %v", again)
	}
	if other, _ := s.Cue("s2", "derek", 3); len(other) != 1 {
		t.Fatalf("new session should gloss: %v", other)
	}
	if none, _ := s.Cue("s3", "the derecho hit", 3); len(none) != 0 {
		t.Fatalf("substring matched: %v", none)
	}
}

func TestEdgeLogAndClosedVocabulary(t *testing.T) {
	s := open(t)
	id, _ := s.UpsertEntity(Entity{Name: "Auden", Kind: "person", Pinned: true})
	if err := s.SetEdge(id, "favorite_color", "blue", "", "", "t", 1); err == nil {
		t.Fatal("free-text attribute accepted")
	}
	s.SetEdge(id, "age", "4", "", "", "t", 1)
	s.SetEdge(id, "age", "5", "he just had a birthday", "", "t", 0.95)
	cs, _ := s.Changes(time.Time{})
	if len(cs) != 2 || cs[1].Op != "update" || cs[1].Old != "4" || cs[1].New != "5" {
		t.Fatalf("changes: %+v", cs)
	}
}

func TestDecayKeepsPinnedAndHot(t *testing.T) {
	s := open(t)
	core, _ := s.UpsertEntity(Entity{Name: "Ash", Kind: "person", Pinned: true})
	s.SetEdge(core, "relation", "Kev's wife", "", "", "t", 1)
	for _, n := range []string{"a1", "a2", "a3", "a4"} {
		id, _ := s.UpsertEntity(Entity{Name: n, Kind: "other"})
		s.SetEdge(id, "status", "x", "", "", "t", 1)
	}
	s.Cue("s", "a4 a4", 3) // a4 gets a hit
	if _, err := s.Decay(2, time.Now().Add(30*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, ed := s.Count(); ed != 2 {
		t.Fatalf("edges after decay = %d", ed)
	}
	if e, _ := s.Edges(core); len(e) != 1 {
		t.Fatal("pinned edge evicted")
	}
	if id, ok := s.EntityByAlias("a4"); !ok {
		t.Fatal("hot entity evicted")
	} else if e, _ := s.Edges(id); len(e) != 1 {
		t.Fatal("hot edge evicted")
	}
}

func TestFirstNameGuard(t *testing.T) {
	s := open(t)
	b, _ := s.UpsertEntity(Entity{Name: "Brian Coleman", Kind: "person", Aliases: []string{"brian"}})
	s.SetEdge(b, "relation", "Kev's former report", "", "", "t", 1)
	j, _ := s.UpsertEntity(Entity{Name: "Joe Kramer", Kind: "person", Aliases: []string{"joe"}})
	s.SetEdge(j, "relation", "Kev's former report", "", "", "t", 1)
	for _, txt := range []string{"yeah, Brian Darcy James is a tenor", "it's on the infra org on for G Joe. Um"} {
		if ids, _ := s.Mentioned(txt); len(ids) != 0 {
			t.Errorf("%q matched %v", txt, ids)
		}
	}
	for _, txt := range []string{"Brian is now actively looking", "lunch with brian.", "Ugh. Joe called", "Brian Coleman pinged"} {
		if ids, _ := s.Mentioned(txt); len(ids) != 1 {
			t.Errorf("%q missed", txt)
		}
	}
}
