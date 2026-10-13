// Package store is L1: a small, bounded, typed fact cache in SQLite.
//
// Entities have aliases; edges are (entity, attribute, value) with provenance.
// Attributes are a closed set: if a fact does not fit a slot, it is not L1 —
// the full session record remains the source of truth for everything else.
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

// Attrs is the closed attribute vocabulary. Values are short strings.
var Attrs = []string{
	"relation",        // relation to Kev ("Kev's son", "Kev's former boss")
	"role",            // job title / role
	"employer",        // current employer or org
	"former_employer", // prior employer relevant to Kev
	"location",        // where they live / where it is
	"age",             // age in years
	"born",            // birth date or year
	"author",          // for works
	"status",          // for works/projects: want, reading, done, live, retired...
	"origin",          // where it came from ("Kes's July curriculum", "Kev's Calendly years")
	"link",            // pointer: doc path, repo, url
}

// Kinds is the closed entity-kind vocabulary.
var Kinds = []string{"person", "org", "place", "work", "project", "concept", "other"}

const MaxValueChars = 120

func ValidAttr(a string) bool {
	for _, x := range Attrs {
		if x == a {
			return true
		}
	}
	return false
}

func ValidKind(k string) bool {
	for _, x := range Kinds {
		if x == k {
			return true
		}
	}
	return false
}

type Entity struct {
	ID      string
	Name    string
	Kind    string
	Pinned  bool
	Aliases []string
}

type Edge struct {
	ID        int64
	EntityID  string
	Attr      string
	Value     string
	Quote     string
	Source    string
	CreatedAt time.Time
	UpdatedAt time.Time
	LastHit   time.Time
	HitCount  int
}

type Store struct{ db *sql.DB }

const schema = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS aliases (
  alias TEXT NOT NULL, entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (alias, entity_id));
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  attr TEXT NOT NULL, value TEXT NOT NULL, quote TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_hit TEXT NOT NULL, hit_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (entity_id, attr));
CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, entity_id TEXT NOT NULL,
  attr TEXT NOT NULL, op TEXT NOT NULL, old TEXT, new TEXT, quote TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '', confidence REAL, actor TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, entity_id TEXT NOT NULL,
  entity_name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'other', attr TEXT NOT NULL,
  op TEXT NOT NULL, old TEXT, new TEXT, quote TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
  confidence REAL, ask_id INTEGER, state TEXT NOT NULL DEFAULT 'open');
