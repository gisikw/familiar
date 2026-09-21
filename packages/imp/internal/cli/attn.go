package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
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
}
var attnBoolFlags = map[string]bool{"hidden": true, "undo": true}

// attnVerbs enumerates the exact noun/verb table; the wire operation is noun.verb.
var attnVerbs = map[string][]string{
	"project":  {"list", "get", "add", "set"},
	"card":     {"list", "get", "add", "set", "move", "block", "unblock", "done"},
	"note":     {"add"},
	"evidence": {"add"},
	"agent":    {"start", "set"},
	"jot":      {"add", "list", "clear-done"},
}
var attnNouns = []string{"project", "card", "note", "evidence", "agent", "jot", "status"}

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
			return out, fmt.Errorf("card set requires at least one of --title, --summary, --owner, --policy")
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
		); err != nil {
			return out, err
		}
	case "jot.list", "jot.clear-done", "status":
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
	Policy          *string `json:"policy"`
	EffectivePolicy string  `json:"effective_policy"`
	Diverges        bool    `json:"diverges"`
	Blocked         *string `json:"blocked"`
	Edge            *string `json:"edge"`
	Done            bool    `json:"done"`
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
	fields := []string{prefix, c.Lane, owner}
	if c.Diverges && c.Policy != nil {
		fields = append(fields, *c.Policy)
	}
	if c.Blocked != nil || c.Agents.Blocked > 0 {
		fields = append(fields, "!blocked")
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
	case "status":
		var s struct {
			Agents struct {
				Running int `json:"running"`
				Blocked int `json:"blocked"`
			} `json:"agents"`
			NeedsAttention int `json:"needs_attention"`
			Inflight       int `json:"inflight"`
			Jots           struct {
				Open  int `json:"open"`
				Stale int `json:"stale"`
			} `json:"jots"`
		}
		if err := json.Unmarshal(raw, &s); err != nil {
			return err
		}
		fmt.Fprintf(w, "agents: %d running, %d blocked  needs attention: %d  in flight: %d  jots: %d open, %d stale\n",
			s.Agents.Running, s.Agents.Blocked, s.NeedsAttention, s.Inflight, s.Jots.Open, s.Jots.Stale)
		return nil
	default:
		return writeAttnCard(w, raw)
	}
}

const attnHelp = `Usage: imp attn <noun> <command> [options]

What is on Kevin's plate: jots for today, cards on per-project boards, and a
glance at what is running.

Nouns:
  project   Boards: list, get, add, set
  card      Cards on a board: list, get, add, set, move, block, unblock, done
  note      Append a note to a card (authored as Kes)
  evidence  Attach evidence (pr, commit, shot, run, link) to a card
  agent     Record an agent starting on, or changing state on, a card
  jot       Today's jots: add, list, clear-done
  status    One-line glance: agents, needs attention, in flight, jots

Run 'imp attn <noun> --help' to discover commands.
All commands accept --json. Prose flags (--title, --summary, --text, --detail)
accept a lone '-' to read stdin (up to 64 KiB).
`

var attnUsage = map[string]string{
	"project.list":   "Usage: imp attn project list [--hidden] [--json]\n",
	"project.get":    "Usage: imp attn project get SLUG [--json]\n",
	"project.add":    "Usage: imp attn project add SLUG [--label TEXT] [--default-policy POLICY] [--repo PATH_OR_URL] [--json]\n",
	"project.set":    "Usage: imp attn project set SLUG [--label TEXT] [--default-policy POLICY] [--repo PATH_OR_URL] [--json]\n",
	"card.list":      "Usage: imp attn card list (--project SLUG | --lane LANE) [--owner kevin|kes] [--edge blocked|review|live] [--q TEXT] [--json]\n\nAt least one of --project or --lane is required. Prints at most 64 rows:\n  id-prefix  lane  owner  [policy if diverges]  [!blocked]  age  title\n",
	"card.get":       "Usage: imp attn card get ID [--json]\n\nPrints title, project/lane/owner/policy, summary, evidence, the short timeline, and notes.\nThe raw event log is available only with --json.\n",
	"card.add":       "Usage: imp attn card add --project SLUG (--title TEXT | --title -) [--lane LANE] [--summary TEXT|-] [--owner kevin|kes] [--policy POLICY] [--json]\n",
	"card.set":       "Usage: imp attn card set ID [--title TEXT|-] [--summary TEXT|-] [--owner kevin|kes] [--policy POLICY|default] [--json]\n\n--policy default clears the card's policy back to the project default.\n",
	"card.move":      "Usage: imp attn card move ID <captured|icebox|clarified|inflight|review|settling|archived> [--json]\n",
	"card.block":     "Usage: imp attn card block ID --reason TEXT [--json]\n",
	"card.unblock":   "Usage: imp attn card unblock ID [--json]\n",
	"card.done":      "Usage: imp attn card done ID [--undo] [--json]\n\nJots (_today) only. --undo marks the jot not done.\n",
	"note.add":       "Usage: imp attn note add CARD_ID (--text TEXT | --text -) [--detail TEXT|-] [--json]\n\nThe resident records this note as authored by Kes.\n",
	"evidence.add":   "Usage: imp attn evidence add CARD_ID --kind <pr|commit|shot|run|link> (--title TEXT | --title -) [--ref URL_SHA_OR_PATH] [--meta JSON_OBJECT] [--json]\n",
	"agent.start":    "Usage: imp attn agent start CARD_ID --name NAME [--model MODEL] [--host HOST] [--harness HARNESS] [--json]\n",
	"agent.set":      "Usage: imp attn agent set CARD_ID --name NAME --state <running|blocked|done|failed|cancelled> [--question TEXT] [--json]\n",
	"jot.add":        "Usage: imp attn jot add (--title TEXT | --title -) [--owner kevin|kes] [--json]\n",
	"jot.list":       "Usage: imp attn jot list [--json]\n",
	"jot.clear-done": "Usage: imp attn jot clear-done [--json]\n",
	"status":         "Usage: imp attn status [--json]\n",
}
