package cli

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"
)

type serviceRequest struct {
	Op   string         `json:"op"`
	Args map[string]any `json:"args"`
}

func schedulerMain(argv []string, stdout, stderr io.Writer, getenv func(string) string) int {
	inv, jsonMode, err := parseScheduler(argv, time.Now())
	if err != nil {
		return usageError(stderr, "%v", err)
	}
	if inv.op == "help" {
		io.WriteString(stdout, schedulerHelp)
		return 0
	}
	path := getenv("FAMILIAR_SERVICES_SOCKET")
	if path == "" {
		path = "/run/familiar-services/familiar.sock"
	}
	if origin := getenv("FAMILIAR_INSTANCE_ID"); origin != "" && !strings.HasPrefix(inv.op, "push.") {
		inv.args["origin"] = origin
	}
	// A scheduled fork branches from the primary (a fork is ephemeral; its
	// schedule outlives it), so default its target to the root of this lineage.
	if inv.op == "schedule.enqueue" && inv.args["type"] == "fork" && inv.args["target"] == nil {
		if root := rootInstance(getenv); root != "" {
			inv.args["target"] = "instance:" + root
		}
	}
	// A fork's push opens that fork when tapped (the phone falls back to the
	// primary if it has merged). The primary sends none: tapping goes home.
	if inv.op == "push.send" && getenv("FAMILIAR_PI_FORK") == "1" {
		if id := getenv("FAMILIAR_INSTANCE_ID"); id != "" {
			inv.args["session"] = id
		}
	}
	result, remote, err := serviceCall(path, serviceRequest{inv.op, inv.args})
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
	return writeSchedulerHuman(stdout, inv.op, result, stderr)
}

type schedulerInvocation struct {
	op   string
	args map[string]any
}

// rootInstance follows fork.json parent links from this instance to the
// primary it ultimately branched from.
func rootInstance(getenv func(string) string) string {
	id, state := getenv("FAMILIAR_INSTANCE_ID"), getenv("FAMILIAR_STATE_DIR")
	for i := 0; i < 8 && id != "" && state != ""; i++ {
		b, err := os.ReadFile(filepath.Join(state, "forks", filepath.Base(id), "fork.json"))
		if err != nil {
			return id
		}
		var m struct {
			Parent string `json:"parentSessionId"`
		}
		if json.Unmarshal(b, &m) != nil || m.Parent == "" {
			return id
		}
		id = m.Parent
	}
	return id
}

