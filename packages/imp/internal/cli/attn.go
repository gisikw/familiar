package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // DATE resolution must work in a minimal Nix closure
)

// maxAttnRows bounds every human list rendering by construction; the resident
// clips list results to the same figure and reports total/truncated.
const maxAttnRows = 64

var (
	attnLanes    = []string{"captured", "icebox", "clarified", "inflight", "review", "settling", "archived"}
	attnOwners   = []string{"kevin", "kes"}
	attnPolicies = []string{"ship-quiet", "ship-tell", "pr-evidence", "talk-first"}
	attnEdges    = []string{"blocked", "review", "live"}
	attnKinds    = []string{"pr", "commit", "shot", "run", "link"}
	attnStates   = []string{"running", "blocked", "done", "failed", "cancelled"}
)

var attnValueFlags = map[string]bool{
	"label": true, "default-policy": true, "repo": true, "project": true, "lane": true,
	"owner": true, "edge": true, "q": true, "title": true, "summary": true, "policy": true,
	"reason": true, "text": true, "detail": true, "kind": true, "ref": true, "meta": true,
	"name": true, "model": true, "host": true, "harness": true, "state": true, "question": true,
	"hold-until": true, "due": true, "maybe-on": true,
}
var attnBoolFlags = map[string]bool{"hidden": true, "undo": true, "all": true, "stage": true, "json-in": true}

// attnNow is the clock for DATE flags and date-relative rendering; tests
// replace it.
var attnNow = time.Now

const attnTZ = "America/Chicago"

func attnLocation() *time.Location {
	loc, err := time.LoadLocation(attnTZ)
	if err != nil {
		return time.UTC
	}
	return loc
}

var attnWeekdays = map[string]time.Weekday{
	"sun": time.Sunday, "sunday": time.Sunday,
	"mon": time.Monday, "monday": time.Monday,
	"tue": time.Tuesday, "tues": time.Tuesday, "tuesday": time.Tuesday,
	"wed": time.Wednesday, "weds": time.Wednesday, "wednesday": time.Wednesday,
	"thu": time.Thursday, "thur": time.Thursday, "thurs": time.Thursday, "thursday": time.Thursday,
	"fri": time.Friday, "friday": time.Friday,
	"sat": time.Saturday, "saturday": time.Saturday,
}

// parseAttnDate resolves YYYY-MM-DD, today, tomorrow, or a weekday name/abbrev
// (next occurrence; today counts if it is that weekday) to YYYY-MM-DD in
// America/Chicago.
func parseAttnDate(v string, now time.Time) (string, error) {
	now = now.In(attnLocation())
	v = strings.ToLower(strings.TrimSpace(v))
	switch v {
	case "today":
		return now.Format("2006-01-02"), nil
	case "tomorrow":
		return now.AddDate(0, 0, 1).Format("2006-01-02"), nil
	}
	if wd, ok := attnWeekdays[v]; ok {
		days := (int(wd) - int(now.Weekday()) + 7) % 7
		return now.AddDate(0, 0, days).Format("2006-01-02"), nil
	}
	if len(v) == 10 {
		if t, err := time.Parse("2006-01-02", v); err == nil {
			return t.Format("2006-01-02"), nil
		}
	}
	return "", fmt.Errorf("date must be YYYY-MM-DD, today, tomorrow, or a weekday name like fri")
}

// attnDueLabel renders a due date relative to today in America/Chicago:
// "today", a weekday abbreviation within six days either side, else the date.
func attnDueLabel(due string, now time.Time) string {
	d, err := time.Parse("2006-01-02", due)
	if err != nil {
		return due
	}
	n := now.In(attnLocation())
	today := time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, time.UTC)
	days := int(d.Sub(today).Hours() / 24)
	switch {
	case days == 0:
		return "today"
	case days >= -6 && days <= 6:
		return d.Format("Mon")
	}
	return due
}

// attnVerbs enumerates the exact noun/verb table; the wire operation is noun.verb.
var attnVerbs = map[string][]string{
	"project":  {"list", "get", "add", "set"},
	"card":     {"list", "get", "add", "set", "move", "block", "unblock", "done"},
	"note":     {"add"},
	"evidence": {"add"},
	"agent":    {"start", "set"},
	"jot":      {"add", "list", "clear-done"},
	"ask":      {"add", "list", "resolve", "more", "drop", "surface", "talk"},
}
var attnNouns = []string{"project", "card", "note", "evidence", "agent", "jot", "ask", "status"}

func attnVerb(noun, verb string) bool { return inSet(attnVerbs[noun], verb) }

func inSet(set []string, v string) bool {
	for _, s := range set {
		if s == v {
			return true
		}
	}
	return false
}

// attnMain handles argv after the "attn" area word, including help.
func attnMain(argv []string, stdin io.Reader, stdout, stderr io.Writer) (invocation, bool, int) {
	if len(argv) == 0 || isHelp(argv[0]) {
		io.WriteString(stdout, attnHelp)
		return invocation{}, true, 0
	}
	noun := argv[0]
	if noun == "status" {
		if len(argv) > 1 && isHelp(argv[1]) {
			io.WriteString(stdout, attnUsage["status"])
			return invocation{}, true, 0
		}
	} else {
		if _, ok := attnVerbs[noun]; !ok {
			return invocation{}, true, usageError(stderr, "unknown attn noun %q; try 'imp attn --help'", noun)
		}
		if len(argv) == 1 || isHelp(argv[1]) {
			io.WriteString(stdout, attnNounHelp(noun))
			return invocation{}, true, 0
		}
		verb := argv[1]
		if !attnVerb(noun, verb) {
			return invocation{}, true, usageError(stderr, "unknown attn command %q; try 'imp attn %s --help'", noun+" "+verb, noun)
		}
		if len(argv) > 2 && isHelp(argv[2]) {
			io.WriteString(stdout, attnUsage[noun+"."+verb])
			return invocation{}, true, 0
		}
	}
	inv, err := parseAttn(argv, stdin)
	if err != nil {
		return invocation{}, true, usageError(stderr, "%v", err)
	}
	return inv, false, 0
}

