// Command l1 is Kes's L1 fast memory: a bounded, typed fact cache with
// first-mention gloss, decider-gated revision from Kev's own words, vetted
// intake, and decay. See packages/l1/README.md.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"familiar.local/l1/internal/decide"
	"familiar.local/l1/internal/session"
	"familiar.local/l1/internal/store"
)

const usage = `usage: l1 <command> [flags]

  cue      --session ID            stdin text → gloss lines for first mentions
  revise   --session-file F [--since 72h|RFC3339] [--dry-run]
  nominate --session-file F [--since 72h] [--dry-run]   stdin JSON nominations
  decay    [--target 150]
  asks     [--post [--ids 3,5]]   apply Kev's answers to pending items; --post stages asks
                                  (all open, or just --ids) only when the curator chooses
  seed     --glossary DIR         one-time import of hoard glossary macros
  set      ENTITY ATTR VALUE [--kind K] [--pin] [--alias a,b]
  show     [ENTITY]
  log      [--since 24h]
  replay   --session-file F [--since 72h]   dry-run cue + revision on a scratch copy; prints a report

env: FAMILIAR_L1_DB, FAMILIAR_L1_DECIDER_URL (fleet-local), FAMILIAR_L1_DECIDER_MODEL, FAMILIAR_L1_THRESHOLD (0.9)
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	var err error
	switch cmd {
	case "cue":
		err = cmdCue(args)
	case "revise":
		err = cmdRevise(args)
	case "nominate":
		err = cmdNominate(args)
	case "decay":
		err = cmdDecay(args)
	case "asks":
		err = cmdAsks(args)
	case "seed":
		err = cmdSeed(args)
	case "set":
		err = cmdSet(args)
	case "show":
		err = cmdShow(args)
	case "log":
		err = cmdLog(args)
	case "replay":
		err = cmdReplay(args)
	case "-h", "--help", "help":
		fmt.Print(usage)
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "l1:", err)
		os.Exit(1)
	}
}

func dbFlag(fs *flag.FlagSet) *string { return fs.String("db", store.DefaultPath(), "database path") }

func threshold() float64 {
	if v, err := strconv.ParseFloat(os.Getenv("FAMILIAR_L1_THRESHOLD"), 64); err == nil && v > 0 && v <= 1 {
		return v
	}
	return 0.9
}

func parseSince(v string, now time.Time) (time.Time, error) {
	if v == "" {
		return time.Time{}, nil
	}
	if d, err := time.ParseDuration(v); err == nil {
		return now.Add(-d), nil
	}
	return time.Parse(time.RFC3339, v)
}

// ---- cue ----

func cmdCue(args []string) error {
	fs := flag.NewFlagSet("cue", flag.ExitOnError)
	db := dbFlag(fs)
	sess := fs.String("session", "", "session id")
	max := fs.Int("max", 3, "max lines")
	fs.Parse(args)
	if *sess == "" {
		return errors.New("--session required")
	}
	text, _ := io.ReadAll(io.LimitReader(os.Stdin, 256<<10))
	s, err := store.Open(*db)
	if err != nil {
		return err
	}
	defer s.Close()
	lines, err := s.Cue(*sess, session.Clean(string(text)), *max)
	if err != nil {
		return err
	}
	for _, l := range lines {
		fmt.Println(l)
	}
	return nil
}

// ---- revision ----

// Below this, a non-keep verdict is noise: no ask, no change.
const pendingFloor = 0.6

const sysRevise = `You maintain a tiny cache of facts about people and things in Kevin's life. ` +
	`You judge ONLY from Kevin's own words quoted below. Speech-to-text may garble words. ` +
	`If his words don't clearly address the fact, the answer is keep. Hypotheticals, examples, jokes and ` +
	`quoted speech from others are NOT evidence: only his sincere statements of how things are now.`

type evidence struct {
	turns []session.Turn
}

func (e evidence) render(aliases []string) string {
	var b strings.Builder
	for _, t := range e.turns {
		who := "Kevin"
		if t.Role == "doc" {
			who = "document"
		}
		fmt.Fprintf(&b, "- [%s] %s: %q\n", t.At.Local().Format("Jan 2 15:04"), who, snippet(t.Text, aliases, 1400))
	}
	return b.String()
}

// snippet centres a window on the first alias mention.
func snippet(text string, aliases []string, n int) string {
	r := []rune(text)
	if len(r) <= n {
		return text
	}
	low := strings.ToLower(text)
	at := -1
	for _, a := range aliases {
		if i := strings.Index(low, a); i >= 0 && at < 0 {
			at = i
		}
	}
	if at < 0 {
		return string(r[:n]) + "…"
	}
	ri := len([]rune(low[:at]))
	start := ri - n/3
	if start < 0 {
		start = 0
	}
	end := start + n
	if end > len(r) {
		end = len(r)
		start = max(0, end-n)
	}
	return "…" + string(r[start:end]) + "…"
}