CREATE TABLE IF NOT EXISTS mentions (
  session TEXT NOT NULL, entity_id TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (session, entity_id));
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`

func DefaultPath() string {
	if p := os.Getenv("FAMILIAR_L1_DB"); p != "" {
		return p
	}
	if d := os.Getenv("FAMILIAR_STATE_DIR"); d != "" {
		return filepath.Join(d, "l1", "l1.db")
	}
	return filepath.Join("/var/lib/kestrel/state", "l1", "l1.db")
}

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite3", "file:"+path+"?_foreign_keys=on&_busy_timeout=5000&_journal_mode=WAL")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	_ = os.Chmod(path, 0o600)
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func ts(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }
func pt(v string) time.Time  { t, _ := time.Parse(time.RFC3339Nano, v); return t }

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

func Slug(name string) string {
	return strings.Trim(slugRe.ReplaceAllString(strings.ToLower(name), "-"), "-")
}

func clip(v string, n int) string {
	v = strings.TrimSpace(strings.Join(strings.Fields(v), " "))
	if r := []rune(v); len(r) > n {
		return string(r[:n])
	}
	return v
}

// UpsertEntity creates the entity if missing and adds aliases (name included).
func (s *Store) UpsertEntity(e Entity) (string, error) {
	if e.Name == "" {
		return "", errors.New("entity name required")
	}
	if e.Kind == "" {
		e.Kind = "other"
	}
	if !ValidKind(e.Kind) {
		return "", fmt.Errorf("invalid kind %q", e.Kind)
	}
	if e.ID == "" {
		e.ID = Slug(e.Name)
	}
	now := ts(time.Now())
	if _, err := s.db.Exec(`INSERT INTO entities(id,name,kind,pinned,created_at) VALUES(?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET pinned = MAX(pinned, excluded.pinned),
		kind = CASE WHEN excluded.kind != 'other' THEN excluded.kind ELSE kind END`, e.ID, e.Name, e.Kind, b2i(e.Pinned), now); err != nil {
		return "", err
	}
	for _, a := range append([]string{e.Name}, e.Aliases...) {
		a = strings.ToLower(strings.TrimSpace(a))
		if len(a) < 2 {
			continue
		}
		if _, err := s.db.Exec(`INSERT OR IGNORE INTO aliases(alias,entity_id) VALUES(?,?)`, a, e.ID); err != nil {
			return "", err
		}
	}
	return e.ID, nil
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// SetEdge writes (entity, attr) = value, logging the change. Empty value retracts.
func (s *Store) SetEdge(entityID, attr, value, quote, source, actor string, confidence float64) error {
	if !ValidAttr(attr) {
		return fmt.Errorf("invalid attr %q", attr)
	}
	value = clip(value, MaxValueChars)
	quote = clip(quote, 400)
	now := ts(time.Now())
	var old sql.NullString
	_ = s.db.QueryRow(`SELECT value FROM edges WHERE entity_id=? AND attr=?`, entityID, attr).Scan(&old)
	op := "add"
	switch {
	case value == "" && !old.Valid:
		return nil
	case value == "":
		op = "retract"
		if _, err := s.db.Exec(`DELETE FROM edges WHERE entity_id=? AND attr=?`, entityID, attr); err != nil {
			return err
		}
	case old.Valid && old.String == value:
		return nil
	case old.Valid:
		op = "update"
		if _, err := s.db.Exec(`UPDATE edges SET value=?, quote=?, source=?, updated_at=? WHERE entity_id=? AND attr=?`,
			value, quote, source, now, entityID, attr); err != nil {
			return err
		}
	default:
		if _, err := s.db.Exec(`INSERT INTO edges(entity_id,attr,value,quote,source,created_at,updated_at,last_hit,hit_count)
			VALUES(?,?,?,?,?,?,?,?,0)`, entityID, attr, value, quote, source, now, now, now); err != nil {
			return err
		}
	}
	_, err := s.db.Exec(`INSERT INTO changes(at,entity_id,attr,op,old,new,quote,source,confidence,actor) VALUES(?,?,?,?,?,?,?,?,?,?)`,
		now, entityID, attr, op, old, value, quote, source, confidence, actor)
	return err
}

func (s *Store) Entity(id string) (Entity, error) {
	var e Entity
	var pinned int
	err := s.db.QueryRow(`SELECT id,name,kind,pinned FROM entities WHERE id=?`, id).Scan(&e.ID, &e.Name, &e.Kind, &pinned)
	if err != nil {
		return e, err
	}
	e.Pinned = pinned == 1
	rows, err := s.db.Query(`SELECT alias FROM aliases WHERE entity_id=? ORDER BY alias`, id)
	if err != nil {
		return e, err
	}
	defer rows.Close()
	for rows.Next() {
		var a string
		rows.Scan(&a)
		e.Aliases = append(e.Aliases, a)
	}
	return e, nil
}

func (s *Store) Edges(entityID string) ([]Edge, error) {
	rows, err := s.db.Query(`SELECT id,entity_id,attr,value,quote,source,created_at,updated_at,last_hit,hit_count
		FROM edges WHERE entity_id=?`, entityID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Edge
	for rows.Next() {
		var e Edge
		var c, u, l string
		if err := rows.Scan(&e.ID, &e.EntityID, &e.Attr, &e.Value, &e.Quote, &e.Source, &c, &u, &l, &e.HitCount); err != nil {
			return nil, err
		}
		e.CreatedAt, e.UpdatedAt, e.LastHit = pt(c), pt(u), pt(l)
		out = append(out, e)
	}
	order := map[string]int{}
	for i, a := range Attrs {
		order[a] = i
	}
	sort.Slice(out, func(i, j int) bool { return order[out[i].Attr] < order[out[j].Attr] })
	return out, nil
}

type aliasRow struct{ alias, id, name string }

func (s *Store) aliases() ([]aliasRow, error) {
	rows, err := s.db.Query(`SELECT a.alias, a.entity_id, n.name FROM aliases a JOIN entities n ON n.id = a.entity_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []aliasRow
	for rows.Next() {
		var a aliasRow
		rows.Scan(&a.alias, &a.id, &a.name)
		out = append(out, a)
	}
	// Longest alias first so "derek rymers" wins over "derek".
	sort.Slice(out, func(i, j int) bool { return len(out[i].alias) > len(out[j].alias) })
	return out, nil
}

