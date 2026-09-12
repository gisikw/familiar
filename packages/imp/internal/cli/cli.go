package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	WireVersion     = 1
	MaxWireBytes    = 1 << 20
	MaxProseBytes   = 64 << 10
	ExitUsage       = 2
	ExitUnavailable = 3
	ExitRemote      = 4
	ExitProtocol    = 5
)

var (
	dialTimeout = 2 * time.Second
	ioTimeout   = 5 * time.Second
)

type Request struct {
	Version   int            `json:"version"`
	Area      string         `json:"area"`
	Operation string         `json:"operation"`
	Args      map[string]any `json:"args"`
}

type response struct {
	OK     *bool           `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  *remoteError    `json:"error"`
}

type remoteError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type invocation struct {
	operation string
	args      map[string]any
	json      bool
}

func Main(args []string, stdin io.Reader, stdout, stderr io.Writer, getenv func(string) string) int {
	if len(args) == 0 || isHelp(args[0]) {
		io.WriteString(stdout, rootHelp)
		return 0
	}
	area := args[0]
	if area != "plate" && area != "agent" {
		return usageError(stderr, "unknown area %q; try 'imp --help'", area)
	}
	if len(args) == 1 || isHelp(args[1]) {
		if area == "plate" {
			io.WriteString(stdout, plateHelp)
		} else {
			io.WriteString(stdout, agentHelp)
		}
		return 0
	}
	if len(args) > 2 && isHelp(args[2]) {
		helpMap := commandHelp
		if area == "agent" {
			helpMap = agentCommandHelp
		}
		if help, ok := helpMap[args[1]]; ok {
			io.WriteString(stdout, help)
			return 0
		}
		return usageError(stderr, "unknown %s command %q; try 'imp %s --help'", area, args[1], area)
	}

	var inv invocation
	var err error
	if area == "plate" {
		inv, err = parsePlate(args[1:], stdin)
	} else {
		inv, err = parseAgent(args[1:], stdin)
	}
	if err != nil {
		return usageError(stderr, "%v", err)
	}
	path := getenv("FAMILIAR_IMP_SOCKET")
	if path == "" {
		fmt.Fprintln(stderr, "imp: FAMILIAR_IMP_SOCKET is not set; this command is available only inside an owning Familiar resident")
		return ExitUnavailable
	}
	result, remote, err := call(path, Request{Version: WireVersion, Area: area, Operation: inv.operation, Args: inv.args})
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
	if inv.json {
		stdout.Write(result)
		io.WriteString(stdout, "\n")
		return 0
	}
	if area == "agent" {
		err = writeAgentHuman(stdout, inv.operation, result)
	} else {
		err = writeHuman(stdout, inv.operation, result)
	}
	if err != nil {
		fmt.Fprintf(stderr, "imp: invalid result: %v\n", err)
		return ExitProtocol
	}
	return 0
}

func usageError(w io.Writer, format string, args ...any) int {
	fmt.Fprintf(w, "imp: "+format+"\n", args...)
	return ExitUsage
}

func isHelp(s string) bool { return s == "--help" || s == "-h" || s == "help" }

func parsePlate(argv []string, stdin io.Reader) (invocation, error) {
	cmd := argv[0]
	args := argv[1:]
	if _, ok := commandHelp[cmd]; !ok {
		return invocation{}, fmt.Errorf("unknown Plate command %q; try 'imp plate --help'", cmd)
	}
	flags, positional, jsonMode, err := parseFlags(args)
	if err != nil {
		return invocation{}, err
	}
	out := invocation{operation: cmd, args: map[string]any{}, json: jsonMode}

	idCommand := cmd != "list" && cmd != "add"
	if idCommand {
		if len(positional) == 0 {
			return out, fmt.Errorf("%s requires an item id", cmd)
		}
		if positional[0] == "-" {
			return out, fmt.Errorf("%s requires an item id before '-'", cmd)
		}
		if len(positional[0]) > 256 {
			return out, fmt.Errorf("item id is too long")
		}
		out.args["id"] = positional[0]
		positional = positional[1:]
	}

	switch cmd {
	case "list":
		if len(positional) != 0 {
			return out, fmt.Errorf("list takes no arguments")
		}
		out.args["archived"] = flags.takeBool("archived")
	case "get", "clear-label", "clear-accent", "close", "restore":
		if len(positional) != 0 {
			return out, fmt.Errorf("%s takes only an item id", cmd)
		}
	case "add":
		text, rest, err := prose(flags, positional, "summary", stdin)
		if err != nil {
			return out, fmt.Errorf("add: %w", err)
		}
		if len(rest) != 0 {
			return out, fmt.Errorf("add has unexpected arguments")
		}
		out.args["summary"] = text
		if v, ok := flags.take("label"); ok {
			out.args["label"] = v
		}
		if v, ok := flags.take("assign"); ok {
			b, err := assignee(v)
			if err != nil {
				return out, err
			}
			out.args["assignedToKes"] = b
		}
		if v, ok := flags.take("accent"); ok {
			if err := validAccent(v); err != nil {
				return out, err
			}
			out.args["accent"] = v
		}
	case "update-summary":
		text, rest, err := prose(flags, positional, "summary", stdin)
		if err != nil {
			return out, fmt.Errorf("update-summary: %w", err)
		}
		if len(rest) != 0 {
			return out, fmt.Errorf("update-summary has unexpected arguments")
		}
		out.args["summary"] = text
	case "set-label":
		text, rest, err := prose(flags, positional, "label", stdin)
		if err != nil {
			return out, fmt.Errorf("set-label: %w", err)
		}
		if len(rest) != 0 {
			return out, fmt.Errorf("set-label has unexpected arguments")
		}
		out.args["label"] = text
	case "append-note":
		text, rest, err := prose(flags, positional, "note", stdin)
		if err != nil {
			return out, fmt.Errorf("append-note: %w", err)
		}
		if len(rest) != 0 {
			return out, fmt.Errorf("append-note has unexpected arguments")
		}
		out.args["text"] = text // Authorship is intentionally omitted; the resident attributes Imp notes to Kes.
	case "assign":
		if len(positional) != 1 {
			return out, fmt.Errorf("assign requires exactly one of: kes, kevin")
		}
		b, err := assignee(positional[0])
		if err != nil {
			return out, err
		}
		out.args["assignedToKes"] = b
	case "set-accent":
		if len(positional) != 1 {
			return out, fmt.Errorf("set-accent requires exactly one of: attention, caution")
		}
		if err := validAccent(positional[0]); err != nil {
			return out, err
		}
		out.args["accent"] = positional[0]
	}
	if err := flags.finish(); err != nil {
		return out, err
	}
	return out, nil
}

func parseAgent(argv []string, stdin io.Reader) (invocation, error) {
	cmd := argv[0]
	if _, ok := agentCommandHelp[cmd]; !ok {
		return invocation{}, fmt.Errorf("unknown Agent command %q; try 'imp agent --help'", cmd)
	}
	flags, positional, jsonMode, err := parseFlags(argv[1:])
	if err != nil {
		return invocation{}, err
	}
	out := invocation{operation: cmd, args: map[string]any{}, json: jsonMode}
	takeRequired := func(name string, max int) (string, error) {
		value, ok := flags.take(name)
		if !ok || strings.TrimSpace(value) == "" {
			return "", fmt.Errorf("%s requires --%s VALUE", cmd, name)
		}
		if len(value) > max || strings.IndexByte(value, 0) >= 0 {
			return "", fmt.Errorf("--%s is invalid or too long", name)
		}
		return value, nil
	}
	takeID := func() (string, error) {
		if len(positional) == 0 || positional[0] == "-" {
			return "", fmt.Errorf("%s requires a job id", cmd)
		}
		id := positional[0]
		positional = positional[1:]
		if len(id) > 256 || strings.IndexByte(id, 0) >= 0 {
			return "", fmt.Errorf("job id is invalid or too long")
		}
		return id, nil
	}
	putFlag := func(flag, wire string, max int, required bool) error {
		value, ok := flags.take(flag)
		if !ok {
			if required {
				return fmt.Errorf("%s requires --%s VALUE", cmd, flag)
			}
			return nil
		}
		if strings.TrimSpace(value) == "" || len(value) > max || strings.IndexByte(value, 0) >= 0 {
			return fmt.Errorf("--%s is invalid or too long", flag)
		}
		out.args[wire] = value
		return nil
	}
	putProse := func(flag, wire string, max int) error {
		value, rest, err := prose(flags, positional, flag, stdin)
		if err != nil {
			return fmt.Errorf("%s: %w", cmd, err)
		}
		positional = rest
		if len(value) > max {
			return fmt.Errorf("%s exceeds %d bytes", flag, max)
		}
		out.args[wire] = value
		return nil
	}

	switch cmd {
	case "capabilities":
		if len(positional) != 0 {
			return out, fmt.Errorf("capabilities takes no positional arguments")
		}
		if err := putFlag("machine", "machine", 48, false); err != nil {
			return out, err
		}
	case "dispatch":
		for _, field := range []struct {
			flag, wire string
			max        int
		}{
			{"key", "key", 256}, {"machine", "machine", 48}, {"harness", "harness", 32},
			{"model", "model", 256}, {"repo", "repo", 4096}, {"requested-ref", "requested_ref", 256},
			{"label", "label", 80},
		} {
			if err := putFlag(field.flag, field.wire, field.max, true); err != nil {
				return out, err
			}
		}
		if err := putFlag("thinking", "thinking", 16, false); err != nil {
			return out, err
		}
		if thinking, ok := out.args["thinking"]; ok {
			switch thinking {
			case "off", "minimal", "low", "medium", "high", "xhigh", "max":
			default:
				return out, fmt.Errorf("thinking must be off, minimal, low, medium, high, xhigh, or max")
			}
		}
		if err := putProse("task", "task", 24576); err != nil {
			return out, err
		}
	case "status":
		if len(positional) > 1 {
			return out, fmt.Errorf("status accepts at most one job id")
		}
		if len(positional) == 1 {
			id, err := takeID()
			if err != nil {
				return out, err
			}
			out.args["id"] = id
		}
		if value, ok := flags.take("offset"); ok {
			var offset int
			if _, err := fmt.Sscanf(value, "%d", &offset); err != nil || fmt.Sprintf("%d", offset) != value || offset < 0 || offset > 100000 {
				return out, fmt.Errorf("offset must be an integer from 0 through 100000")
			}
			out.args["offset"] = offset
		}
	case "steer", "answer":
		id, err := takeID()
		if err != nil {
			return out, err
		}
		out.args["id"] = id
		key, err := takeRequired("key", 256)
		if err != nil {
			return out, err
		}
		out.args["key"] = key
		if err := putProse("text", "text", 8192); err != nil {
			return out, err
		}
	case "cancel":
		id, err := takeID()
		if err != nil {
			return out, err
		}
		out.args["id"] = id
		key, err := takeRequired("key", 256)
		if err != nil {
			return out, err
		}
		out.args["key"] = key
	case "reconcile":
		if len(positional) != 0 {
			return out, fmt.Errorf("reconcile takes no arguments")
		}
	case "abandon":
		id, err := takeID()
		if err != nil {
			return out, err
		}
		out.args["id"] = id
		if err := putProse("reason", "reason", 4096); err != nil {
			return out, err
		}
	case "settle":
		id, err := takeID()
		if err != nil {
			return out, err
		}
		out.args["id"] = id
		if len(positional) == 0 {
			return out, fmt.Errorf("settle requires done, failed, or cancelled")
		}
		verdict := positional[0]
		positional = positional[1:]
		if verdict != "done" && verdict != "failed" && verdict != "cancelled" {
			return out, fmt.Errorf("verdict must be done, failed, or cancelled")
		}
		out.args["verdict"] = verdict
		if err := putProse("summary", "summary", 8192); err != nil {
			return out, err
		}
	case "resolve-operation":
		id, err := takeID()
		if err != nil {
			return out, err
		}
		out.args["id"] = id
		if len(positional) < 2 {
			return out, fmt.Errorf("resolve-operation requires operation and resolution")
		}
		op, resolution := positional[0], positional[1]
		positional = positional[2:]
		if op != "workspace" && op != "launch" && op != "prompt" {
			return out, fmt.Errorf("operation must be workspace, launch, or prompt")
		}
		if resolution != "retry-confirmed-absent" && resolution != "prompt-confirmed-delivered" {
			return out, fmt.Errorf("invalid operation resolution")
		}
		out.args["operation"], out.args["resolution"] = op, resolution
		if err := putProse("reason", "reason", 4096); err != nil {
			return out, err
		}
	case "resolve-intent":
		id, err := takeID()
		if err != nil {
			return out, err
		}
		out.args["id"] = id
		if len(positional) == 0 || positional[0] == "-" {
			return out, fmt.Errorf("resolve-intent requires an intent key")
		}
		if len(positional[0]) > 256 {
			return out, fmt.Errorf("intent key is too long")
		}
		out.args["key"] = positional[0]
		positional = positional[1:]
		if err := putProse("reason", "reason", 4096); err != nil {
			return out, err
		}
	}
	if len(positional) != 0 {
		return out, fmt.Errorf("%s has unexpected arguments", cmd)
	}
	if err := flags.finish(); err != nil {
		return out, err
	}
	return out, nil
}

type flagValues map[string][]string

func (f flagValues) take(name string) (string, bool) {
	v := f[name]
	if len(v) == 0 {
		return "", false
	}
	delete(f, name)
	return v[0], true
}
func (f flagValues) takeBool(name string) bool { _, ok := f.take(name); return ok }
func (f flagValues) finish() error {
	for k := range f {
		return fmt.Errorf("unknown or unsupported option --%s", k)
	}
	return nil
}

var valueFlags = map[string]bool{
	"summary": true, "label": true, "assign": true, "accent": true, "note": true,
	"machine": true, "key": true, "harness": true, "model": true, "thinking": true,
	"repo": true, "requested-ref": true, "task": true, "offset": true, "text": true,
	"reason": true,
}

func parseFlags(args []string) (flagValues, []string, bool, error) {
	f := flagValues{}
	var pos []string
	jsonMode := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--json" {
			if jsonMode {
				return nil, nil, false, fmt.Errorf("--json specified more than once")
			}
			jsonMode = true
			continue
		}
		if a == "--archived" {
			if len(f["archived"]) > 0 {
				return nil, nil, false, fmt.Errorf("--archived specified more than once")
			}
			f["archived"] = []string{"true"}
			continue
		}
		if strings.HasPrefix(a, "--") {
			name := strings.TrimPrefix(a, "--")
			if !valueFlags[name] {
				return nil, nil, false, fmt.Errorf("unknown option %s", a)
			}
			if len(f[name]) > 0 {
				return nil, nil, false, fmt.Errorf("%s specified more than once", a)
			}
			if i+1 >= len(args) {
				return nil, nil, false, fmt.Errorf("%s requires a value", a)
			}
			i++
			f[name] = []string{args[i]}
			continue
		}
		pos = append(pos, a)
	}
	return f, pos, jsonMode, nil
}

func prose(flags flagValues, positional []string, name string, stdin io.Reader) (string, []string, error) {
	v, has := flags.take(name)
	useStdin := len(positional) > 0 && positional[0] == "-"
	if has && useStdin {
		return "", positional, fmt.Errorf("use either --%s or '-', not both", name)
	}
	if !has && !useStdin {
		return "", positional, fmt.Errorf("requires --%s TEXT or '-' to read stdin", name)
	}
	if useStdin {
		var err error
		v, err = readProse(stdin)
		if err != nil {
			return "", positional, err
		}
		positional = positional[1:]
	}
	if len(v) > MaxProseBytes {
		return "", positional, fmt.Errorf("text exceeds %d bytes", MaxProseBytes)
	}
	if strings.IndexByte(v, 0) >= 0 {
		return "", positional, fmt.Errorf("text contains a NUL byte")
	}
	if strings.TrimSpace(v) == "" {
		return "", positional, fmt.Errorf("text must not be empty")
	}
	return v, positional, nil
}

func readProse(r io.Reader) (string, error) {
	b, err := io.ReadAll(io.LimitReader(r, MaxProseBytes+1))
	if err != nil {
		return "", fmt.Errorf("reading stdin: %w", err)
	}
	if len(b) > MaxProseBytes {
		return "", fmt.Errorf("stdin exceeds %d bytes", MaxProseBytes)
	}
	b = bytes.TrimSuffix(b, []byte("\n"))
	b = bytes.TrimSuffix(b, []byte("\r"))
	return string(b), nil
}
func assignee(v string) (bool, error) {
	switch v {
	case "kes":
		return true, nil
	case "kevin":
		return false, nil
	default:
		return false, fmt.Errorf("assignment must be kes or kevin")
	}
}
func validAccent(v string) error {
	if v != "attention" && v != "caution" {
		return fmt.Errorf("accent must be attention or caution")
	}
	return nil
}

func call(path string, req Request) (json.RawMessage, *remoteError, error) {
	if !filepath.IsAbs(path) {
		return nil, nil, errors.New("FAMILIAR_IMP_SOCKET must be an absolute path")
	}
	if err := checkPrivateSocket(path); err != nil {
		return nil, nil, err
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return nil, nil, fmt.Errorf("encoding request: %w", err)
	}
	if len(payload)+1 > MaxWireBytes {
		return nil, nil, fmt.Errorf("request exceeds %d-byte wire limit", MaxWireBytes)
	}
	ctx, cancel := context.WithTimeout(context.Background(), dialTimeout)
	defer cancel()
	d := net.Dialer{}
	conn, err := d.DialContext(ctx, "unix", path)
	if err != nil {
		return nil, nil, fmt.Errorf("connecting to resident: %w", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(ioTimeout))
	if _, err = conn.Write(append(payload, '\n')); err != nil {
		return nil, nil, fmt.Errorf("writing request: %w", err)
	}
	body, err := io.ReadAll(io.LimitReader(conn, MaxWireBytes+1))
	if err != nil {
		return nil, nil, fmt.Errorf("reading resident response: %w", err)
	}
	if len(body) > MaxWireBytes {
		return nil, nil, fmt.Errorf("resident response exceeds %d-byte wire limit", MaxWireBytes)
	}
	if len(body) == 0 || body[len(body)-1] != '\n' {
		return nil, nil, errors.New("resident response is not newline-terminated")
	}
	line := body[:len(body)-1]
	if len(line) == 0 || bytes.IndexByte(line, '\n') >= 0 {
		return nil, nil, errors.New("resident sent more or fewer than one response record")
	}
	var resp response
	dec := json.NewDecoder(bytes.NewReader(line))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&resp); err != nil {
		return nil, nil, fmt.Errorf("invalid resident response: %w", err)
	}
	if err := requireJSONEOF(dec); err != nil {
		return nil, nil, err
	}
	if resp.OK == nil {
		return nil, nil, errors.New("resident response omits ok")
	}
	if *resp.OK {
		if resp.Error != nil || len(resp.Result) == 0 || bytes.Equal(resp.Result, []byte("null")) {
			return nil, nil, errors.New("invalid successful resident response envelope")
		}
		return resp.Result, nil, nil
	}
	if resp.Error == nil || resp.Error.Code == "" || resp.Error.Message == "" || len(resp.Result) != 0 {
		return nil, nil, errors.New("invalid failed resident response envelope")
	}
	return nil, resp.Error, nil
}

func requireJSONEOF(dec *json.Decoder) error {
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("resident response contains multiple JSON values")
		}
		return fmt.Errorf("invalid trailing resident response: %w", err)
	}
	return nil
}

func checkPrivateSocket(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("resident socket: %w", err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		return errors.New("resident endpoint is not a Unix socket")
	}
	if info.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("resident socket permissions %04o are not private", info.Mode().Perm())
	}
	parent, err := os.Stat(filepath.Dir(path))
	if err != nil {
		return fmt.Errorf("resident socket directory: %w", err)
	}
	if parent.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("resident socket directory permissions %04o are not private", parent.Mode().Perm())
	}
	uid := uint32(os.Getuid())
	if st, ok := info.Sys().(*syscall.Stat_t); ok && st.Uid != uid {
		return errors.New("resident socket is owned by another user")
	}
	if st, ok := parent.Sys().(*syscall.Stat_t); ok && st.Uid != uid {
		return errors.New("resident socket directory is owned by another user")
	}
	return nil
}

func safeErrorCode(s string) string {
	if len(s) > 64 {
		return "remote_error"
	}
	for _, r := range s {
		if !(r == '_' || r == '-' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return "remote_error"
		}
	}
	return s
}

type item struct {
	ID      string  `json:"id"`
	Summary string  `json:"summary"`
	Label   *string `json:"label"`
	Notes   []struct {
		User bool    `json:"user"`
		Text string  `json:"text"`
		At   *string `json:"at"`
	} `json:"notes"`
	AssignedToKes bool    `json:"assignedToKes"`
	Accent        *string `json:"accent"`
	MaterialMtime string  `json:"materialMtime"`
	ArchivedAt    *string `json:"archivedAt"`
}

func writeHuman(w io.Writer, operation string, raw json.RawMessage) error {
	if operation == "list" {
		var items []item
		if err := json.Unmarshal(raw, &items); err != nil {
			var wrapper struct {
				Items []item `json:"items"`
			}
			if e := json.Unmarshal(raw, &wrapper); e != nil || wrapper.Items == nil {
				return err
			}
			items = wrapper.Items
		}
		if len(items) == 0 {
			_, err := io.WriteString(w, "No Plate items.\n")
			return err
		}
		for _, it := range items {
			fmt.Fprintf(w, "%s\t%s%s\n", it.ID, it.Summary, itemTags(it))
		}
		return nil
	}
	var it item
	if err := json.Unmarshal(raw, &it); err == nil && it.ID != "" {
		fmt.Fprintf(w, "%s\t%s%s\n", it.ID, it.Summary, itemTags(it))
		for _, n := range it.Notes {
			author := "Kes"
			if n.User {
				author = "You"
			}
			at := ""
			if n.At != nil {
				at = " " + *n.At
			}
			fmt.Fprintf(w, "  %s%s: %s\n", author, at, n.Text)
		}
		return nil
	}
	_, err := io.WriteString(w, "ok\n")
	return err
}
func writeAgentHuman(w io.Writer, operation string, raw json.RawMessage) error {
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		return err
	}
	if operation == "capabilities" {
		if machines, ok := value["machines"].([]any); ok {
			if len(machines) == 0 {
				_, err := io.WriteString(w, "No enrolled agent machines.\n")
				return err
			}
			for _, entry := range machines {
				machine, _ := entry.(map[string]any)
				fmt.Fprintf(w, "%v\tmodels=%v\n", machine["machine_id"], machine["model_count"])
			}
			return nil
		}
		fmt.Fprintf(w, "%v\tharnesses=%v\tmodels=%v\n", value["machine_id"], value["harnesses"], value["models"])
		return nil
	}
	if operation == "status" {
		if jobs, ok := value["jobs"].([]any); ok {
			if len(jobs) == 0 {
				_, err := io.WriteString(w, "No Familiar Agent jobs.\n")
				return err
			}
			for _, entry := range jobs {
				writeAgentJob(w, entry)
			}
			fmt.Fprintf(w, "Showing %v of %v (offset %v).\n", len(jobs), value["total"], value["offset"])
			return nil
		}
	}
	if value["job_id"] != nil {
		writeAgentJob(w, value)
		if hint, ok := value["attach_hint"].(string); ok && hint != "" {
			fmt.Fprintf(w, "Attach: %s\n", hint)
		}
		return nil
	}
	if scheduled, ok := value["scheduled"].(bool); ok && scheduled {
		_, err := io.WriteString(w, "Reconciliation scheduled.\n")
		return err
	}
	_, err := io.WriteString(w, "ok\n")
	return err
}
func writeAgentJob(w io.Writer, entry any) {
	job, _ := entry.(map[string]any)
	state := job["semantic_state"]
	if state == nil {
		state = job["state"]
	}
	fmt.Fprintf(w, "%v\t%v\t%v\t%v\n", job["job_id"], state, job["reachability"], job["label"])
}

const agentHelp = `Usage: imp agent <command> [options]

Commands:
  capabilities       List enrolled machines or one machine's exact models
  dispatch           Admit durable work on an enrolled remote machine
  status             List a bounded page or inspect one job
  steer              Persist guidance for a job
  answer             Answer a freshly observed blocked job
  cancel             Persist cancellation intent (not settlement)
  reconcile          Schedule immediate observation
  abandon            Explicitly abandon unresolved work
  settle             Explicit controller settlement after inspection
  resolve-operation  Resolve an uncertain workspace, launch, or prompt
  resolve-intent     Retire an uncertain input after inspection

Use 'imp agent <command> --help' for command details.
All commands accept --json. Long prose accepts '-' to read stdin.
`

var agentCommandHelp = map[string]string{
	"capabilities":      "Usage: imp agent capabilities [--machine ID] [--json]\n",
	"dispatch":          "Usage: imp agent dispatch --key KEY --machine ID --harness pi --model PROVIDER/MODEL [--thinking LEVEL] --repo /REMOTE/REPO --requested-ref REF (--task TEXT | -) --label TEXT [--json]\n\nAdmits work; it does not report completion. repo is an absolute path on the enrolled machine. Preserve --key after a lost reply. A lone '-' reads the task from stdin (maximum 24 KiB).\n",
	"status":            "Usage: imp agent status [JOB_ID] [--offset N] [--json]\n\nLists five jobs per page; JOB_ID returns bounded full status with native attach coordinates.\n",
	"steer":             "Usage: imp agent steer JOB_ID --key KEY (--text TEXT | -) [--json]\n",
	"answer":            "Usage: imp agent answer JOB_ID --key KEY (--text TEXT | -) [--json]\n\nRequires a fresh blocked observation.\n",
	"cancel":            "Usage: imp agent cancel JOB_ID --key KEY [--json]\n\nCancellation is durable intent, not a cancelled verdict.\n",
	"reconcile":         "Usage: imp agent reconcile [--json]\n\nForces observation; never blindly retries an uncertain mutation.\n",
	"abandon":           "Usage: imp agent abandon JOB_ID (--reason TEXT | -) [--json]\n",
	"settle":            "Usage: imp agent settle JOB_ID <done|failed|cancelled> (--summary TEXT | -) [--json]\n\nExplicit controller judgment after inspection; not agent proof.\n",
	"resolve-operation": "Usage: imp agent resolve-operation JOB_ID <workspace|launch|prompt> <retry-confirmed-absent|prompt-confirmed-delivered> (--reason TEXT | -) [--json]\n",
	"resolve-intent":    "Usage: imp agent resolve-intent JOB_ID INTENT_KEY (--reason TEXT | -) [--json]\n",
}

func itemTags(it item) string {
	var tags []string
	if it.Label != nil {
		tags = append(tags, "label="+*it.Label)
	}
	if it.AssignedToKes {
		tags = append(tags, "assigned=kes")
	} else {
		tags = append(tags, "assigned=kevin")
	}
	if it.Accent != nil {
		tags = append(tags, "accent="+*it.Accent)
	}
	if it.ArchivedAt != nil {
		tags = append(tags, "archived")
	}
	if len(tags) == 0 {
		return ""
	}
	return " [" + strings.Join(tags, ", ") + "]"
}

const rootHelp = `Usage: imp <area> <command> [options]

A private model tool for capabilities owned by this Familiar resident.

Areas:
  plate    Read and update the shared Plate
  agent    Dispatch and control durable Familiar Agents

Run 'imp <area> --help' to discover commands.
`
const plateHelp = `Usage: imp plate <command> [options]

Commands:
  list             List active items
  get              Show one item and its notes
  add              Add an item
  update-summary   Replace an item's summary
  set-label        Set an item's label
  clear-label      Clear an item's label
  append-note      Append a note authored as Kes
  assign           Assign an item to kes or kevin
  set-accent       Set attention or caution accent
  clear-accent     Clear an item's accent
  close            Archive an item
  restore          Restore an archived item

Use 'imp plate <command> --help' for command details.
All commands accept --json. Prose commands accept '-' to read stdin.
`

var commandHelp = map[string]string{
	"list":           "Usage: imp plate list [--archived] [--json]\n\nLists active items by reverse material recency. --archived includes archived items.\n",
	"get":            "Usage: imp plate get <id> [--json]\n",
	"add":            "Usage: imp plate add (--summary TEXT | -) [--label TEXT] [--assign kes|kevin] [--accent attention|caution] [--json]\n\nA lone '-' reads the summary from stdin (up to 64 KiB).\n",
	"update-summary": "Usage: imp plate update-summary <id> (--summary TEXT | -) [--json]\n",
	"set-label":      "Usage: imp plate set-label <id> (--label TEXT | -) [--json]\n",
	"clear-label":    "Usage: imp plate clear-label <id> [--json]\n",
	"append-note":    "Usage: imp plate append-note <id> (--note TEXT | -) [--json]\n\nThe resident records this model invocation as authored by Kes.\n",
	"assign":         "Usage: imp plate assign <id> <kes|kevin> [--json]\n",
	"set-accent":     "Usage: imp plate set-accent <id> <attention|caution> [--json]\n",
	"clear-accent":   "Usage: imp plate clear-accent <id> [--json]\n",
	"close":          "Usage: imp plate close <id> [--json]\n",
	"restore":        "Usage: imp plate restore <id> [--json]\n",
}
