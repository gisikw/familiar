package cli

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// modelRef is a Pi PROVIDER/MODEL reference, e.g. tiamat-anthropic/claude-sonnet-5.
var modelRef = regexp.MustCompile(`^[A-Za-z0-9._-]{1,80}/[A-Za-z0-9._:-]{1,120}$`)

// carriesKes reports whether model is on the allowlist of models considered
// able to carry Kes: comma-separated PROVIDER/MODEL patterns where "*" matches
// any run of characters. Unset means the Opus family only.
func carriesKes(model, list string) bool {
	if strings.TrimSpace(list) == "" {
		list = "*/claude-opus-*"
	}
	for _, p := range strings.Split(list, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		re := "^" + strings.ReplaceAll(regexp.QuoteMeta(p), `\*`, ".*") + "$"
		if ok, _ := regexp.MatchString(re, model); ok {
			return true
		}
	}
	return false
}

type piRecord struct {
	Type, ID, ParentID, CustomType string
	Data                           json.RawMessage
	Message                        json.RawMessage
}
type forkMarker struct {
	ParentSessionID string `json:"parentSessionId"`
	BranchEntryID   string `json:"branchEntryId"`
}

func branchMain(argv []string, stdout, stderr io.Writer, getenv func(string) string) int {
	if len(argv) == 0 || isHelp(argv[0]) {
		io.WriteString(stdout, branchHelp)
		return 0
	}
	switch argv[0] {
	case "fork":
		return forkMain(argv[1:], stdout, stderr, getenv)
	case "merge":
		return finishBranch(argv[1:], stdout, stderr, getenv)
	case "label":
		return labelMain(argv[1:], stdout, stderr, getenv)
	case "status":
		return statusMain(argv[1:], stdout, stderr, getenv)
	case "forks":
		return forksMain(argv[1:], stdout, stderr, getenv)
	}
	return usageError(stderr, "unknown command %q", argv[0])
}
func oneText(args []string, what string) (string, error) {
	if len(args) != 1 || strings.TrimSpace(args[0]) == "" {
		return "", fmt.Errorf("%s requires one quoted text argument", what)
	}
	if len(args[0]) > MaxProseBytes {
		return "", errors.New("text too long")
	}
	return args[0], nil
}
func envNeed(getenv func(string) string, names ...string) (map[string]string, error) {
	m := map[string]string{}
	for _, n := range names {
		m[n] = getenv(n)
		if m[n] == "" {
			return nil, fmt.Errorf("%s is not set", n)
		}
	}
	return m, nil
}