func gatherEvidence(s *store.Store, turns []session.Turn, perEntity int) (map[string]evidence, error) {
	ev := map[string]evidence{}
	for i, t := range turns {
		ids, err := s.Mentioned(t.Text)
		if err != nil {
			return nil, err
		}
		for _, id := range ids {
			e := ev[id]
			e.turns = append(e.turns, t)
			// Pronoun continuation: his next turn, if it follows closely and
			// names no other entity, is usually still about this one.
			if i+1 < len(turns) && turns[i+1].At.Sub(t.At) < 15*time.Minute {
				if next, _ := s.Mentioned(turns[i+1].Text); len(next) == 0 {
					e.turns = append(e.turns, turns[i+1])
				}
			}
			ev[id] = e
		}
	}
	for id, e := range ev { // keep the most recent N
		if len(e.turns) > perEntity {
			e.turns = e.turns[len(e.turns)-perEntity:]
			ev[id] = e
		}
	}
	return ev, nil
}

type outcome struct {
	Entity, Attr, Op, Old, New string
	P                          float64
	Applied                    bool
	Quote                      string
}

type reviser struct {
	s       *store.Store
	d       *decide.Client
	th      float64
	dry     bool
	source  string
	results []outcome
}

func (rv *reviser) record(o outcome) { rv.results = append(rv.results, o) }

func (rv *reviser) apply(ent store.Entity, attr, op, old, newV, quote string, p float64, actor string) error {
	o := outcome{Entity: ent.Name, Attr: attr, Op: op, Old: old, New: newV, P: p, Quote: quote}
	if p >= rv.th && quote != "" {
		o.Applied = true
		if !rv.dry {
			if err := rv.s.SetEdge(ent.ID, attr, newV, quote, rv.source, actor, p); err != nil {
				return err
			}
		}
	} else if p < pendingFloor {
		o.Op = "keep"
	} else if !rv.dry && !rv.s.HasPending(ent.ID, attr, newV) {
		if _, err := rv.s.AddPending(store.Pending{EntityID: ent.ID, EntityName: ent.Name, Kind: ent.Kind, Attr: attr,
			Op: op, Old: old, New: newV, Quote: quote, Source: rv.source, Confidence: p}); err != nil {
			return err
		}
	}
	rv.record(o)
	return nil
}