// Mentioned returns entity ids whose aliases appear as whole words in text.
func (s *Store) Mentioned(text string) ([]string, error) {
	al, err := s.aliases()
	if err != nil {
		return nil, err
	}
	orig := " " + text + " "
	low := strings.ToLower(orig)
	if len(low) != len(orig) { // non-ASCII case folding changed offsets; skip context checks
		orig = low
	}
	seen := map[string]bool{}
	var out []string
	for _, a := range al {
		if seen[a.id] {
			continue
		}
		if aliasHit(orig, low, a) {
			seen[a.id] = true
			out = append(out, a.id)
		}
	}
	return out, nil
}

// aliasHit is a whole-word match. A single-word alias of a multi-word name
// ("brian" for Brian Coleman) is rejected when it's visibly part of someone
// else's name: followed by a capitalised word that isn't theirs ("Brian Darcy
// James"), or preceded mid-sentence by one ("G Joe").
func aliasHit(orig, low string, a aliasRow) bool {
	nameToks := map[string]bool{}
	for _, t := range strings.Fields(strings.ToLower(a.name)) {
		nameToks[strings.Trim(t, "().,'")] = true
	}
	guard := !strings.Contains(a.alias, " ") && len(nameToks) > 1
	for i := 0; ; {
		j := strings.Index(low[i:], a.alias)
		if j < 0 {
			return false
		}
		k := i + j
		end := k + len(a.alias)
		i = k + 1
		before := k == 0 || !isWordByte(low[k-1])
		after := end >= len(low) || !isWordByte(low[end]) || low[end] == '\''
		if !before || !after {
			continue
		}
		if guard && (foreignCap(nextWord(orig, end), nameToks) || foreignCap(prevWord(orig, k), nameToks)) {
			continue
		}
		return true
	}
}

func nextWord(s string, i int) string {
	for i < len(s) && s[i] == ' ' {
		i++
	}
	j := i
	for j < len(s) && (isWordByte(s[j]|0x20) || s[j] == '-') {
		j++
	}
	return s[i:j]
}

func prevWord(s string, i int) string {
	j := i
	for j > 0 && s[j-1] == ' ' {
		j--
	}
	if j > 0 && strings.ContainsRune(".!?,:;\n", rune(s[j-1])) {
		return "" // sentence/clause boundary: capitalisation means nothing
	}
	k := j
	for k > 0 && isWordByte(s[k-1]|0x20) {
		k--
	}
	return s[k:j]
}

func foreignCap(w string, nameToks map[string]bool) bool {
	if w == "" || w[0] < 'A' || w[0] > 'Z' || w == "I" {
		return false
	}
	return !nameToks[strings.ToLower(w)]
}

func isWordByte(b byte) bool {
	return b >= 'a' && b <= 'z' || b >= '0' && b <= '9' || b >= 0x80
}