func attnNounHelp(noun string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Usage: imp attn %s <command> [options]\n\nCommands:\n", noun)
	for _, verb := range attnVerbs[noun] {
		usage := attnUsage[noun+"."+verb]
		b.WriteString("  " + strings.TrimSuffix(strings.TrimPrefix(usage, "Usage: "), "\n") + "\n")
	}
	b.WriteString("\nUse 'imp attn " + noun + " <command> --help' for command details.\nAll commands accept --json. Prose flags accept '-' to read stdin.\n")
	return b.String()
}

func parseAttn(argv []string, stdin io.Reader) (invocation, error) {
	var op string
	var rest []string
	if argv[0] == "status" {
		op, rest = "status", argv[1:]
	} else {
		op, rest = argv[0]+"."+argv[1], argv[2:]
	}
	flags, positional, jsonMode, err := parseFlagsWith(rest, attnValueFlags, attnBoolFlags)
	if err != nil {
		return invocation{}, err
	}
	out := invocation{operation: op, args: map[string]any{}, json: jsonMode}
	stdinUsed := false

	takePositional := func(what string) (string, error) {
		if len(positional) == 0 || positional[0] == "-" {
			return "", fmt.Errorf("%s requires a %s", op, what)
		}
		v := positional[0]
		positional = positional[1:]
		if len(v) > 256 || strings.IndexByte(v, 0) >= 0 {
			return "", fmt.Errorf("%s is invalid or too long", what)
		}
		return v, nil
	}
	putShort := func(flag, wire string, max int, required bool) error {
		v, ok := flags.take(flag)
		if !ok {
			if required {
				return fmt.Errorf("%s requires --%s VALUE", op, flag)
			}
			return nil
		}
		if strings.TrimSpace(v) == "" || len(v) > max || strings.IndexByte(v, 0) >= 0 {
			return fmt.Errorf("--%s is invalid or too long", flag)
		}
		out.args[wire] = v
		return nil
	}
	putEnum := func(flag, wire string, allowed []string, required bool) error {
		v, ok := flags.take(flag)
		if !ok {
			if required {
				return fmt.Errorf("%s requires --%s <%s>", op, flag, strings.Join(allowed, "|"))
			}
			return nil
		}
		if !inSet(allowed, v) {
			return fmt.Errorf("--%s must be one of %s", flag, strings.Join(allowed, ", "))
		}
		out.args[wire] = v
		return nil
	}
	putProse := func(flag, wire string, required bool) error {
		v, ok := flags.take(flag)
		if !ok {
			if required {
				return fmt.Errorf("%s requires --%s TEXT (a lone '-' reads stdin)", op, flag)
			}
			return nil
		}
		if v == "-" {
			if stdinUsed {
				return fmt.Errorf("only one prose flag may read stdin")
			}
			stdinUsed = true
			var err error
			if v, err = readProse(stdin); err != nil {
				return err
			}
		}
		if len(v) > MaxProseBytes {
			return fmt.Errorf("--%s exceeds %d bytes", flag, MaxProseBytes)
		}
		if strings.IndexByte(v, 0) >= 0 {
			return fmt.Errorf("--%s contains a NUL byte", flag)
		}
		if strings.TrimSpace(v) == "" {
			return fmt.Errorf("--%s must not be empty", flag)
		}
		out.args[wire] = v
		return nil
	}
	// putDate resolves a DATE flag; allowNone lets "none" send JSON null.
	putDate := func(flag, wire string, allowNone bool) error {
		v, ok := flags.take(flag)
		if !ok {
			return nil
		}
		if allowNone && strings.EqualFold(strings.TrimSpace(v), "none") {
			out.args[wire] = nil
			return nil
		}
		d, err := parseAttnDate(v, attnNow())
		if err != nil {
			return fmt.Errorf("--%s: %v", flag, err)
		}
		out.args[wire] = d
		return nil
	}
	takeAskID := func() error {
		raw, err := takePositional("ask id")
		if err != nil {
			return err
		}
		n, err := strconv.Atoi(strings.TrimPrefix(raw, "#"))
		if err != nil || n <= 0 {
			return fmt.Errorf("ask id must be a positive integer (got %q)", raw)
		}
		out.args["id"] = n
		return nil
	}
	steps := func(fns ...func() error) error {
		for _, fn := range fns {
			if err := fn(); err != nil {
				return err
			}
		}
		return nil
	}

	switch op {
	case "project.list":
		if flags.takeBool("hidden") {
			out.args["hidden"] = true
		}
	case "project.get":
		slug, err := takePositional("project slug")
		if err != nil {
			return out, err
		}
		out.args["slug"] = slug
	case "project.add", "project.set":
		slug, err := takePositional("project slug")
		if err != nil {
			return out, err
		}
		out.args["slug"] = slug
		if err := steps(
			func() error { return putShort("label", "label", 200, false) },
			func() error { return putEnum("default-policy", "default_policy", attnPolicies, false) },
			func() error { return putShort("repo", "repo", 4096, false) },
		); err != nil {
			return out, err
		}
	case "card.list":
		if err := steps(
			func() error { return putShort("project", "project", 64, false) },
			func() error { return putEnum("lane", "lane", attnLanes, false) },
			func() error { return putEnum("owner", "owner", attnOwners, false) },
			func() error { return putEnum("edge", "edge", attnEdges, false) },
			func() error { return putShort("q", "q", 200, false) },
		); err != nil {
			return out, err
		}
		if _, hasProject := out.args["project"]; !hasProject {
			if _, hasLane := out.args["lane"]; !hasLane {
				return out, fmt.Errorf("card list needs a scope: pass --project SLUG and/or --lane <%s>", strings.Join(attnLanes, "|"))
			}
		}
	case "card.get", "card.unblock":
		id, err := takePositional("card id")
		if err != nil {
			return out, err
		}
		out.args["id"] = id
	case "card.add":
		if err := steps(
			func() error { return putShort("project", "project", 64, true) },
			func() error { return putProse("title", "title", true) },
			func() error { return putEnum("lane", "lane", attnLanes, false) },
			func() error { return putProse("summary", "summary", false) },
			func() error { return putEnum("owner", "owner", attnOwners, false) },
			func() error { return putEnum("policy", "policy", attnPolicies, false) },
		); err != nil {
			return out, err
		}
	case "card.set":
		id, err := takePositional("card id")
		if err != nil {
			return out, err
		}
		out.args["id"] = id
		if err := steps(
			func() error { return putProse("title", "title", false) },
			func() error { return putProse("summary", "summary", false) },
			func() error { return putEnum("owner", "owner", attnOwners, false) },
			func() error { return putDate("due", "due", true) },
			func() error { return putDate("maybe-on", "maybe_on", true) },
		); err != nil {
			return out, err
		}
		if v, ok := flags.take("policy"); ok {
			switch {
			case v == "default":
				out.args["policy"] = nil // clears to the project default
			case inSet(attnPolicies, v):
				out.args["policy"] = v
			default:
				return out, fmt.Errorf("--policy must be one of %s, or default", strings.Join(attnPolicies, ", "))
			}
		}
		if len(out.args) == 1 {
			return out, fmt.Errorf("card set requires at least one of --title, --summary, --owner, --policy, --due, --maybe-on")
		}
	case "card.move":
		id, err := takePositional("card id")
		if err != nil {
			return out, err
		}
		out.args["id"] = id
		if len(positional) == 0 || !inSet(attnLanes, positional[0]) {
			return out, fmt.Errorf("card move requires a lane <%s>", strings.Join(attnLanes, "|"))
		}
		out.args["lane"] = positional[0]
		positional = positional[1:]
		if v, ok := flags.take("hold-until"); ok {
			if out.args["lane"] != "settling" {
				return out, fmt.Errorf("--hold-until only applies to settling")
			}
			t, err := parseHoldUntil(v, time.Now())
			if err != nil {
				return out, err
			}
			out.args["hold_until"] = t.UTC().Format(time.RFC3339)
		}
	case "card.block":
		id, err := takePositional("card id")
		if err != nil {
			return out, err
		}
		out.args["id"] = id
		if err := putShort("reason", "reason", 300, true); err != nil {
			return out, err
		}
	case "card.done":
		id, err := takePositional("card id")
		if err != nil {
			return out, err
		}
		out.args["id"] = id
		out.args["done"] = !flags.takeBool("undo")
	case "note.add":
		card, err := takePositional("card id")
		if err != nil {
			return out, err
		}
		out.args["card"] = card
		if err := steps(
			func() error { return putProse("text", "text", true) },
			func() error { return putProse("detail", "detail", false) },
		); err != nil {
			return out, err
		}
	case "evidence.add":
		card, err := takePositional("card id")
		if err != nil {
			return out, err
		}
		out.args["card"] = card
		if err := steps(
			func() error { return putEnum("kind", "kind", attnKinds, true) },
			func() error { return putProse("title", "title", true) },
			func() error { return putShort("ref", "ref", 4096, false) },
		); err != nil {
			return out, err
		}
		if v, ok := flags.take("meta"); ok {
			if len(v) > 2048 {
				return out, fmt.Errorf("--meta exceeds 2048 bytes")
			}
			var meta map[string]any
			if err := json.Unmarshal([]byte(v), &meta); err != nil || meta == nil {
				return out, fmt.Errorf("--meta must be a JSON object")
			}
			out.args["meta"] = meta
		}
	case "agent.start":
		card, err := takePositional("card id")
		if err != nil {
			return out, err
		}
		out.args["card"] = card
		if err := steps(
			func() error { return putShort("name", "name", 256, true) },
			func() error { return putShort("model", "model", 256, false) },
			func() error { return putShort("host", "host", 128, false) },
			func() error { return putShort("harness", "harness", 32, false) },
		); err != nil {
			return out, err
		}
	case "agent.set":
		card, err := takePositional("card id")
		if err != nil {
			return out, err
		}
		out.args["card"] = card
		if err := steps(
			func() error { return putShort("name", "name", 256, true) },
			func() error { return putEnum("state", "state", attnStates, true) },
			func() error { return putShort("question", "question", 4096, false) },
		); err != nil {
			return out, err
		}
	case "jot.add":
		if err := steps(
			func() error { return putProse("title", "title", true) },
			func() error { return putEnum("owner", "owner", attnOwners, false) },
			func() error { return putDate("due", "due", false) },
		); err != nil {
			return out, err
		}
	case "jot.list", "ask.list":
		if flags.takeBool("all") {
			out.args["all"] = true
		}
	case "ask.add":
		if !flags.takeBool("json-in") {
			return out, fmt.Errorf("ask add requires --json-in (the ask JSON object is read from stdin)")
		}
		body, err := readProse(stdin)
		if err != nil {
			return out, err
		}
		dec := json.NewDecoder(strings.NewReader(body))
		dec.UseNumber()
		var obj map[string]any
		if err := dec.Decode(&obj); err != nil || obj == nil {
			return out, fmt.Errorf("ask add: stdin must be a JSON object")
		}
		if dec.More() {
			return out, fmt.Errorf("ask add: unexpected data after the JSON object")
		}
		out.args = obj
		if flags.takeBool("stage") {
			out.args["stage"] = true
		}
	case "ask.resolve":
		if err := takeAskID(); err != nil {
			return out, err
		}
		choice, err := takePositional("choice (an action key or not-now)")
		if err != nil {
			return out, err
		}
		out.args["choice"] = choice
	case "ask.drop", "ask.surface", "ask.talk":
		if err := takeAskID(); err != nil {
			return out, err
		}
	case "jot.clear-done", "ask.more", "status":
	}
	if len(positional) != 0 {
		return out, fmt.Errorf("%s has unexpected arguments", op)
	}
	if err := flags.finish(); err != nil {
		return out, err
	}
	return out, nil
}