func (rv *reviser) reviseEntity(ctx context.Context, id string, ev evidence) error {
	ent, err := rv.s.Entity(id)
	if err != nil {
		return err
	}
	edges, err := rv.s.Edges(id)
	if err != nil {
		return err
	}
	words := ev.render(ent.Aliases)
	if os.Getenv("L1_DEBUG") != "" {
		fmt.Fprintf(os.Stderr, "--- evidence %s ---\n%s\n", ent.Name, words)
	}
	// support picks the one statement of Kevin's that best backs a claim,
	// so the logged quote is the evidence, not just the latest mention.
	support := func(claim string) string { return rv.pick(ctx, ev.turns, ent.Aliases, claim) }
	header := fmt.Sprintf("Subject: %s (%s). Also called: %s.\nKevin's words mentioning them:\n%s", ent.Name, ent.Kind,
		strings.Join(ent.Aliases, ", "), words)

	have := map[string]bool{}
	for _, e := range edges {
		have[e.Attr] = true
		state := header + fmt.Sprintf("\nStored fact: %s's %s = %q", ent.Name, strings.ReplaceAll(e.Attr, "_", " "), e.Value)
		q := fmt.Sprintf("What do Kevin's words say about %s's %s (%s)?", ent.Name, strings.ReplaceAll(e.Attr, "_", " "), attrHelp[e.Attr])
		i, probs, err := rv.d.Choice(ctx, sysRevise, state, q, []string{
			"nothing — his words don't address it",
			"they agree with the stored value",
			"they give a different current value",
			"they say it's no longer true, with no replacement",
		})
		if err != nil {
			return err
		}
		if os.Getenv("L1_DEBUG") != "" {
			fmt.Fprintf(os.Stderr, "  %s.%s=%q → %d %.2f\n", ent.Name, e.Attr, e.Value, i, probs)
		}
		// Collapse to keep / update / retract.
		probs = []float64{probs[0] + probs[1], probs[2], probs[3]}
		switch i {
		case 0, 1:
			i = 0
		case 2:
			i = 1
		case 3:
			i = 2
		}
		switch i {
		case 1:
			v, err := rv.d.Extract(ctx, sysRevise, state+fmt.Sprintf("\n\nGive the new current value of %s.%s, short, in the same style as the stored value.", ent.Name, e.Attr), store.MaxValueChars)
			if err != nil {
				return err
			}
			if v == "" || strings.EqualFold(v, e.Value) {
				rv.record(outcome{Entity: ent.Name, Attr: e.Attr, Op: "keep", Old: e.Value, P: probs[1]})
				continue
			}
			if err := rv.apply(ent, e.Attr, "update", e.Value, v, support(fmt.Sprintf("%s's %s is now %q", ent.Name, e.Attr, v)), probs[1], "revise"); err != nil {
				return err
			}
		case 2:
			if err := rv.apply(ent, e.Attr, "retract", e.Value, "", support(fmt.Sprintf("%s's %s is no longer %q", ent.Name, e.Attr, e.Value)), probs[2], "revise"); err != nil {
				return err
			}
		default:
			rv.record(outcome{Entity: ent.Name, Attr: e.Attr, Op: "keep", Old: e.Value, P: probs[0]})
		}
	}

	// One question for missing slots.
	var missing []string
	for _, a := range store.Attrs {
		if !have[a] {
			missing = append(missing, a)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	known := ""
	for _, e := range edges {
		known += fmt.Sprintf("%s=%q; ", e.Attr, e.Value)
	}
	opts := []string{"none — his words state no new lasting fact in these slots"}
	for _, a := range missing {
		opts = append(opts, a+" — "+attrHelp[a])
	}
	i, probs, err := rv.d.Choice(ctx, sysRevise, header+"\nAlready stored: "+known,
		fmt.Sprintf("Do Kevin's words clearly state a lasting fact about %s for one of these empty slots? Pick the clearest, or none.", ent.Name), opts)
	if err != nil {
		return err
	}
	if i == 0 {
		return nil
	}
	attr := missing[i-1]
	v, err := rv.d.Extract(ctx, sysRevise, header+fmt.Sprintf("\n\nGive the value of %s.%s (%s), short.", ent.Name, attr, attrHelp[attr]), store.MaxValueChars)
	if err != nil || v == "" {
		return err
	}
	return rv.apply(ent, attr, "add", "", v, support(fmt.Sprintf("%s's %s is %q", ent.Name, attr, v)), probs[i], "revise")
}

var attrHelp = map[string]string{
	"relation":        "their relation to Kevin",
	"role":            "job title or role",
	"employer":        "current employer or organization",
	"former_employer": "previous employer relevant to Kevin",
	"location":        "where they live or where it is",
	"age":             "age in years",
	"born":            "birth date or year",
	"author":          "author or creator of a work",
	"status":          "current status (reading, done, live, retired...)",
	"origin":          "where it came from / how it entered Kevin's life",
	"link":            "a pointer: doc path, repo, or URL",
}

func cmdRevise(args []string) error {
	fs := flag.NewFlagSet("revise", flag.ExitOnError)
	db := dbFlag(fs)
	file := fs.String("session-file", "", "pi session jsonl")
	since := fs.String("since", "", "window start (duration or RFC3339); default: last revision")
	dry := fs.Bool("dry-run", false, "decide but don't write")
	fs.Parse(args)
	if *file == "" {
		return errors.New("--session-file required")
	}
	s, err := store.Open(*db)
	if err != nil {
		return err
	}
	defer s.Close()
	d, err := decide.FromEnv()
	if err != nil {
		return err
	}
	now := time.Now()
	from, err := parseSince(*since, now)
	if err != nil {
		return err
	}
	if from.IsZero() {
		if last := s.Meta("revised_until"); last != "" {
			from, _ = time.Parse(time.RFC3339Nano, last)
		} else {
			from = now.Add(-24 * time.Hour)
		}
	}
	rv := &reviser{s: s, d: d, th: threshold(), dry: *dry, source: filepath.Base(*file)}
	if err := runRevision(context.Background(), rv, *file, from, now); err != nil {
		return err
	}
	if !*dry {
		s.SetMeta("revised_until", now.UTC().Format(time.RFC3339Nano))
	}
	printOutcomes(os.Stdout, rv.results, false)
	return nil
}

func runRevision(ctx context.Context, rv *reviser, file string, from, until time.Time) error {
	turns, err := session.KevTurns(file, from, until)
	if err != nil {
		return err
	}
	ev, err := gatherEvidence(rv.s, turns, 6)
	if err != nil {
		return err
	}
	ids := make([]string, 0, len(ev))
	for id := range ev {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if err := rv.reviseEntity(ctx, id, ev[id]); err != nil {
			return fmt.Errorf("%s: %w", id, err)
		}
	}
	return nil
}

func printOutcomes(w io.Writer, rs []outcome, keeps bool) {
	for _, o := range rs {
		if o.Op == "keep" && !keeps {
			continue
		}
		state := "pending"
		if o.Applied {
			state = "applied"
		} else if o.Op == "reject" {
			state = "-"
		}
		fmt.Fprintf(w, "%-8s %-7s %s.%s: %q → %q (p=%.2f)\n", o.Op, state, o.Entity, o.Attr, o.Old, o.New, o.P)
		if o.Quote != "" && o.Op != "keep" {
			fmt.Fprintf(w, "         ↳ %s\n", oneLine(o.Quote, 220))
		}
	}
}

func oneLine(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

// ---- intake ----

type nomination struct {
	Entity  string   `json:"entity"`
	Kind    string   `json:"kind"`
	Aliases []string `json:"aliases"`
	Attr    string   `json:"attr"`
	Value   string   `json:"value"`
	Pin     bool     `json:"-"`
}

const sysIntake = `You vet proposed memory facts for Kevin's companion. Accept a fact only if Kevin's own words, or a primary document quoted below, ` +
	`support it as currently true. The companion's own speculation does not count. Hypotheticals, examples and jokes do not count. ` +
	`Speech-to-text may garble Kevin's words.`

func cmdNominate(args []string) error {
	fs := flag.NewFlagSet("nominate", flag.ExitOnError)
	db := dbFlag(fs)
	file := fs.String("session-file", "", "pi session jsonl")
	since := fs.String("since", "72h", "evidence window")
	dry := fs.Bool("dry-run", false, "vet but don't write")
	fs.Parse(args)
	if *file == "" {
		return errors.New("--session-file required")
	}
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 64<<10))
	if err != nil {
		return err
	}
	var noms []nomination
	if err := json.Unmarshal(raw, &noms); err != nil {
		var wrap struct {
			Nominations []nomination `json:"nominations"`
		}
		if err2 := json.Unmarshal(raw, &wrap); err2 != nil {
			return fmt.Errorf("nominations JSON: %w", err)
		}
		noms = wrap.Nominations
	}
	if len(noms) > 8 {
		noms = noms[:8]
	}
	s, err := store.Open(*db)
	if err != nil {
		return err
	}
	defer s.Close()
	d, err := decide.FromEnv()
	if err != nil {
		return err
	}
	now := time.Now()
	from, err := parseSince(*since, now)
	if err != nil {
		return err
	}
	turns, err := session.Docs(*file, from, now)
	if err != nil {
		return err
	}
	rv := &reviser{s: s, d: d, th: threshold(), dry: *dry, source: filepath.Base(*file)}
	for _, n := range noms {
		if err := vetNomination(context.Background(), rv, turns, n); err != nil {
			fmt.Fprintln(os.Stderr, "l1: nomination:", n.Entity, err)
		}
	}
	printOutcomes(os.Stdout, rv.results, true)
	return nil
}

func vetNomination(ctx context.Context, rv *reviser, turns []session.Turn, n nomination) error {
	n.Attr = strings.TrimSpace(n.Attr)
	if n.Entity == "" || !store.ValidAttr(n.Attr) || strings.TrimSpace(n.Value) == "" {
		return fmt.Errorf("invalid nomination (attr must be one of %s)", strings.Join(store.Attrs, ","))
	}
	if n.Kind == "" || !store.ValidKind(n.Kind) {
		n.Kind = "other"
	}
	aliases := []string{strings.ToLower(n.Entity)}
	for _, a := range n.Aliases {
		if a = strings.ToLower(strings.TrimSpace(a)); len(a) >= 2 {
			aliases = append(aliases, a)
		}
	}
	var kevHits, docHits []session.Turn
	for _, t := range turns {
		low := " " + strings.ToLower(t.Text) + " "
		for _, a := range aliases {
			if strings.Contains(low, a) {
				if t.Role == "doc" {
					docHits = append(docHits, t)
				} else {
					kevHits = append(kevHits, t)
				}
				break
			}
		}
	}
	if len(kevHits) > 4 {
		kevHits = kevHits[len(kevHits)-4:]
	}
	if len(docHits) > 2 {
		docHits = docHits[len(docHits)-2:]
	}
	hits := append(kevHits, docHits...)
	if len(hits) == 0 {
		rv.record(outcome{Entity: n.Entity, Attr: n.Attr, Op: "reject", New: n.Value, Quote: "(nothing from Kevin or a document mentions it)"})
		return nil
	}
	ev := evidence{turns: hits}
	state := fmt.Sprintf("Proposed fact: %s (%s) %s = %q\nEvidence mentioning it:\n%s", n.Entity, n.Kind, n.Attr, n.Value, ev.render(aliases))
	i, probs, err := rv.d.Choice(ctx, sysIntake, state, fmt.Sprintf("Does the evidence say or clearly imply that %s's %s (%s) is %q?", n.Entity, strings.ReplaceAll(n.Attr, "_", " "), attrHelp[n.Attr], n.Value), []string{
		"yes", "no — they contradict it", "they don't say",
	})
	if err != nil {
		return err
	}
	if os.Getenv("L1_DEBUG") != "" {
		fmt.Fprintf(os.Stderr, "--- nominate %s.%s=%q → %d %.2f\n%s\n", n.Entity, n.Attr, n.Value, i, probs, state)
	}
	if i != 0 {
		rv.record(outcome{Entity: n.Entity, Attr: n.Attr, Op: "reject", New: n.Value, P: probs[i]})
		return nil
	}
	ent := store.Entity{Name: n.Entity, Kind: n.Kind, Aliases: n.Aliases}
	quote := rv.pick(ctx, hits, aliases, fmt.Sprintf("%s's %s is %q", n.Entity, n.Attr, n.Value))
	if probs[0] >= rv.th && !rv.dry {
		id, err := rv.s.UpsertEntity(ent)
		if err != nil {
			return err
		}
		ent.ID = id
	} else {
		ent.ID = store.Slug(n.Entity)
		if existing, ok := rv.s.EntityByAlias(n.Entity); ok {
			ent.ID = existing
		}
	}
	return rv.apply(ent, n.Attr, "add", "", n.Value, quote, probs[0], "intake")
}

// ---- decay ----

func cmdDecay(args []string) error {
	fs := flag.NewFlagSet("decay", flag.ExitOnError)
	db := dbFlag(fs)
	target := fs.Int("target", 150, "target edge count")
	fs.Parse(args)
	s, err := store.Open(*db)
	if err != nil {
		return err
	}
	defer s.Close()
	n, err := s.Decay(*target, time.Now())
	if err != nil {
		return err
	}
	e, ed := s.Count()
	fmt.Printf("evicted %d; %d entities, %d edges\n", n, e, ed)
	return nil
}

// ---- asks (below-threshold → Attention) ----

func imp(stdin string, args ...string) ([]byte, error) {
	bin := "imp"
	if d := os.Getenv("FAMILIAR_IMP_BIN"); d != "" {
		bin = filepath.Join(d, "imp")
	}
	c := exec.Command(bin, args...)
	if stdin != "" {
		c.Stdin = strings.NewReader(stdin)
	}
	c.Stderr = os.Stderr
	return c.Output()
}

func ensureCard(s *store.Store) (string, error) {
	if id := s.Meta("ask_card"); id != "" {
		return id, nil
	}
	out, err := imp("", "attn", "card", "add", "--project", "familiar", "--owner", "kes",
		"--title", "L1 memory: fact changes the decider wasn't sure about", "--json")
	if err != nil {
		return "", err
	}
	var c struct {
		ID   string `json:"id"`
		Card struct {
			ID string `json:"id"`
		} `json:"card"`
	}
	if err := json.Unmarshal(out, &c); err != nil {
		return "", fmt.Errorf("card add: %w", err)
	}
	id := c.ID
	if id == "" {
		id = c.Card.ID
	}
	if id == "" {
		return "", errors.New("card add: no id")
	}
	return id, s.SetMeta("ask_card", id)
}

func cmdAsks(args []string) error {
	fs := flag.NewFlagSet("asks", flag.ExitOnError)
	db := dbFlag(fs)
	post := fs.Bool("post", false, "stage open, unasked pending items as Attention asks (the curator's call)")
	ids := fs.String("ids", "", "with --post: comma-separated pending ids to stage (default: all open)")
	fs.Parse(args)
	pick := map[int64]bool{}
	for _, x := range strings.Split(*ids, ",") {
		if x = strings.TrimSpace(x); x != "" {
			n, err := strconv.ParseInt(x, 10, 64)
			if err != nil {
				return fmt.Errorf("bad --ids entry %q", x)
			}
			pick[n] = true
		}
	}
	if len(pick) > 0 && !*post {
		return errors.New("--ids needs --post")
	}
	s, err := store.Open(*db)
	if err != nil {
		return err
	}
	defer s.Close()
	pend, err := s.OpenPending()
	if err != nil {
		return err
	}
	// Apply resolutions first.
	resolved := map[int64]string{}
	if out, err := imp("", "attn", "ask", "list", "--all", "--json"); err == nil {
		var l struct {
			Resolved []struct {
				ID         int64  `json:"id"`
				Resolution string `json:"resolution"`
			} `json:"resolved"`
		}
		if json.Unmarshal(out, &l) == nil {
			for _, r := range l.Resolved {
				resolved[r.ID] = r.Resolution
			}
		}
	}
	posted, applied := 0, 0
	for _, p := range pend {
		if p.AskID != 0 {
			res, ok := resolved[p.AskID]
			if !ok {
				continue
			}
			switch res {
			case "yes":
				id := p.EntityID
				if _, err := s.Entity(id); err != nil {
					if id, err = s.UpsertEntity(store.Entity{ID: p.EntityID, Name: p.EntityName, Kind: p.Kind}); err != nil {
						return err
					}
				}
				if err := s.SetEdge(id, p.Attr, p.New, p.Quote, p.Source, "kev", 1); err != nil {
					return err
				}
				s.ClosePending(p.ID, "accepted")
				applied++
			case "no":
				s.ClosePending(p.ID, "rejected")
			default: // not-now: leave open, re-ask later
				s.SetPendingAsk(p.ID, 0)
			}
			continue
		}
		if !*post || (len(pick) > 0 && !pick[p.ID]) {
			// Posting is the curator's choice (Kev, Oct 22); the session-end
			// hook only applies answers. Unposted items stay open.
			continue
		}
		card, err := ensureCard(s)
		if err != nil {
			return err
		}
		var q string
		switch p.Op {
		case "retract":
			q = fmt.Sprintf("Forget that %s's %s is %q?", p.EntityName, strings.ReplaceAll(p.Attr, "_", " "), p.Old)
		case "update":
			q = fmt.Sprintf("Remember %s's %s as %q (was %q)?", p.EntityName, strings.ReplaceAll(p.Attr, "_", " "), p.New, p.Old)
		default:
			q = fmt.Sprintf("Remember %s's %s as %q?", p.EntityName, strings.ReplaceAll(p.Attr, "_", " "), p.New)
		}
		if r := []rune(q); len(r) > 280 {
			q = string(r[:279]) + "…"
		}
		ask := map[string]any{
			"card":     card,
			"question": q,
			"steps":    "Your words: “" + oneLine(p.Quote, 300) + "”",
			"actions": []map[string]any{
				{"key": "yes", "label": "Yes", "primary": true, "done": "Remembered"},
				{"key": "no", "label": "No", "done": "Dropped"},
			},
		}
		body, _ := json.Marshal(ask)
		out, err := imp(string(body), "attn", "ask", "add", "--json-in", "--stage", "--json")
		if err != nil {
			return err
		}
		var a struct {
			ID  int64 `json:"id"`
			Ask struct {
				ID int64 `json:"id"`
			} `json:"ask"`
		}
		json.Unmarshal(out, &a)
		id := a.ID
		if id == 0 {
			id = a.Ask.ID
		}
		if id != 0 {
			s.SetPendingAsk(p.ID, id)
			posted++
		}
	}
	fmt.Printf("asks: posted %d, applied %d\n", posted, applied)
	return nil
}

// ---- seed / set / show / log ----

func cmdSeed(args []string) error {
	fs := flag.NewFlagSet("seed", flag.ExitOnError)
	db := dbFlag(fs)
	dir := fs.String("glossary", "", "hoard macros/glossary directory")
	fs.Parse(args)
	if *dir == "" {
		return errors.New("--glossary required")
	}
	s, err := store.Open(*db)
	if err != nil {
		return err
	}
	defer s.Close()
	d, err := decide.FromEnv()
	if err != nil {
		return err
	}
	files, _ := filepath.Glob(filepath.Join(*dir, "*.json"))
	props := map[string]any{"kind": map[string]any{"type": "string", "enum": store.Kinds}}
	req := []string{"kind"}
	for _, a := range store.Attrs {
		props[a] = map[string]any{"anyOf": []any{map[string]any{"type": "string", "maxLength": 80}, map[string]any{"type": "null"}}}
		req = append(req, a)
	}
	schema := map[string]any{"type": "object", "properties": props, "required": req, "additionalProperties": false}
	skip := map[string]bool{}
	for _, n := range strings.Split(os.Getenv("L1_SEED_SKIP"), ",") {
		skip[strings.TrimSpace(n)] = true
	}
	for _, f := range files {
		if skip[strings.TrimSuffix(filepath.Base(f), ".json")] {
			continue
		}
		raw, err := os.ReadFile(f)
		if err != nil {
			return err
		}
		var m struct {
			Description string `json:"description"`
			Match       struct {
				Patterns []string `json:"patterns"`
			} `json:"match_config"`
			Body struct {
				Text string `json:"text"`
			} `json:"prompt_body"`
		}
		if err := json.Unmarshal(raw, &m); err != nil {
			return fmt.Errorf("%s: %w", f, err)
		}
		name := ""
		if i := strings.Index(m.Body.Text, "**"); i >= 0 {
			if j := strings.Index(m.Body.Text[i+2:], "**"); j > 0 {
				name = m.Body.Text[i+2 : i+2+j]
			}
		}
		if name == "" {
			return fmt.Errorf("%s: no **Name** in body", f)
		}
		var help []string
		for _, a := range store.Attrs {
			help = append(help, a+" ("+attrHelp[a]+")")
		}
		prompt := "Glossary entry for " + name + ":\n" + oneLine(m.Body.Text, 1500) +
			"\n\nFill each slot with a short value ONLY if the entry states it about " + name + "; otherwise null. " +
			"Slots: " + strings.Join(help, "; ") + ". relation is phrased from Kevin's side, e.g. \"Kevin's former boss at Calendly\". " +
			"No sensitive personal history; only these slots."
		obj, err := d.Object(context.Background(), "You convert glossary prose into typed facts. Never invent. Prefer null.", prompt, schema, 400)
		if err != nil {
			return fmt.Errorf("%s: %w", f, err)
		}
		kind, _ := obj["kind"].(string)
		var aliases []string
		for _, p := range m.Match.Patterns {
			if !strings.Contains(p, "-") {
				aliases = append(aliases, p)
			}
		}
		id, err := s.UpsertEntity(store.Entity{Name: name, Kind: kind, Aliases: aliases})
		if err != nil {
			return fmt.Errorf("%s: %w", f, err)
		}
		for _, a := range store.Attrs {
			if v, _ := obj[a].(string); strings.TrimSpace(v) != "" && !strings.EqualFold(v, "kevin") && !strings.EqualFold(v, name) && !strings.EqualFold(v, "null") {
				if err := s.SetEdge(id, a, v, "glossary: "+oneLine(m.Description, 200), filepath.Base(f), "seed", 1); err != nil {
					return err
				}
			}
		}
		g, _ := s.Gloss(id)
		fmt.Println(g)
	}
	return nil
}

func cmdSet(args []string) error {
	fs := flag.NewFlagSet("set", flag.ExitOnError)
	db := dbFlag(fs)
	kind := fs.String("kind", "other", "entity kind")
	pin := fs.Bool("pin", false, "never evict")
	alias := fs.String("alias", "", "comma-separated aliases")
	quote := fs.String("quote", "", "evidence")
	// allow flags after positionals
	var pos []string
	for i := 0; i < len(args); i++ {
		if strings.HasPrefix(args[i], "-") && args[i] != "-" {
			fs.Parse(args[i:])
			pos = append(pos, fs.Args()...)
			break
		}
		pos = append(pos, args[i])
	}
	if len(pos) < 2 {
		return errors.New("usage: l1 set ENTITY ATTR [VALUE] (empty VALUE retracts; ATTR '-' just creates/pins)")
	}
	s, err := store.Open(*db)
	if err != nil {
		return err
	}
	defer s.Close()
	var aliases []string
	if *alias != "" {
		aliases = strings.Split(*alias, ",")
	}
	id, ok := s.EntityByAlias(pos[0])
	if !ok || *pin || len(aliases) > 0 || *kind != "other" {
		e := store.Entity{Name: pos[0], Kind: *kind, Pinned: *pin, Aliases: aliases}
		if ok {
			e.ID = id
		}
		if id, err = s.UpsertEntity(e); err != nil {
			return err
		}
	}
	if pos[1] == "-" {
		return nil
	}
	val := ""
	if len(pos) > 2 {
		val = strings.Join(pos[2:], " ")
	}
	return s.SetEdge(id, pos[1], val, *quote, "manual", "kes", 1)
}

func cmdShow(args []string) error {
	fs := flag.NewFlagSet("show", flag.ExitOnError)
	db := dbFlag(fs)
	fs.Parse(args)
	s, err := store.Open(*db)
	if err != nil {
		return err
	}
	defer s.Close()
	var ids []string
	if fs.NArg() > 0 {
		id, ok := s.EntityByAlias(strings.Join(fs.Args(), " "))
		if !ok {
			return errors.New("no such entity")
		}
		ids = []string{id}
	} else if ids, err = s.AllEntityIDs(); err != nil {
		return err
	}
	for _, id := range ids {
		e, _ := s.Entity(id)
		pin := ""
		if e.Pinned {
			pin = " 📌"
		}
		g, _ := s.Gloss(id)
		if g == "" {
			g = e.Name + " — (no facts)"
		}
		fmt.Printf("%s%s  [%s; %s]\n", g, pin, e.Kind, strings.Join(e.Aliases, ", "))
	}
	ne, ned := s.Count()
	fmt.Printf("— %d entities, %d edges\n", ne, ned)
	return nil
}

func cmdLog(args []string) error {
	fs := flag.NewFlagSet("log", flag.ExitOnError)
	db := dbFlag(fs)
	since := fs.String("since", "24h", "window")
	fs.Parse(args)
	s, err := store.Open(*db)
	if err != nil {
		return err
	}
	defer s.Close()
	from, err := parseSince(*since, time.Now())
	if err != nil {
		return err
	}
	cs, err := s.Changes(from)
	if err != nil {
		return err
	}
	for _, c := range cs {
		fmt.Printf("%s %-7s %-6s %s.%s %q → %q (p=%.2f)\n", c.At[:16], c.Op, c.Actor, c.EntityID, c.Attr, c.Old, c.New, c.Confidence)
	}
	return nil
}

// ---- replay ----

func copyFile(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, b, 0o600)
}

