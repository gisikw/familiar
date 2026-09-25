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
	if args[0] != "attn" {
		switch args[0] {
		case "fork", "merge", "close", "forks":
			return branchMain(args, stdout, stderr, getenv)
		default:
			return schedulerMain(args, stdout, stderr, getenv)
		}
	}
	inv, done, code := attnMain(args[1:], stdin, stdout, stderr)
	if done {
		return code
	}
	path := getenv("FAMILIAR_IMP_SOCKET")
	if path == "" {
		fmt.Fprintln(stderr, "imp: FAMILIAR_IMP_SOCKET is not set; this command is available only inside an owning Familiar resident")
		return ExitUnavailable
	}
	result, remote, err := call(path, Request{Version: WireVersion, Area: "attn", Operation: inv.operation, Args: inv.args})
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
	if err := writeAttnHuman(stdout, inv.operation, result); err != nil {
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
	"reason": true, "revision": true,
}

func parseFlags(args []string) (flagValues, []string, bool, error) {
	return parseFlagsWith(args, valueFlags, map[string]bool{"archived": true})
}

func parseFlagsWith(args []string, values, bools map[string]bool) (flagValues, []string, bool, error) {
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
		if strings.HasPrefix(a, "--") {
			name := strings.TrimPrefix(a, "--")
			if bools[name] {
				if len(f[name]) > 0 {
					return nil, nil, false, fmt.Errorf("%s specified more than once", a)
				}
				f[name] = []string{"true"}
				continue
			}
			if !values[name] {
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

const rootHelp = `Usage: imp <attn|schedule|notify|dnd|fork|merge|close|forks> ...

A private CLI-shaped model tool for Attention and scheduled events.

Run 'imp attn --help' or 'imp schedule --help' for command discovery.
`