// Rendering. Every list is clipped to maxAttnRows; the raw event log is
// never printed (it is --json only).

type attnCard struct {
	ID              string  `json:"id"`
	Project         string  `json:"project"`
	Lane            string  `json:"lane"`
	Title           string  `json:"title"`
	Owner           *string `json:"owner"`
	HoldUntil       *string `json:"hold_until"`
	Policy          *string `json:"policy"`
	EffectivePolicy string  `json:"effective_policy"`
	Diverges        bool    `json:"diverges"`
	Blocked         *string `json:"blocked"`
	Edge            *string `json:"edge"`
	Done            bool    `json:"done"`
	Due             *string `json:"due"`
	MaybeOn         *string `json:"maybe_on"`
	Stale           bool    `json:"stale"`
	Fading          bool    `json:"fading"`
	AgeS            float64 `json:"age_s"`
	MovedS          float64 `json:"moved_s"`
	Agents          struct {
		Running int `json:"running"`
		Blocked int `json:"blocked"`
	} `json:"agents"`
	Summary  *string           `json:"summary"`
	Notes    json.RawMessage   `json:"notes"`
	Evidence json.RawMessage   `json:"evidence"`
	Timeline []json.RawMessage `json:"timeline"`
	EventCnt int               `json:"event_count"`
}