func parseScheduler(argv []string, now time.Time) (schedulerInvocation, bool, error) {
	if len(argv) == 0 || isHelp(argv[0]) {
		return schedulerInvocation{op: "help"}, false, nil
	}
	cmd := argv[0]
	args := argv[1:]
	if len(args) == 1 && isHelp(args[0]) {
		return schedulerInvocation{op: "help"}, false, nil
	}
	jsonMode, soft, fork, all, fresh, runner := false, false, false, false, false, false
	vals := map[string]string{}
	pos := []string{}
	value := map[string]bool{"in": true, "at": true, "every": true, "label": true, "target": true, "id": true, "priority": true, "type": true, "source": true, "body": true, "title": true, "model": true}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--json" {
			jsonMode = true
			continue
		}
		if a == "--soft" {
			soft = true
			continue
		}
		if a == "--fork" {
			fork = true
			continue
		}
		if a == "--all" {
			all = true
			continue
		}
		if a == "--fresh" {
			fresh = true
			continue
		}
		if a == "--runner" {
			runner = true
			continue
		}
		if strings.HasPrefix(a, "--") {
			k := strings.TrimPrefix(a, "--")
			if !value[k] || i+1 >= len(args) {
				return schedulerInvocation{}, false, fmt.Errorf("unknown or incomplete option %s", a)
			}
			i++
			vals[k] = args[i]
		} else {
			pos = append(pos, a)
		}
	}
	originArgs := func() map[string]any {
		m := map[string]any{}
		if x := vals["target"]; x != "" {
			m["target"] = x
		}
		return m
	}
	switch cmd {
	case "schedule":
		if len(pos) > 0 && pos[0] == "list" {
			if len(pos) != 1 {
				return schedulerInvocation{}, false, errors.New("usage: imp schedule list [--all] [--json]")
			}
			m := originArgs()
			if all {
				m["all"] = true
			}
			return schedulerInvocation{"schedule.list", m}, jsonMode, nil
		}
		if len(pos) > 0 && pos[0] == "cancel" {
			if len(pos) != 2 {
				return schedulerInvocation{}, false, errors.New("usage: imp schedule cancel ID")
			}
			return schedulerInvocation{"schedule.cancel", map[string]any{"id": pos[1]}}, jsonMode, nil
		}
		if len(pos) != 1 {
			return schedulerInvocation{}, false, errors.New("schedule requires one quoted reason")
		}
		in, at, every := vals["in"], vals["at"], vals["every"]
		if in != "" && at != "" {
			return schedulerInvocation{}, false, errors.New("schedule takes at most one of --in or --at")
		}
		if in == "" && at == "" && every == "" {
			return schedulerInvocation{}, false, errors.New("schedule requires --in, --at, or --every")
		}
		if (fresh || runner || vals["model"] != "") && !fork {
			return schedulerInvocation{}, false, errors.New("--fresh/--model/--runner shape a scheduled fork; use them with --fork")
		}
		if m := vals["model"]; m != "" {
			if !modelRef.MatchString(m) {
				return schedulerInvocation{}, false, errors.New("--model must be PROVIDER/MODEL")
			}
			// Refuse now, not at 6am: a model that can't carry Kes must be declared a runner.
			if !runner && !carriesKes(m, os.Getenv("FAMILIAR_FORK_MODELS")) {
				return schedulerInvocation{}, false, fmt.Errorf("--model %s is not on the list of models that carry Kes (FAMILIAR_FORK_MODELS); add --runner to schedule it as a marked lighter runner", m)
			}
		}
		if runner && vals["model"] == "" {
			return schedulerInvocation{}, false, errors.New("--runner needs --model")
		}
		if vals["label"] != "" && !fork {
			return schedulerInvocation{}, false, errors.New("--label names a scheduled fork; use it with --fork")
		}
		var due time.Time
		var err error
		if in != "" {
			var d time.Duration
			d, err = time.ParseDuration(in)
			due = now.Add(d)
			if d <= 0 && err == nil {
				err = errors.New("duration must be positive")
			}
		} else if at != "" {
			due, err = parseAt(at, now)
		}
		if err != nil {
			return schedulerInvocation{}, false, fmt.Errorf("invalid time: %v", err)
		}
		m := originArgs()
		if !due.IsZero() {
			m["due_at"] = due.UnixMilli()
		}
		if every != "" {
			m["rule"] = every
		}
		m["summary"] = pos[0]
		m["body"] = "<system-reminder>Scheduled event: " + pos[0] + "</system-reminder>"
		m["source"] = "imp.schedule"
		if fork {
			if soft {
				return schedulerInvocation{}, false, errors.New("--fork and --soft don't combine: a scheduled fork never takes a turn")
			}
			m["type"] = "fork"
			req := map[string]any{"task": pos[0], "label": vals["label"]}
			if fresh {
				req["fresh"] = true
			}
			if m := vals["model"]; m != "" {
				req["model"] = m
			}
			if runner {
				req["runner"] = true
			}
			b, _ := json.Marshal(req)
			m["body"] = string(b)
		}
		if soft {
			m["urgency"] = "soft"
		}
		if x := vals["id"]; x != "" {
			m["id"] = x
		}
		return schedulerInvocation{"schedule.enqueue", m}, jsonMode, nil
	case "push":
		if len(pos) != 1 || soft {
			return schedulerInvocation{}, false, errors.New("push requires one quoted message (and optional --title)")
		}
		m := map[string]any{"body": pos[0]}
		if x := vals["title"]; x != "" {
			m["title"] = x
		}
		return schedulerInvocation{"push.send", m}, jsonMode, nil
	case "notify":
		if len(pos) != 1 {
			return schedulerInvocation{}, false, errors.New("notify requires one quoted reason")
		}
		m := originArgs()
		m["summary"] = pos[0]
		if soft {
			m["urgency"] = "soft"
		}
		for _, k := range []string{"id", "type", "source", "body"} {
			if x := vals[k]; x != "" {
				m[k] = x
			}
		}
		if x := vals["priority"]; x != "" {
			p, e := strconv.Atoi(x)
			if e != nil || p < 0 || p > 3 {
				return schedulerInvocation{}, false, errors.New("priority must be 0..3")
			}
			m["priority"] = p
		}
		return schedulerInvocation{"schedule.enqueue", m}, jsonMode, nil
	case "dnd":
		if len(pos) == 0 || pos[0] == "status" {
			if len(pos) > 1 {
				return schedulerInvocation{}, false, errors.New("usage: imp dnd status")
			}
			return schedulerInvocation{"dnd.get", originArgs()}, jsonMode, nil
		}
		if pos[0] == "off" {
			if len(pos) != 1 {
				return schedulerInvocation{}, false, errors.New("usage: imp dnd off")
			}
			m := originArgs()
			m["enabled"] = false
			m["set_by"] = "familiar"
			return schedulerInvocation{"dnd.set", m}, jsonMode, nil
		}
		if pos[0] == "on" {
			if len(pos) != 2 {
				return schedulerInvocation{}, false, errors.New("usage: imp dnd on DURATION")
			}
			d, e := time.ParseDuration(pos[1])
			if e != nil || d <= 0 {
				return schedulerInvocation{}, false, errors.New("invalid DND duration")
			}
			m := originArgs()
			m["enabled"] = true
			m["set_by"] = "familiar"
			m["duration_ms"] = d.Milliseconds()
			return schedulerInvocation{"dnd.set", m}, jsonMode, nil
		}
	}
	return schedulerInvocation{}, false, fmt.Errorf("unknown command %q", cmd)
}
func parseAt(value string, now time.Time) (time.Time, error) {
	if t, e := time.Parse(time.RFC3339, value); e == nil {
		return t, nil
	}
	t, e := time.ParseInLocation("15:04", value, now.Location())
	if e != nil {
		return time.Time{}, e
	}
	t = time.Date(now.Year(), now.Month(), now.Day(), t.Hour(), t.Minute(), 0, 0, now.Location())
	if !t.After(now) {
		t = t.Add(24 * time.Hour)
	}
	return t, nil
}
func serviceCall(path string, req serviceRequest) (json.RawMessage, *remoteError, error) {
	if !filepath.IsAbs(path) {
		return nil, nil, errors.New("FAMILIAR_SERVICES_SOCKET must be an absolute path")
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), dialTimeout)
	defer cancel()
	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", path)
	if err != nil {
		return nil, nil, fmt.Errorf("connecting to scheduler: %w", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(ioTimeout))
	if _, err = conn.Write(append(payload, '\n')); err != nil {
		return nil, nil, err
	}
	body, err := bufio.NewReader(io.LimitReader(conn, MaxWireBytes+1)).ReadBytes('\n')
	if err != nil {
		return nil, nil, err
	}
	if len(body) > MaxWireBytes {
		return nil, nil, errors.New("scheduler response exceeds wire limit")
	}
	line := bytes.TrimSpace(body)
	var resp response
	if err = json.Unmarshal(line, &resp); err != nil {
		return nil, nil, fmt.Errorf("invalid scheduler response: %w", err)
	}
	if resp.OK == nil {
		return nil, nil, errors.New("scheduler response omits ok")
	}
	if *resp.OK {
		return resp.Result, nil, nil
	}
	if resp.Error == nil {
		return nil, nil, errors.New("scheduler failure omits error")
	}
	return nil, resp.Error, nil
}
func writeSchedulerHuman(out io.Writer, op string, result json.RawMessage, stderr io.Writer) int {
	switch op {
	case "push.send":
		var x struct{ Sent, Failed int }
		if json.Unmarshal(result, &x) != nil {
			return ExitProtocol
		}
		fmt.Fprintf(out, "pushed to %d device(s)", x.Sent)
		if x.Failed > 0 {
			fmt.Fprintf(out, ", %d failed", x.Failed)
		}
		fmt.Fprintln(out)
		return 0
	case "schedule.enqueue":
		var x struct {
			Event schedEvent `json:"event"`
		}
		if json.Unmarshal(result, &x) != nil {
			return ExitProtocol
		}
		fmt.Fprintf(out, "%s  %s", x.Event.ID, time.UnixMilli(x.Event.DueAt).Format(time.RFC3339))
		if x.Event.Rule != "" {
			fmt.Fprintf(out, "  every %s", x.Event.Rule)
		}
		fmt.Fprintln(out)
	case "schedule.list":
		var xs []schedEvent
		if json.Unmarshal(result, &xs) != nil {
			return ExitProtocol
		}
		loc := listZone()
		for _, x := range xs {
			rule := "once"
			if x.Rule != "" {
				rule = "every " + x.Rule
			}
			summary := x.Summary
			if len(summary) > 90 {
				summary = summary[:87] + "..."
			}
			fmt.Fprintf(out, "%-5s %-9s %-16s %-20s %s  %s  %s\n", x.kind(), x.State, time.UnixMilli(x.DueAt).In(loc).Format("Mon Jan 2 15:04"), rule, shortTarget(x.Target), x.ID, summary)
		}
	case "schedule.cancel":
		fmt.Fprintln(out, "cancelled")
	case "dnd.get", "dnd.set":
		if bytes.Equal(bytes.TrimSpace(result), []byte("null")) {
			fmt.Fprintln(out, "off")
		} else {
			var d struct {
				ExpiresAt int64 `json:"expiresAt"`
			}
			if json.Unmarshal(result, &d) != nil {
				return ExitProtocol
			}
			fmt.Fprintf(out, "on until %s\n", time.UnixMilli(d.ExpiresAt).Format(time.RFC3339))
		}
	}
	return 0
}

