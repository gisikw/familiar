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
	"path/filepath"
	"strconv"
	"strings"
	"time"
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
	if origin := getenv("FAMILIAR_INSTANCE_ID"); origin != "" {
		inv.args["origin"] = origin
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

func parseScheduler(argv []string, now time.Time) (schedulerInvocation, bool, error) {
	if len(argv) == 0 || isHelp(argv[0]) {
		return schedulerInvocation{op: "help"}, false, nil
	}
	cmd := argv[0]
	args := argv[1:]
	if len(args) == 1 && isHelp(args[0]) {
		return schedulerInvocation{op: "help"}, false, nil
	}
	jsonMode, soft := false, false
	vals := map[string]string{}
	pos := []string{}
	value := map[string]bool{"in": true, "at": true, "target": true, "id": true, "priority": true, "type": true, "source": true, "body": true}
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
				return schedulerInvocation{}, false, errors.New("usage: imp schedule list")
			}
			return schedulerInvocation{"schedule.list", originArgs()}, jsonMode, nil
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
		in, at := vals["in"], vals["at"]
		if (in == "") == (at == "") {
			return schedulerInvocation{}, false, errors.New("schedule requires exactly one of --in or --at")
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
		} else {
			due, err = parseAt(at, now)
		}
		if err != nil {
			return schedulerInvocation{}, false, fmt.Errorf("invalid time: %v", err)
		}
		m := originArgs()
		m["due_at"] = due.UnixMilli()
		m["summary"] = pos[0]
		m["body"] = "<system-reminder>Scheduled event: " + pos[0] + "</system-reminder>"
		m["source"] = "imp.schedule"
		if soft {
			m["urgency"] = "soft"
		}
		if x := vals["id"]; x != "" {
			m["id"] = x
		}
		return schedulerInvocation{"schedule.enqueue", m}, jsonMode, nil
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
	case "schedule.enqueue":
		var x struct {
			Event struct {
				ID    string `json:"id"`
				DueAt int64  `json:"due_at"`
			} `json:"event"`
		}
		if json.Unmarshal(result, &x) != nil {
			return ExitProtocol
		}
		fmt.Fprintf(out, "%s  %s\n", x.Event.ID, time.UnixMilli(x.Event.DueAt).Format(time.RFC3339))
	case "schedule.list":
		var xs []struct {
			ID, Summary, State string
			DueAt              int64 `json:"due_at"`
		}
		if json.Unmarshal(result, &xs) != nil {
			return ExitProtocol
		}
		for _, x := range xs {
			fmt.Fprintf(out, "%s  %s  %s  %s\n", x.ID, x.State, time.UnixMilli(x.DueAt).Format(time.RFC3339), x.Summary)
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
  imp schedule list [--json]
  imp schedule cancel ID
  imp notify [--target TARGET] [--id ID] [--soft] "reason"
  imp dnd [on DURATION|off|status]
`