type attnNote struct {
	At     string  `json:"at"`
	By     string  `json:"by"`
	Text   string  `json:"text"`
	Detail *string `json:"detail"`
}
type attnEvidence struct {
	At    string  `json:"at"`
	Kind  string  `json:"kind"`
	Title string  `json:"title"`
	Ref   *string `json:"ref"`
}
type attnProject struct {
	Slug          string         `json:"slug"`
	Label         string         `json:"label"`
	DefaultPolicy string         `json:"default_policy"`
	Repo          *string        `json:"repo"`
	Counts        map[string]int `json:"counts"`
}

// attnList accepts either a bare array or {items|cards: [...], total, truncated}.
// parseHoldUntil reads a settling hold: RFC3339, a local HH:MM (next
// occurrence), or a duration from now (Go durations plus whole days, "2d").
func parseHoldUntil(v string, now time.Time) (time.Time, error) {
	bad := fmt.Errorf("--hold-until must be RFC3339, HH:MM, or a duration like 90m, 36h, 2d")
	if strings.HasSuffix(v, "d") {
		n, err := strconv.Atoi(strings.TrimSuffix(v, "d"))
		if err != nil || n <= 0 || n > 60 {
			return time.Time{}, bad
		}
		return now.Add(time.Duration(n) * 24 * time.Hour), nil
	}
	if d, err := time.ParseDuration(v); err == nil {
		if d <= 0 {
			return time.Time{}, bad
		}
		return now.Add(d), nil
	}
	t, err := parseAt(v, now)
	if err != nil {
		return time.Time{}, bad
	}
	if !t.After(now) {
		return time.Time{}, fmt.Errorf("--hold-until must be in the future")
	}
	return t, nil
}

