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
	if args[0] != "plate" {
		return usageError(stderr, "unknown area %q; try 'imp --help'", args[0])
	}
	if len(args) == 1 || isHelp(args[1]) {
		io.WriteString(stdout, plateHelp)
		return 0
	}
	if len(args) > 2 && isHelp(args[2]) {
		if help, ok := commandHelp[args[1]]; ok {
			io.WriteString(stdout, help)
			return 0
		}
		return usageError(stderr, "unknown Plate command %q; try 'imp plate --help'", args[1])
	}

	inv, err := parsePlate(args[1:], stdin)
	if err != nil {
		return usageError(stderr, "%v", err)
	}
	path := getenv("FAMILIAR_IMP_SOCKET")
	if path == "" {
		fmt.Fprintln(stderr, "imp: FAMILIAR_IMP_SOCKET is not set; this command is available only inside an owning Familiar resident")
		return ExitUnavailable
	}
	result, remote, err := call(path, Request{Version: WireVersion, Area: "plate", Operation: inv.operation, Args: inv.args})
	if err != nil {
		fmt.Fprintf(stderr, "imp: %v\n", err)
		return ExitProtocol
	}
	if remote != nil {
		fmt.Fprintf(stderr, "imp: %s: %s\n", safeErrorCode(remote.Code), remote.Message)
		return ExitRemote
	}
	if inv.json {
		stdout.Write(result)
		io.WriteString(stdout, "\n")
		return 0
	}
	if err := writeHuman(stdout, inv.operation, result); err != nil {
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

var valueFlags = map[string]bool{"summary": true, "label": true, "assign": true, "accent": true, "note": true}

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

Run 'imp plate --help' to discover Plate commands.
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