func wordContains(hay, needle string) bool {
	for i := 0; ; {
		j := strings.Index(hay[i:], needle)
		if j < 0 {
			return false
		}
		k := i + j
		end := k + len(needle)
		before := k == 0 || !isWordByte(hay[k-1])
		after := end >= len(hay) || !isWordByte(hay[end])
		// allow simple possessive/plural: "derek's", "ashs"
		if !after && end < len(hay) && hay[end] == '\'' {
			after = true
		}
		if before && after {
			return true
		}
		i = k + 1
	}
}

// Cue returns gloss lines for entities first-mentioned in this session, and
// records the mentions and hits. Entities without edges are skipped.
func (s *Store) Cue(session, text string, max int) ([]string, error) {
	ids, err := s.Mentioned(text)
	if err != nil {
		return nil, err
	}
	now := ts(time.Now())
	var lines []string
	for _, id := range ids {
		res, err := s.db.Exec(`INSERT OR IGNORE INTO mentions(session,entity_id,at) VALUES(?,?,?)`, session, id, now)
		if err != nil {
			return nil, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			continue // already glossed this session
		}
		s.db.Exec(`UPDATE edges SET last_hit=?, hit_count=hit_count+1 WHERE entity_id=?`, now, id)
		if len(lines) >= max {
			continue
		}
		line, err := s.Gloss(id)
		if err != nil || line == "" {
			continue
		}
		lines = append(lines, line)
	}
	return lines, nil
}

// Gloss renders one line for an entity from its current edges.
func (s *Store) Gloss(id string) (string, error) {
	e, err := s.Entity(id)
	if err != nil {
		return "", err
	}
	edges, err := s.Edges(id)
	if err != nil || len(edges) == 0 {
		return "", err
	}
	var parts []string
	for _, ed := range edges {
		switch ed.Attr {
		case "relation", "role":
			parts = append(parts, ed.Value)
		default:
			parts = append(parts, strings.ReplaceAll(ed.Attr, "_", " ")+": "+ed.Value)
		}
	}
	return e.Name + " — " + strings.Join(parts, "; "), nil
}

func (s *Store) EntityByAlias(name string) (string, bool) {
	var id string
	err := s.db.QueryRow(`SELECT entity_id FROM aliases WHERE alias=?`, strings.ToLower(strings.TrimSpace(name))).Scan(&id)
	if err == nil {
		return id, true
	}
	if err := s.db.QueryRow(`SELECT id FROM entities WHERE id=?`, Slug(name)).Scan(&id); err == nil {
		return id, true
	}
	return "", false
}

// Decay evicts the least-useful unpinned edges until at most target remain.
// Score: hit_count weighted by recency of last hit. Entities left with no
// edges (and unpinned) are removed too.
func (s *Store) Decay(target int, now time.Time) (int, error) {
	var n int
	s.db.QueryRow(`SELECT COUNT(*) FROM edges`).Scan(&n)
	if n <= target {
		return 0, nil
	}
	rows, err := s.db.Query(`SELECT e.id, e.hit_count, e.last_hit FROM edges e JOIN entities n ON n.id=e.entity_id WHERE n.pinned=0`)
	if err != nil {
		return 0, err
	}
	type cand struct {
		id    int64
		score float64
	}
	var cs []cand
	for rows.Next() {
		var id int64
		var hits int
		var last string
		rows.Scan(&id, &hits, &last)
		days := now.Sub(pt(last)).Hours() / 24
		cs = append(cs, cand{id, float64(hits+1) / (1 + days/7)})
	}
	rows.Close()
	sort.Slice(cs, func(i, j int) bool { return cs[i].score < cs[j].score })
	evicted := 0
	for _, c := range cs {
		if n-evicted <= target {
			break
		}
		var eid, attr, val string
		s.db.QueryRow(`SELECT entity_id, attr, value FROM edges WHERE id=?`, c.id).Scan(&eid, &attr, &val)
		if _, err := s.db.Exec(`DELETE FROM edges WHERE id=?`, c.id); err != nil {
			return evicted, err
		}
		s.db.Exec(`INSERT INTO changes(at,entity_id,attr,op,old,new,actor) VALUES(?,?,?,?,?,?,?)`,
			ts(now), eid, attr, "evict", val, "", "decay")
		evicted++
	}
	s.db.Exec(`DELETE FROM entities WHERE pinned=0 AND id NOT IN (SELECT entity_id FROM edges)`)
	return evicted, nil
}