// scheduleHoldWake schedules the wake that keeps a settling hold honest: at the
// hold time Kes either archives the card or hands it to Kevin. It targets the
// root of this lineage, since a fork that sets a hold won't be around to keep it.
func scheduleHoldWake(getenv func(string) string, result json.RawMessage, hold string) error {
	var card struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	if err := json.Unmarshal(result, &card); err != nil || card.ID == "" {
		return fmt.Errorf("unreadable card in result")
	}
	due, err := time.Parse(time.RFC3339, hold)
	if err != nil {
		return err
	}
	short := card.ID
	if len(short) > 8 {
		short = short[:8]
	}
	title := card.Title
	if r := []rune(title); len(r) > 80 {
		title = string(r[:80]) + "…"
	}
	reason := fmt.Sprintf("Settling hold is up on card %s %q. If it's done, archive it (imp attn card move %s archived). Otherwise hand it to Kev (imp attn card set %s --owner kevin), or extend the hold if there's a real reason. If the hold was already extended or released, ignore this.", short, title, short, short)
	args := map[string]any{
		"due_at":  due.UnixMilli(),
		"summary": reason,
		"body":    "<system-reminder>Scheduled event: " + reason + "</system-reminder>",
		"source":  "imp.attn",
	}
	if origin := getenv("FAMILIAR_INSTANCE_ID"); origin != "" {
		args["origin"] = origin
	}
	if root := rootInstance(getenv); root != "" {
		args["target"] = "instance:" + root
	}
	path := getenv("FAMILIAR_SERVICES_SOCKET")
	if path == "" {
		path = "/run/familiar-services/familiar.sock"
	}
	_, remote, err := serviceCall(path, serviceRequest{"schedule.enqueue", args})
	if err != nil {
		return err
	}
	if remote != nil {
		return fmt.Errorf("%s: %s", safeErrorCode(remote.Code), remote.Message)
	}
	return nil
}

func attnList(raw json.RawMessage) (items []json.RawMessage, total int, truncated bool, err error) {
	if err = json.Unmarshal(raw, &items); err == nil {
		return items, len(items), false, nil
	}
	var wrapper struct {
		Items     []json.RawMessage `json:"items"`
		Cards     []json.RawMessage `json:"cards"`
		Total     *int              `json:"total"`
		Truncated bool              `json:"truncated"`
	}
	if e := json.Unmarshal(raw, &wrapper); e != nil {
		return nil, 0, false, err
	}
	items = wrapper.Items
	if items == nil {
		items = wrapper.Cards
	}
	if items == nil {
		return nil, 0, false, fmt.Errorf("result is not a list")
	}
	total = len(items)
	if wrapper.Total != nil && *wrapper.Total > total {
		total = *wrapper.Total
	}
	return items, total, wrapper.Truncated || total > len(items), nil
}

func attnAge(seconds float64) string {
	s := int64(seconds)
	switch {
	case s < 60:
		return "<1m"
	case s < 3600:
		return fmt.Sprintf("%dm", s/60)
	case s < 86400:
		return fmt.Sprintf("%dh", s/3600)
	default:
		return fmt.Sprintf("%dd", s/86400)
	}
}

func attnRow(c attnCard) string {
	prefix := c.ID
	if len(prefix) > 8 {
		prefix = prefix[:8]
	}
	owner := "-"
	if c.Owner != nil {
		owner = *c.Owner
	}
	if c.HoldUntil != nil {
		owner += " (held)"
	}
	fields := []string{prefix, c.Lane, owner}
	if c.Diverges && c.Policy != nil {
		fields = append(fields, *c.Policy)
	}
	if c.Blocked != nil || c.Agents.Blocked > 0 {
		fields = append(fields, "!blocked")
	}
	if c.Due != nil && *c.Due != "" {
		fields = append(fields, "due "+attnDueLabel(*c.Due, attnNow()))
	} else if (c.MaybeOn != nil && *c.MaybeOn != "") || c.Project == "_today" {
		fields = append(fields, "maybe")
	}
	fields = append(fields, attnAge(c.AgeS), strings.ReplaceAll(c.Title, "\n", " "))
	return strings.Join(fields, "  ")
}

func writeAttnCards(w io.Writer, raw json.RawMessage, empty string) error {
	items, total, truncated, err := attnList(raw)
	if err != nil {
		return err
	}
	if len(items) == 0 {
		_, err := io.WriteString(w, empty+"\n")
		return err
	}
	shown := 0
	for _, item := range items {
		if shown == maxAttnRows {
			break
		}
		var c attnCard
		if err := json.Unmarshal(item, &c); err != nil {
			return err
		}
		fmt.Fprintln(w, attnRow(c))
		shown++
	}
	if truncated || total > shown {
		fmt.Fprintf(w, "… and %d more\n", total-shown)
	}
	return nil
}