const schedulerHelp = `Usage:
  imp schedule --in 30m|--at TIME [--target instance:ID|spawn:UNIT] [--soft] "reason"
  imp schedule --every RULE [--at TIME] [--soft] "reason"          (recurring)
  imp schedule --every RULE|--at TIME|--in D --fork [--label L] "task"
                              (spawn a background fork of the primary; no turn)
  imp schedule list [--all] [--json]
  imp schedule cancel ID       (a recurring ID cancels the whole series)
  imp notify [--target TARGET] [--id ID] [--soft] "reason"
  imp dnd [on DURATION|off|status]
  imp push [--title TITLE] "message"   (to Kevin's phone)

RULE: an interval (90m, 2h, 1d) or DAYS HH:MM, where DAYS is day, weekday,
weekend, or a list like mon,wed,fri. Local time (America/Chicago), DST-correct.
A missed occurrence fires once on catch-up; nothing replays.
`

type schedEvent struct {
	ID, Summary, State, Target, Type, Urgency, Rule, Series string
	DueAt                                                   int64 `json:"due_at"`
}

func (e schedEvent) kind() string {
	switch {
	case e.Type == "fork" || e.Type == "merge":
		return e.Type
	case e.Urgency == "soft":
		return "soft"
	}
	return "wake"
}
func shortTarget(t string) string {
	id := strings.TrimPrefix(t, "instance:")
	if id != t && len(id) > 8 {
		return id[:8]
	}
	return t
}
func listZone() *time.Location {
	name := os.Getenv("FAMILIAR_TZ")
	if name == "" {
		name = "America/Chicago"
	}
	if loc, err := time.LoadLocation(name); err == nil {
		return loc
	}
	return time.Local
}