func (s *Store) Count() (entities, edges int) {
	s.db.QueryRow(`SELECT COUNT(*) FROM entities`).Scan(&entities)
	s.db.QueryRow(`SELECT COUNT(*) FROM edges`).Scan(&edges)
	return
}

func (s *Store) AllEntityIDs() ([]string, error) {
	rows, err := s.db.Query(`SELECT id FROM entities ORDER BY pinned DESC, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		rows.Scan(&id)
		out = append(out, id)
	}
	return out, nil
}

func (s *Store) Meta(k string) string {
	var v string
	s.db.QueryRow(`SELECT v FROM meta WHERE k=?`, k).Scan(&v)
	return v
}

func (s *Store) SetMeta(k, v string) error {
	_, err := s.db.Exec(`INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, k, v)
	return err
}

type Pending struct {
	ID         int64
	EntityID   string
	EntityName string
	Kind       string
	Attr       string
	Op         string
	Old, New   string
	Quote      string
	Source     string
	Confidence float64
	AskID      int64
}

func (s *Store) AddPending(p Pending) (int64, error) {
	res, err := s.db.Exec(`INSERT INTO pending(at,entity_id,entity_name,kind,attr,op,old,new,quote,source,confidence)
		VALUES(?,?,?,?,?,?,?,?,?,?,?)`, ts(time.Now()), p.EntityID, p.EntityName, p.Kind, p.Attr, p.Op, p.Old, p.New,
		clip(p.Quote, 400), p.Source, p.Confidence)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) OpenPending() ([]Pending, error) {
	rows, err := s.db.Query(`SELECT id,entity_id,entity_name,kind,attr,op,COALESCE(old,''),COALESCE(new,''),quote,source,
		COALESCE(confidence,0),COALESCE(ask_id,0) FROM pending WHERE state='open' ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Pending
	for rows.Next() {
		var p Pending
		rows.Scan(&p.ID, &p.EntityID, &p.EntityName, &p.Kind, &p.Attr, &p.Op, &p.Old, &p.New, &p.Quote, &p.Source, &p.Confidence, &p.AskID)
		out = append(out, p)
	}
	return out, nil
}

func (s *Store) SetPendingAsk(id, ask int64) error {
	_, err := s.db.Exec(`UPDATE pending SET ask_id=? WHERE id=?`, ask, id)
	return err
}

func (s *Store) ClosePending(id int64, state string) error {
	_, err := s.db.Exec(`UPDATE pending SET state=? WHERE id=?`, state, id)
	return err
}

// HasPending reports whether an equivalent proposal is already open.
func (s *Store) HasPending(entityID, attr, newVal string) bool {
	var n int
	s.db.QueryRow(`SELECT COUNT(*) FROM pending WHERE state='open' AND entity_id=? AND attr=? AND COALESCE(new,'')=?`,
		entityID, attr, newVal).Scan(&n)
	return n > 0
}

type Change struct {
	At, EntityID, Attr, Op, Old, New, Quote, Actor string
	Confidence                                     float64
}

func (s *Store) Changes(since time.Time) ([]Change, error) {
	rows, err := s.db.Query(`SELECT at,entity_id,attr,op,COALESCE(old,''),COALESCE(new,''),quote,actor,COALESCE(confidence,0)
		FROM changes WHERE at>=? ORDER BY id`, ts(since))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Change
	for rows.Next() {
		var c Change
		rows.Scan(&c.At, &c.EntityID, &c.Attr, &c.Op, &c.Old, &c.New, &c.Quote, &c.Actor, &c.Confidence)
		out = append(out, c)
	}
	return out, nil
}