func forkMain(args []string, out, errw io.Writer, getenv func(string) string) int {
	// --label names the fork at birth (scheduled forks arrive already titled);
	// --origin records who started it (e.g. schedule:<series>).
	// --fresh starts from the system prompt and the task alone, not the
	// parent's conversation; --model PROVIDER/MODEL picks the fork's model
	// (default: the parent's current model).
	var label, origin, model string
	fresh, runner := false, false
	var rest []string
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "--fresh":
			fresh = true
		case args[i] == "--runner":
			runner = true
		case args[i] == "--model" && i+1 < len(args):
			model = strings.TrimSpace(args[i+1])
			i++
		case (args[i] == "--label" || args[i] == "--origin") && i+1 < len(args):
			if args[i] == "--label" {
				label = strings.TrimSpace(args[i+1])
			} else {
				origin = strings.TrimSpace(args[i+1])
			}
			i++
		default:
			rest = append(rest, args[i])
		}
	}
	if len(label) > 120 || len(origin) > 200 || strings.ContainsAny(label+origin, "\x00\n\r") {
		return usageError(errw, "fork --label/--origin must be short single lines")
	}
	if model != "" && !modelRef.MatchString(model) {
		return usageError(errw, "fork --model must be PROVIDER/MODEL")
	}
	// A declared model must be able to carry Kes, or the fork must say plainly
	// that it is a lighter runner (it will not wear her name).
	if model != "" && !runner && !carriesKes(model, getenv("FAMILIAR_FORK_MODELS")) {
		return usageError(errw, "fork --model %s is not on the list of models that carry Kes (FAMILIAR_FORK_MODELS); pass --runner to run it as a marked lighter runner", model)
	}
	if runner && model == "" {
		return usageError(errw, "fork --runner needs --model")
	}
	task, e := oneText(rest, "fork")
	if e != nil {
		return usageError(errw, "%v", e)
	}
	env, e := envNeed(getenv, "FAMILIAR_INSTANCE_ID", "FAMILIAR_SESSION_FILE", "FAMILIAR_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_PACKAGE_DIR", "FAMILIAR_FORK_HELPER")
	if e != nil {
		fmt.Fprintf(errw, "imp: %v\n", e)
		return ExitUnavailable
	}
	leaf, _, _, e := sessionFacts(env["FAMILIAR_SESSION_FILE"])
	if e != nil || leaf == "" {
		fmt.Fprintf(errw, "imp: cannot read parent leaf: %v\n", e)
		return ExitProtocol
	}
	maxDepth := 2
	if raw := getenv("FAMILIAR_FORK_MAX_DEPTH"); raw != "" {
		parsed, parseErr := strconv.Atoi(raw)
		if parseErr != nil || parsed < 1 {
			return usageError(errw, "FAMILIAR_FORK_MAX_DEPTH must be a positive integer")
		}
		maxDepth = parsed
	}
	if depth := forkDepth(env["FAMILIAR_SESSION_FILE"]); depth >= maxDepth {
		fmt.Fprintf(errw, "imp: fork depth %d reached the configured maximum %d; finish or merge a branch first\n", depth, maxDepth)
		return ExitUsage
	}
	forks := filepath.Join(env["FAMILIAR_STATE_DIR"], "forks")
	if e = os.MkdirAll(forks, 0700); e != nil {
		return branchError(errw, e)
	}
	tmp, e := os.MkdirTemp(forks, "creating-")
	if e != nil {
		return branchError(errw, e)
	}
	defer func() {
		if tmp != "" {
			os.RemoveAll(tmp)
		}
	}()
	sessionDir := filepath.Join(tmp, "sessions")
	os.MkdirAll(sessionDir, 0700)
	cmd := exec.Command(nodeBin(getenv), env["FAMILIAR_FORK_HELPER"], env["PI_PACKAGE_DIR"], env["FAMILIAR_SESSION_FILE"], leaf, sessionDir, env["FAMILIAR_INSTANCE_ID"], map[bool]string{true: "fresh", false: "branch"}[fresh], model, mustCwd(), map[bool]string{true: "runner", false: "kes"}[runner])
	raw, e := cmd.CombinedOutput()
	if e != nil {
		fmt.Fprintf(errw, "imp: fork helper: %v: %s\n", e, raw)
		return ExitProtocol
	}
	var made struct{ ID, File, MarkerEntryID, Model string }
	if json.Unmarshal(bytes.TrimSpace(raw), &made) != nil || made.ID == "" || filepath.Base(made.ID) != made.ID || strings.ContainsAny(made.ID, "\\/\x00\n\r") {
		return branchError(errw, errors.New("invalid fork helper result"))
	}
	final := filepath.Join(forks, made.ID)
	if e = os.Rename(tmp, final); e != nil {
		return branchError(errw, e)
	}
	tmp = ""
	made.File = filepath.Join(final, "sessions", filepath.Base(made.File))
	piDir := filepath.Join(final, "pi")
	os.MkdirAll(piDir, 0700)
	for _, name := range []string{"auth.json", "models.json", "models-store.json", "settings.json", "keybindings.json"} {
		copyRegular(filepath.Join(env["PI_CODING_AGENT_DIR"], name), filepath.Join(piDir, name))
	}
	// Auto-discovered extensions (e.g. familiar-ui) must load in forks too; share
	// the resident's directory rather than copying so /reload semantics match.
	if i, e := os.Stat(filepath.Join(env["PI_CODING_AGENT_DIR"], "extensions")); e == nil && i.IsDir() {
		_ = os.Symlink(filepath.Join(env["PI_CODING_AGENT_DIR"], "extensions"), filepath.Join(piDir, "extensions"))
	}
	meta := map[string]any{"id": made.ID, "parentSessionId": env["FAMILIAR_INSTANCE_ID"], "branchEntryId": leaf, "sessionFile": made.File, "task": task, "cwd": mustCwd(), "createdAt": time.Now().UTC().Format(time.RFC3339Nano)}
	if label != "" {
		meta["label"] = label
	}
	if origin != "" {
		meta["origin"] = origin
	}
	if fresh {
		meta["fresh"] = true
	}
	if runner {
		meta["role"] = "runner"
	}
	if made.Model != "" {
		meta["model"] = made.Model
	}
	b, _ := json.Marshal(meta)
	if e = os.WriteFile(filepath.Join(final, "fork.json"), append(b, '\n'), 0600); e != nil {
		return branchError(errw, e)
	}
	unit := "familiar-pi@" + made.ID + ".service"
	c := exec.Command("sudo", "systemctl", "start", "--no-block", unit)
	if x := getenv("FAMILIAR_SYSTEMCTL"); x != "" {
		c = exec.Command(x, "start", "--no-block", unit)
	}
	if raw, e = c.CombinedOutput(); e != nil {
		fmt.Fprintf(errw, "imp: starting fork: %v: %s\n", e, raw)
		return ExitRemote
	}
	fmt.Fprintln(out, made.ID)
	return 0
}
func copyRegular(src, dst string) {
	i, e := os.Lstat(src)
	if e != nil || !i.Mode().IsRegular() {
		return
	}
	b, e := os.ReadFile(src)
	if e == nil {
		_ = os.WriteFile(dst, b, 0600)
	}
}
func mustCwd() string                      { p, _ := os.Getwd(); return p }
func branchError(w io.Writer, e error) int { fmt.Fprintf(w, "imp: %v\n", e); return ExitProtocol }