func cmdReplay(args []string) error {
	fs := flag.NewFlagSet("replay", flag.ExitOnError)
	db := dbFlag(fs)
	file := fs.String("session-file", "", "pi session jsonl")
	since := fs.String("since", "72h", "window")
	fs.Parse(args)
	if *file == "" {
		return errors.New("--session-file required")
	}
	tmp, err := os.MkdirTemp("", "l1-replay-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	scratch := filepath.Join(tmp, "l1.db")
	if err := copyFile(*db, scratch); err != nil {
		return err
	}
	s, err := store.Open(scratch)
	if err != nil {
		return err
	}
	defer s.Close()
	now := time.Now()
	from, err := parseSince(*since, now)
	if err != nil {
		return err
	}
	turns, err := session.KevTurns(*file, from, now)
	if err != nil {
		return err
	}
	// Cue: simulate per-session first mention. Session boundaries are
	// approximated by handoff gaps; one session for the whole window is the
	// conservative (fewest injections) case, so also count per-day sessions.
	inject, injectDaily := 0, 0
	fmt.Printf("== cue over %d Kev turns since %s ==\n", len(turns), from.Local().Format("Jan 2 15:04"))
	for _, t := range turns {
		lines, err := s.Cue("replay-window", t.Text, 3)
		if err != nil {
			return err
		}
		inject += len(lines)
		for _, l := range lines {
			fmt.Printf("  [%s] %s\n", t.At.Local().Format("Jan 2 15:04"), l)
		}
		dl, _ := s.Cue("replay-"+t.At.Local().Format("2006-01-02"), t.Text, 3)
		injectDaily += len(dl)
	}
	per10 := func(n int) float64 {
		if len(turns) == 0 {
			return 0
		}
		return float64(n) * 10 / float64(len(turns))
	}
	fmt.Printf("injections: %d over %d turns (%.2f per 10 turns); with daily sessions: %d (%.2f per 10)\n\n",
		inject, len(turns), per10(inject), injectDaily, per10(injectDaily))

	d, err := decide.FromEnv()
	if err != nil {
		return err
	}
	rv := &reviser{s: s, d: d, th: threshold(), dry: true, source: filepath.Base(*file)}
	start := time.Now()
	if err := runRevision(context.Background(), rv, *file, from, now); err != nil {
		return err
	}
	fmt.Printf("== revision (dry run, threshold %.2f): %d decisions, %d decider calls, %s ==\n",
		rv.th, len(rv.results), d.Calls, time.Since(start).Round(time.Second))
	printOutcomes(os.Stdout, rv.results, false)
	return nil
}

// pick chooses the single statement that best backs a claim, so the logged
// quote is the evidence itself, centred on the claimed value when it appears.
func (rv *reviser) pick(ctx context.Context, turns []session.Turn, aliases []string, claim string) string {
	centre := aliases
	if i := strings.LastIndex(claim, `"`); i > 0 {
		if j := strings.LastIndex(claim[:i], `"`); j >= 0 && i-j > 2 {
			centre = append([]string{strings.ToLower(claim[j+1 : i])}, aliases...)
		}
	}
	cut := func(t session.Turn, n int) string {
		s := snippet(t.Text, centre, n)
		if t.Role == "doc" {
			return "[document] " + s
		}
		return s
	}
	if len(turns) == 1 {
		return cut(turns[0], 400)
	}
	var opts []string
	for _, t := range turns {
		opts = append(opts, oneLine(cut(t, 600), 600))
	}
	i, _, err := rv.d.Choice(ctx, sysRevise, "Claim: "+claim, "Which statement best supports the claim?", opts)
	if err != nil {
		return cut(turns[len(turns)-1], 400)
	}
	return cut(turns[i], 400)
}
