package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

const agentHelp = `Usage:
  imp agent start --node NODE [--kind pi|claude] [--runtime REF] [--cwd DIR] [--name NAME] "task"
  imp agent list [--all] [--closed] [--json]
  imp agent read NAME [--lines N]
  imp agent prompt NAME "text"
  imp agent keys NAME KEY...
  imp agent close NAME

Agents run in Herdr on enrolled machines; node "local" is this host. When
one settles, blocks, or exits you are woken with its state and last output.
If you are a fork that has merged by then, whoever you merged into is woken.
Answer a blocked agent with prompt (or keys, for a menu); close it when done.
`

// agentMain drives fleet.* operations on familiar-services. Starting an agent
// waits for Herdr to confirm it is running, so these calls get a long deadline.
func agentMain(argv []string, stdout, stderr io.Writer, getenv func(string) string) int {
	if len(argv) == 0 || isHelp(argv[0]) {
		io.WriteString(stdout, agentHelp)
		return 0
	}
	op, args, jsonMode, err := parseAgent(argv)
	if err != nil {
		return usageError(stderr, "%v", err)
	}
	if origin := getenv("FAMILIAR_INSTANCE_ID"); origin != "" && args["origin"] == nil && !(op == "fleet.list" && args["all"] == true) {
		args["origin"] = origin
	}
	path := getenv("FAMILIAR_SERVICES_SOCKET")
	if path == "" {
		path = "/run/familiar-services/familiar.sock"
	}
	result, remote, err := serviceCallTimeout(path, serviceRequest{op, args}, 3*time.Minute)
	if err != nil {
		fmt.Fprintf(stderr, "imp: %v\n", err)
		return ExitProtocol
	}
	if remote != nil {
		fmt.Fprintf(stderr, "imp: %s: %s\n", safeErrorCode(remote.Code), remote.Message)
		if remote.Code == "unavailable" {
			return ExitUnavailable
		}
		return ExitRemote
	}
	if jsonMode {
		stdout.Write(result)
		io.WriteString(stdout, "\n")
		return 0
	}
	return writeAgentHuman(stdout, stderr, op, result)
}

func parseAgent(argv []string) (string, map[string]any, bool, error) {
	sub, rest := argv[0], argv[1:]
	args := map[string]any{}
	jsonMode := false
	var pos []string
	valued := map[string]string{"--node": "node", "--kind": "kind", "--runtime": "runtime", "--cwd": "cwd", "--name": "name", "--lines": "lines"}
	for i := 0; i < len(rest); i++ {
		a := rest[i]
		switch {
		case a == "--json":
			jsonMode = true
		case a == "--all" || a == "--closed":
			args[strings.TrimPrefix(a, "--")] = true
		case valued[a] != "":
			if i+1 >= len(rest) {
				return "", nil, false, fmt.Errorf("%s needs a value", a)
			}
			args[valued[a]] = rest[i+1]
			i++
		case sub != "keys" && strings.HasPrefix(a, "--"):
			return "", nil, false, fmt.Errorf("unknown option %s", a)
		default:
			pos = append(pos, a)
		}
	}
	need := func(n int, usage string) error {
		if len(pos) != n {
			return fmt.Errorf("usage: imp agent %s", usage)
		}
		return nil
	}
	switch sub {
	case "start":
		if err := need(1, `start --node NODE [--kind pi|claude] [--runtime REF] [--cwd DIR] [--name NAME] "task"`); err != nil {
			return "", nil, false, err
		}
		args["task"] = pos[0]
		return "fleet.start", args, jsonMode, nil
	case "list":
		if err := need(0, "list [--all] [--closed] [--json]"); err != nil {
			return "", nil, false, err
		}
		return "fleet.list", args, jsonMode, nil
	case "read":
		if err := need(1, "read NAME [--lines N]"); err != nil {
			return "", nil, false, err
		}
		args["name"] = pos[0]
		if v, ok := args["lines"].(string); ok {
			n, err := strconv.Atoi(v)
			if err != nil || n <= 0 {
				return "", nil, false, fmt.Errorf("--lines must be a positive number")
			}
			args["lines"] = n
		}
		return "fleet.read", args, jsonMode, nil
	case "prompt":
		if err := need(2, `prompt NAME "text"`); err != nil {
			return "", nil, false, err
		}
		args["name"], args["text"] = pos[0], pos[1]
		return "fleet.prompt", args, jsonMode, nil
	case "keys":
		if len(pos) < 2 {
			return "", nil, false, fmt.Errorf("usage: imp agent keys NAME KEY...")
		}
		keys := make([]any, 0, len(pos)-1)
		for _, k := range pos[1:] {
			keys = append(keys, k)
		}
		args["name"], args["keys"] = pos[0], keys
		return "fleet.keys", args, jsonMode, nil
	case "close":
		if err := need(1, "close NAME"); err != nil {
			return "", nil, false, err
		}
		args["name"] = pos[0]
		return "fleet.close", args, jsonMode, nil
	}
	return "", nil, false, fmt.Errorf("unknown agent command %q (start, list, read, prompt, keys, close)", sub)
}

type fleetAgent struct {
	Name, Node, Kind, Runtime, State, Task string
	CreatedAt                              int64 `json:"created_at"`
	ClosedAt                               int64 `json:"closed_at"`
}

func writeAgentHuman(out, stderr io.Writer, op string, result json.RawMessage) int {
	switch op {
	case "fleet.start":
		var a fleetAgent
		if json.Unmarshal(result, &a) != nil {
			break
		}
		fmt.Fprintf(out, "started %s on %s (%s, runtime %s); you'll be woken when it settles or blocks\n", a.Name, a.Node, a.Kind, a.Runtime)
		return 0
	case "fleet.list":
		var list []fleetAgent
		if json.Unmarshal(result, &list) != nil {
			break
		}
		if len(list) == 0 {
			fmt.Fprintln(out, "no agents")
			return 0
		}
		for _, a := range list {
			task := strings.SplitN(a.Task, "\n", 2)[0]
			if len(task) > 60 {
				task = task[:60] + "…"
			}
			state := a.State
			if a.ClosedAt != 0 {
				state = "closed"
			}
			age := time.Since(time.UnixMilli(a.CreatedAt)).Round(time.Minute)
			fmt.Fprintf(out, "%-12s %-10s %-6s %-8s %6s  %s\n", a.Name, a.Node, a.Kind, state, age, task)
		}
		return 0
	case "fleet.read":
		var r struct{ Text string }
		if json.Unmarshal(result, &r) != nil {
			break
		}
		io.WriteString(out, strings.TrimRight(r.Text, "\n")+"\n")
		return 0
	case "fleet.prompt", "fleet.keys":
		fmt.Fprintln(out, "sent")
		return 0
	case "fleet.close":
		fmt.Fprintln(out, "closed")
		return 0
	}
	fmt.Fprintln(stderr, "imp: invalid fleet response")
	return ExitProtocol
}