func finishBranch(args []string, out, errw io.Writer, getenv func(string) string) int {
	quiet := len(args) > 0 && args[0] == "--quiet"
	if quiet {
		args = args[1:]
	}
	if len(args) != 0 {
		return usageError(errw, "imp merge no longer takes a summary; run `imp merge [--quiet]`, then write your return when prompted")
	}
	env, e := envNeed(getenv, "FAMILIAR_SESSION_FILE", "FAMILIAR_IMP_SOCKET")
	if e != nil {
		fmt.Fprintf(errw, "imp: %v\n", e)
		return ExitUnavailable
	}
	if _, e = findForkMarker(env["FAMILIAR_SESSION_FILE"]); e != nil {
		fmt.Fprintln(errw, "imp: you're the top level; there's nothing to merge into")
		return ExitUsage
	}
	_, remote, e := call(env["FAMILIAR_IMP_SOCKET"], Request{Version: 1, Area: "branch", Operation: "merge", Args: map[string]any{"quiet": quiet}})
	if e != nil {
		return branchError(errw, e)
	}
	if remote != nil {
		return branchError(errw, errors.New(remote.Message))
	}
	fmt.Fprintln(out, "merge queued; when this turn settles you'll be asked for your return")
	return 0
}
func sessionFacts(path string) (leaf, first string, turns int, err error) {
	f, e := os.Open(path)
	if e != nil {
		return "", "", 0, e
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	s.Buffer(make([]byte, 4096), MaxWireBytes*16)
	var branch string
	for s.Scan() {
		var r piRecord
		if json.Unmarshal(s.Bytes(), &r) != nil || r.ID == "" {
			continue
		}
		leaf = r.ID
		if r.CustomType == "familiar.fork.v1" {
			branch = r.ID
			first = r.ID
			turns = 0
			continue
		}
		if branch != "" {
			if first == "" {
				first = r.ID
			}
			if r.Type == "message" {
				turns++
			}
		}
	}
	return leaf, first, turns, s.Err()
}
func findForkMarker(path string) (forkMarker, error) {
	f, e := os.Open(path)
	if e != nil {
		return forkMarker{}, e
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	s.Buffer(make([]byte, 4096), MaxWireBytes*16)
	var latest forkMarker
	for s.Scan() {
		var r piRecord
		if json.Unmarshal(s.Bytes(), &r) == nil && r.CustomType == "familiar.fork.v1" {
			var m forkMarker
			if json.Unmarshal(r.Data, &m) == nil && m.ParentSessionID != "" && m.BranchEntryID != "" {
				latest = m
			}
		}
	}
	if latest.ParentSessionID != "" {
		return latest, nil
	}
	return forkMarker{}, errors.New("familiar.fork.v1 marker missing")
}
func forkDepth(path string) int {
	f, e := os.Open(path)
	if e != nil {
		return 0
	}
	defer f.Close()
	n := 0
	s := bufio.NewScanner(f)
	for s.Scan() {
		var r piRecord
		if json.Unmarshal(s.Bytes(), &r) == nil && r.CustomType == "familiar.fork.v1" {
			n++
		}
	}
	return n
}
func forksMain(args []string, out, errw io.Writer, getenv func(string) string) int {
	if len(args) != 0 {
		return usageError(errw, "usage: imp forks")
	}
	state := getenv("FAMILIAR_STATE_DIR")
	if state == "" {
		return branchError(errw, errors.New("FAMILIAR_STATE_DIR is not set"))
	}
	dirs, _ := filepath.Glob(filepath.Join(state, "forks", "*"))
	for _, d := range dirs {
		b, e := os.ReadFile(filepath.Join(d, "fork.json"))
		if e != nil {
			continue
		}
		var m struct{ ID, Task, Label string }
		if json.Unmarshal(b, &m) != nil || m.ID == "" {
			continue
		}
		active := "inactive"
		cmdName, args := systemctlCommand(getenv, "is-active", "familiar-pi@"+m.ID+".service")
		if exec.Command(cmdName, args...).Run() == nil {
			active = "active"
		}
		name := m.Task
		if m.Label != "" {
			name = m.Label
		}
		fmt.Fprintf(out, "%s  %s  %s\n", m.ID, active, name)
	}
	return 0
}
func systemctlCommand(g func(string) string, args ...string) (string, []string) {
	if x := g("FAMILIAR_SYSTEMCTL"); x != "" {
		return x, args
	}
	return "systemctl", args
}

const branchHelp = `Usage:
  imp fork "task text"
  imp merge [--quiet]
  imp label "short name" [--status "doing what"]   (forks: your name in the Open list)
  imp status ["what you're doing now" | --clear]   (forks: one-line status under your name)
  imp forks
`

// nodeBin prefers the resident Pi's own Node (exported by the imp extension as
// FAMILIAR_NODE): resident unit PATHs do not carry node.
func nodeBin(getenv func(string) string) string {
	if n := getenv("FAMILIAR_NODE"); n != "" {
		return n
	}
	return "node"
}

// labelMain lets a fork name itself for the operator's Open list. The label is
// a display name only: the task stays in fork.json unchanged for the record.
// `--status TEXT` sets the status line in the same write.
func labelMain(args []string, out, errw io.Writer, getenv func(string) string) int {
	var status *string
	if len(args) == 3 && args[1] == "--status" {
		s := args[2]
		status, args = &s, args[:1]
	}
	text, e := oneText(args, "label")
	if e != nil {
		return usageError(errw, "%v", e)
	}
	text = clip(text, MaxLabelRunes)
	return updateForkMeta(out, errw, getenv, "labels name forks", func(meta map[string]any) string {
		meta["label"] = text
		msg := "labeled: " + text
		if status != nil {
			msg += setStatus(meta, *status)
		}
		return msg
	})
}

// statusMain sets, prints, or clears the fork's one-line status: what she is
// doing now, beneath her stable label. Words for what, never for state.
func statusMain(args []string, out, errw io.Writer, getenv func(string) string) int {
	switch {
	case len(args) == 0:
		return updateForkMeta(out, errw, getenv, "status lines are for forks", func(meta map[string]any) string {
			s, _ := meta["status"].(string)
			return s
		})
	case len(args) == 1 && args[0] == "--clear":
		return updateForkMeta(out, errw, getenv, "status lines are for forks", func(meta map[string]any) string {
			delete(meta, "status")
			delete(meta, "statusAt")
			return "status cleared"
		})
	}
	text, e := oneText(args, "status")
	if e != nil {
		return usageError(errw, "%v", e)
	}
	return updateForkMeta(out, errw, getenv, "status lines are for forks", func(meta map[string]any) string {
		return strings.TrimPrefix(setStatus(meta, text), " · ")
	})
}

func clip(text string, max int) string {
	text = strings.Join(strings.Fields(text), " ")
	if n := []rune(text); len(n) > max {
		text = string(n[:max])
	}
	return text
}

func setStatus(meta map[string]any, text string) string {
	text = clip(text, MaxStatusRunes)
	if text == "" {
		delete(meta, "status")
		delete(meta, "statusAt")
		return " · status cleared"
	}
	meta["status"] = text
	meta["statusAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	return " · status: " + text
}

// updateForkMeta applies edit to this fork's fork.json with an atomic 0600
// write and prints edit's message. Read-only edits return without writing only
// if they do not change the map; for simplicity every call rewrites.
func updateForkMeta(out, errw io.Writer, getenv func(string) string, primaryMsg string, edit func(map[string]any) string) int {
	if getenv("FAMILIAR_PI_FORK") != "1" {
		fmt.Fprintf(errw, "imp: %s; you're the top level\n", primaryMsg)
		return ExitUsage
	}
	env, e := envNeed(getenv, "FAMILIAR_STATE_DIR", "FAMILIAR_INSTANCE_ID")
	if e != nil {
		fmt.Fprintf(errw, "imp: %v\n", e)
		return ExitUnavailable
	}
	id := env["FAMILIAR_INSTANCE_ID"]
	if filepath.Base(id) != id || strings.ContainsAny(id, "\\/\x00\n\r") {
		return branchError(errw, errors.New("invalid instance id"))
	}
	dir := filepath.Join(env["FAMILIAR_STATE_DIR"], "forks", id)
	path := filepath.Join(dir, "fork.json")
	b, e := os.ReadFile(path)
	if e != nil {
		return branchError(errw, e)
	}
	meta := map[string]any{}
	if e = json.Unmarshal(b, &meta); e != nil {
		return branchError(errw, e)
	}
	msg := edit(meta)
	b, _ = json.Marshal(meta)
	tmp, e := os.CreateTemp(dir, ".fork.json.*")
	if e != nil {
		return branchError(errw, e)
	}
	_, e = tmp.Write(append(b, '\n'))
	if c := tmp.Close(); e == nil {
		e = c
	}
	if e == nil {
		e = os.Chmod(tmp.Name(), 0600)
	}
	if e == nil {
		e = os.Rename(tmp.Name(), path)
	}
	if e != nil {
		os.Remove(tmp.Name())
		return branchError(errw, e)
	}
	if msg != "" {
		fmt.Fprintln(out, msg)
	}
	return 0
}

const MaxStatusRunes = 80
const MaxLabelRunes = 60
