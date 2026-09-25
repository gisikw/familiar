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
	"strconv"
	"strings"
	"time"
)

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
	task, e := oneText(args, "fork")
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
	cmd := exec.Command(nodeBin(getenv), env["FAMILIAR_FORK_HELPER"], env["PI_PACKAGE_DIR"], env["FAMILIAR_SESSION_FILE"], leaf, sessionDir, env["FAMILIAR_INSTANCE_ID"])
	raw, e := cmd.CombinedOutput()
	if e != nil {
		fmt.Fprintf(errw, "imp: fork helper: %v: %s\n", e, raw)
		return ExitProtocol
	}
	var made struct{ ID, File, MarkerEntryID string }
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
	meta := map[string]any{"id": made.ID, "parentSessionId": env["FAMILIAR_INSTANCE_ID"], "branchEntryId": leaf, "sessionFile": made.File, "task": task, "cwd": mustCwd(), "createdAt": time.Now().UTC().Format(time.RFC3339Nano)}
	b, _ := json.Marshal(meta)
	if e = os.WriteFile(filepath.Join(final, "fork.json"), append(b, '\n'), 0600); e != nil {
		return branchError(errw, e)
	}
	unit := "familiar-pi@" + made.ID + ".service"
	c := exec.Command("sudo", "systemctl", "start", unit)
	if x := getenv("FAMILIAR_SYSTEMCTL"); x != "" {
		c = exec.Command(x, "start", unit)
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
	text, e := oneText(args, "merge")
	if e != nil {
		return usageError(errw, "%v", e)
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
	_, remote, e := call(env["FAMILIAR_IMP_SOCKET"], Request{Version: 1, Area: "branch", Operation: "merge", Args: map[string]any{"text": text, "quiet": quiet}})
	if e != nil {
		return branchError(errw, e)
	}
	if remote != nil {
		return branchError(errw, errors.New(remote.Message))
	}
	fmt.Fprintln(out, "merge queued; it will be sent when this turn settles")
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
		var m struct{ ID, Task string }
		if json.Unmarshal(b, &m) != nil || m.ID == "" {
			continue
		}
		active := "inactive"
		cmdName, args := systemctlCommand(getenv, "is-active", "familiar-pi@"+m.ID+".service")
		if exec.Command(cmdName, args...).Run() == nil {
			active = "active"
		}
		fmt.Fprintf(out, "%s  %s  %s\n", m.ID, active, m.Task)
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
  imp merge [--quiet] "summary"
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