func writeAttnCard(w io.Writer, raw json.RawMessage) error {
	var c attnCard
	if err := json.Unmarshal(raw, &c); err != nil {
		return err
	}
	if c.ID == "" {
		return fmt.Errorf("result is not a card")
	}
	owner := "-"
	if c.Owner != nil {
		owner = *c.Owner
	}
	policy := c.EffectivePolicy
	if !c.Diverges {
		policy += " (default)"
	}
	fmt.Fprintln(w, strings.ReplaceAll(c.Title, "\n", " "))
	if c.HoldUntil != nil {
		owner += " (held until " + *c.HoldUntil + ")"
	}
	fmt.Fprintf(w, "project: %s  lane: %s  owner: %s  policy: %s\n", c.Project, c.Lane, owner, policy)
	line := fmt.Sprintf("id: %s  captured %s ago  moved %s ago", c.ID, attnAge(c.AgeS), attnAge(c.MovedS))
	if c.Blocked != nil {
		line += "  blocked: " + strings.ReplaceAll(*c.Blocked, "\n", " ")
	}
	if c.Agents.Running > 0 || c.Agents.Blocked > 0 {
		line += fmt.Sprintf("  agents: %d running, %d blocked", c.Agents.Running, c.Agents.Blocked)
	}
	fmt.Fprintln(w, line)
	if c.Summary != nil && strings.TrimSpace(*c.Summary) != "" {
		fmt.Fprintln(w, "Summary:")
		for _, l := range strings.Split(*c.Summary, "\n") {
			fmt.Fprintln(w, "  "+l)
		}
	}
	if len(c.Evidence) > 0 {
		var evidence []attnEvidence
		if err := json.Unmarshal(c.Evidence, &evidence); err != nil {
			return err
		}
		if len(evidence) > 0 {
			fmt.Fprintln(w, "Evidence:")
			for i, e := range evidence {
				if i == maxAttnRows {
					fmt.Fprintf(w, "  … and %d more\n", len(evidence)-i)
					break
				}
				line := "  " + e.Kind + "  " + e.Title
				if e.Ref != nil && *e.Ref != "" {
					line += "  " + *e.Ref
				}
				fmt.Fprintln(w, line)
			}
		}
	}
	if len(c.Timeline) > 0 {
		fmt.Fprintln(w, "Timeline:")
		for i, entry := range c.Timeline {
			if i == maxAttnRows {
				fmt.Fprintf(w, "  … and %d more\n", len(c.Timeline)-i)
				break
			}
			fmt.Fprintln(w, "  "+attnTimelineLine(entry))
		}
		if c.EventCnt > len(c.Timeline) {
			fmt.Fprintf(w, "  (%d events in full history; use --json)\n", c.EventCnt)
		}
	}
	if len(c.Notes) > 0 {
		var notes []attnNote
		if err := json.Unmarshal(c.Notes, &notes); err != nil {
			return err
		}
		if len(notes) > 0 {
			fmt.Fprintln(w, "Notes:")
			for i, n := range notes {
				if i == maxAttnRows {
					fmt.Fprintf(w, "  … and %d more\n", len(notes)-i)
					break
				}
				fmt.Fprintf(w, "  %s %s: %s\n", n.At, n.By, n.Text)
				if n.Detail != nil && strings.TrimSpace(*n.Detail) != "" {
					for _, l := range strings.Split(*n.Detail, "\n") {
						fmt.Fprintln(w, "    "+l)
					}
				}
			}
		}
	}
	return nil
}

// attnTimelineLine renders one prose-ready timeline entry (string or object)
// without echoing arbitrary event data.
func attnTimelineLine(entry json.RawMessage) string {
	var s string
	if json.Unmarshal(entry, &s) == nil {
		return s
	}
	var obj struct {
		At    string `json:"at"`
		Actor string `json:"actor"`
		Kind  string `json:"kind"`
		Text  string `json:"text"`
	}
	if json.Unmarshal(entry, &obj) != nil {
		return "(unreadable event)"
	}
	text := obj.Text
	if text == "" {
		text = obj.Kind
	}
	parts := []string{}
	if obj.At != "" {
		parts = append(parts, obj.At)
	}
	if obj.Actor != "" {
		parts = append(parts, obj.Actor)
	}
	parts = append(parts, strings.ReplaceAll(text, "\n", " "))
	return strings.Join(parts, "  ")
}

func attnProjectLine(p attnProject) string {
	keys := []string{"captured", "clarified", "inflight", "review", "settling"}
	counts := make([]string, 0, len(keys))
	for _, k := range keys {
		counts = append(counts, fmt.Sprintf("%s=%d", k, p.Counts[k]))
	}
	line := fmt.Sprintf("%s  %s  %s  %s", p.Slug, strings.ReplaceAll(p.Label, "\n", " "), p.DefaultPolicy, strings.Join(counts, " "))
	if p.Repo != nil && *p.Repo != "" {
		line += "  " + *p.Repo
	}
	return line
}

type attnAsk struct {
	ID   int `json:"id"`
	Card struct {
		ID      string `json:"id"`
		Project string `json:"project"`
	} `json:"card"`
	Question   string  `json:"question"`
	State      string  `json:"state"`
	Resolution *string `json:"resolution"`
	Actions    []struct {
		Key string `json:"key"`
	} `json:"actions"`
}

func attnAskLine(a attnAsk) string {
	project := a.Card.Project
	if project == "" {
		project = a.Card.ID
		if len(project) > 8 {
			project = project[:8]
		}
	}
	keys := make([]string, 0, len(a.Actions))
	for _, act := range a.Actions {
		keys = append(keys, act.Key)
	}
	line := fmt.Sprintf("#%d [%s] %s · %s", a.ID, a.State, project, strings.Join(strings.Fields(a.Question), " "))
	if len(keys) > 0 {
		line += " — " + strings.Join(keys, "|")
	}
	return line
}

// writeAttnAsks renders ask.list grouped surfaced, staged, then resolved
// (--all), clipped to maxAttnRows overall.
func writeAttnAsks(w io.Writer, raw json.RawMessage) error {
	var r struct {
		Surfaced []attnAsk `json:"surfaced"`
		Staged   []attnAsk `json:"staged"`
		Resolved []attnAsk `json:"resolved"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return err
	}
	total := len(r.Surfaced) + len(r.Staged) + len(r.Resolved)
	if total == 0 {
		_, err := io.WriteString(w, "No asks.\n")
		return err
	}
	shown := 0
	for _, group := range [][]attnAsk{r.Surfaced, r.Staged, r.Resolved} {
		for _, a := range group {
			if shown == maxAttnRows {
				break
			}
			fmt.Fprintln(w, attnAskLine(a))
			shown++
		}
	}
	if total > shown {
		fmt.Fprintf(w, "… and %d more\n", total-shown)
	}
	return nil
}

func writeAttnHuman(w io.Writer, operation string, raw json.RawMessage) error {
	switch operation {
	case "project.list":
		items, total, truncated, err := attnList(raw)
		if err != nil {
			return err
		}
		if len(items) == 0 {
			_, err := io.WriteString(w, "No projects.\n")
			return err
		}
		shown := 0
		for _, item := range items {
			if shown == maxAttnRows {
				break
			}
			var p attnProject
			if err := json.Unmarshal(item, &p); err != nil {
				return err
			}
			fmt.Fprintln(w, attnProjectLine(p))
			shown++
		}
		if truncated || total > shown {
			fmt.Fprintf(w, "… and %d more\n", total-shown)
		}
		return nil
	case "project.get", "project.add", "project.set":
		var p attnProject
		if err := json.Unmarshal(raw, &p); err != nil {
			return err
		}
		fmt.Fprintln(w, attnProjectLine(p))
		return nil
	case "card.list":
		return writeAttnCards(w, raw, "No cards.")
	case "jot.list":
		return writeAttnCards(w, raw, "No jots.")
	case "jot.clear-done":
		var r struct {
			Archived int `json:"archived"`
		}
		if err := json.Unmarshal(raw, &r); err != nil {
			return err
		}
		fmt.Fprintf(w, "archived %d\n", r.Archived)
		return nil
	case "ask.add", "ask.surface", "ask.drop", "ask.talk":
		var a attnAsk
		if err := json.Unmarshal(raw, &a); err != nil || a.ID == 0 {
			return fmt.Errorf("result is not an ask")
		}
		switch operation {
		case "ask.add":
			fmt.Fprintf(w, "asked #%d [%s]\n", a.ID, a.State)
		case "ask.surface":
			fmt.Fprintf(w, "surfaced #%d\n", a.ID)
		case "ask.drop":
			fmt.Fprintf(w, "dropped #%d\n", a.ID)
		default:
			fmt.Fprintf(w, "noted conversation about #%d\n", a.ID)
		}
		return nil
	case "ask.resolve":
		var r struct {
			Resolved attnAsk `json:"resolved"`
		}
		if err := json.Unmarshal(raw, &r); err != nil || r.Resolved.ID == 0 {
			return fmt.Errorf("result is not a resolved ask")
		}
		res := ""
		if r.Resolved.Resolution != nil {
			res = " (" + *r.Resolved.Resolution + ")"
		}
		fmt.Fprintf(w, "resolved #%d%s\n", r.Resolved.ID, res)
		return nil
	case "ask.more":
		var r struct {
			Surfaced   int `json:"surfaced"`
			StagedLeft int `json:"staged_left"`
		}
		if err := json.Unmarshal(raw, &r); err != nil {
			return err
		}
		fmt.Fprintf(w, "surfaced %d more; %d staged left\n", r.Surfaced, r.StagedLeft)
		return nil
	case "ask.list":
		return writeAttnAsks(w, raw)
	case "status":
		var s struct {
			Agents struct {
				Running int `json:"running"`
				Blocked int `json:"blocked"`
			} `json:"agents"`
			NeedsAttention int `json:"needs_attention"`
			Inflight       int `json:"inflight"`
			Asks           *struct {
				Surfaced int `json:"surfaced"`
				Staged   int `json:"staged"`
			} `json:"asks"`
			Jots struct {
				Open  int `json:"open"`
				Stale int `json:"stale"`
			} `json:"jots"`
		}
		if err := json.Unmarshal(raw, &s); err != nil {
			return err
		}
		if s.Asks != nil {
			fmt.Fprintf(w, "agents: %d running, %d blocked  asks: %d surfaced, %d staged  jots: %d open, %d stale\n",
				s.Agents.Running, s.Agents.Blocked, s.Asks.Surfaced, s.Asks.Staged, s.Jots.Open, s.Jots.Stale)
			return nil
		}
		fmt.Fprintf(w, "agents: %d running, %d blocked  needs attention: %d  in flight: %d  jots: %d open, %d stale\n",
			s.Agents.Running, s.Agents.Blocked, s.NeedsAttention, s.Inflight, s.Jots.Open, s.Jots.Stale)
		return nil
	default:
		return writeAttnCard(w, raw)
	}
}

const attnHelp = `Usage: imp attn <noun> <command> [options]

Kevin's attention: jots for today, cards on per-project boards, and a
glance at what is running.

Nouns:
  project   Boards: list, get, add, set
  card      Cards on a board: list, get, add, set, move, block, unblock, done
  note      Append a note to a card (authored as Kes)
  evidence  Attach evidence (pr, commit, shot, run, link) to a card
  agent     Record an agent starting on, or changing state on, a card
  jot       Today's jots: add, list, clear-done (due dates; Maybe today)
  ask       Asks: bounded decisions for Kev about one card (max 3 surfaced)
  status    One-line glance: agents, asks (surfaced/staged), jots

Run 'imp attn <noun> --help' to discover commands.
All commands accept --json. Prose flags (--title, --summary, --text, --detail)
accept a lone '-' to read stdin (up to 64 KiB).
DATE flags (--due, --maybe-on) take YYYY-MM-DD, today, tomorrow, or a weekday
name (mon, tue, ... next occurrence; today counts), in America/Chicago.
`

var attnUsage = map[string]string{
	"project.list":   "Usage: imp attn project list [--hidden] [--json]\n",
	"project.get":    "Usage: imp attn project get SLUG [--json]\n",
	"project.add":    "Usage: imp attn project add SLUG [--label TEXT] [--default-policy POLICY] [--repo PATH_OR_URL] [--json]\n",
	"project.set":    "Usage: imp attn project set SLUG [--label TEXT] [--default-policy POLICY] [--repo PATH_OR_URL] [--json]\n",
	"card.list":      "Usage: imp attn card list (--project SLUG | --lane LANE) [--owner kevin|kes] [--edge blocked|review|live] [--q TEXT] [--json]\n\nAt least one of --project or --lane is required. Prints at most 64 rows:\n  id-prefix  lane  owner  [policy if diverges]  [!blocked]  age  title\n",
	"card.get":       "Usage: imp attn card get ID [--json]\n\nPrints title, project/lane/owner/policy, summary, evidence, the short timeline, and notes.\nThe raw event log is available only with --json.\n",
	"card.add":       "Usage: imp attn card add --project SLUG (--title TEXT | --title -) [--lane LANE] [--summary TEXT|-] [--owner kevin|kes] [--policy POLICY] [--json]\n",
	"card.set":       "Usage: imp attn card set ID [--title TEXT|-] [--summary TEXT|-] [--owner kevin|kes] [--policy POLICY|default] [--due DATE|none] [--maybe-on DATE|none] [--json]\n\n--policy default clears the card's policy back to the project default.\n--due and --maybe-on apply to jots (_today) only; DATE is YYYY-MM-DD, today, tomorrow, or a\nweekday (next occurrence; today counts) in America/Chicago. 'none' clears the date.\nSetting --due promotes a Maybe-today jot to Today.\n",
	"card.move":      "Usage: imp attn card move ID <captured|icebox|clarified|inflight|review|settling|archived> [--hold-until TIME] [--json]\n\nSettling means \"Kev, this is probably done; close it when you're satisfied\", so a card\nmoved to settling becomes Kevin's. To keep it in settling yourself, pass --hold-until TIME\n(RFC3339, HH:MM, or a duration like 90m, 36h, 2d): the card stays yours until then and a\nwake is scheduled for that time to archive it or hand it to Kevin.\n",
	"card.block":     "Usage: imp attn card block ID --reason TEXT [--json]\n",
	"card.unblock":   "Usage: imp attn card unblock ID [--json]\n",
	"card.done":      "Usage: imp attn card done ID [--undo] [--json]\n\nJots (_today) only. --undo marks the jot not done.\n",
	"note.add":       "Usage: imp attn note add CARD_ID (--text TEXT | --text -) [--detail TEXT|-] [--json]\n\nThe resident records this note as authored by Kes.\n",
	"evidence.add":   "Usage: imp attn evidence add CARD_ID --kind <pr|commit|shot|run|link> (--title TEXT | --title -) [--ref URL_SHA_OR_PATH] [--meta JSON_OBJECT] [--json]\n",
	"agent.start":    "Usage: imp attn agent start CARD_ID --name NAME [--model MODEL] [--host HOST] [--harness HARNESS] [--json]\n",
	"agent.set":      "Usage: imp attn agent set CARD_ID --name NAME --state <running|blocked|done|failed|cancelled> [--question TEXT] [--json]\n",
	"jot.add":        "Usage: imp attn jot add (--title TEXT | --title -) [--owner kevin|kes] [--due DATE] [--json]\n\nWith --due the jot is a Today task; without it, a Maybe-today intention.\nDATE: YYYY-MM-DD, today, tomorrow, or a weekday (next occurrence; today counts), America/Chicago.\n",
	"jot.list":       "Usage: imp attn jot list [--all] [--json]\n\nDefault view: jots due today or earlier, plus today's maybes. --all lists every non-archived jot.\nRows show 'due Fri' / 'due today' or 'maybe' before the age.\n",
	"ask.add":        "Usage: imp attn ask add --json-in [--stage] [--json]\n\nReads the ask JSON object from stdin (up to 64 KiB) and forwards it as-is:\n  {\"card\":\"6c5e0e39\",\"question\":\"Close M4?\",\"steps\":\"...\",\"link\":\"...\",\"link_label\":\"...\",\n   \"actions\":[{\"key\":\"close\",\"label\":\"Close it\",\"primary\":true,\"ops\":[...]}]}\n--stage keeps the ask invisible until Kev asks for more. At most 3 asks are surfaced.\n",
	"ask.list":       "Usage: imp attn ask list [--all] [--json]\n\nPrints surfaced, then staged (then resolved with --all):\n  #7 [surfaced] project · question — key1|key2\n",
	"ask.resolve":    "Usage: imp attn ask resolve ID CHOICE [--json]\n\nCHOICE is an action key or not-now.\n",
	"ask.more":       "Usage: imp attn ask more [--json]\n\nSurfaces staged asks until 3 are surfaced.\n",
	"ask.drop":       "Usage: imp attn ask drop ID [--json]\n\nWithdraws an ask.\n",
	"ask.surface":    "Usage: imp attn ask surface ID [--json]\n\nSurfaces a staged ask if fewer than 3 are surfaced.\n",
	"ask.talk":       "Usage: imp attn ask talk ID [--json]\n\nRecords that Kev opened a conversation about the ask; does not resolve it.\n",
	"jot.clear-done": "Usage: imp attn jot clear-done [--json]\n",
	"status":         "Usage: imp attn status [--json]\n",
}
