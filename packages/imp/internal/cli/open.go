package cli

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// imp open: put a document or an Attention board in Kev's Open list.
//
// The list of pushes is one file, $FAMILIAR_STATE_DIR/open.json, read by the
// primary familiar-ui bridge (GET /v1/open) and polled by every client, which
// folds it into that device's Open list. Kev closing a row there removes it
// from the file (POST /v1/open/close), so it closes on every device. The
// shape is protocol/src/open.ts in familiar-ui; readers there are tolerant,
// and this writer preserves items it does not understand.

const openHelp = `Usage:
  imp open <path|#project> [--title T]   put it in Kev's Open list (every device)
  imp open list                          what's pushed and still open
  imp open close <id|path|#project>      take it back out

A path is a document the Reader can show (md, html, pdf, audio, image) under
its roots (~/Projects/{hoard/primers,wireframes,opcos,holdco,podcasts/episodes});
a directory means its index.md/index.html/README.md. #project opens that
Attention board. Rows wait in Open; they don't take over his screen. URLs and
single cards can't go in Open: link those in chat.
`

const maxOpenItems = 24
const maxOpenTitleRunes = 200

var openSlugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
var openIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

var openKinds = map[string]bool{
	".md": true, ".markdown": true, ".pdf": true, ".html": true, ".htm": true,
	".mp3": true, ".m4a": true, ".wav": true, ".ogg": true,
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".svg": true,
}

func openMain(args []string, out, errw io.Writer, getenv func(string) string) int {
	if len(args) == 0 || isHelp(args[0]) {
		io.WriteString(out, openHelp)
		return 0
	}
	state := getenv("FAMILIAR_STATE_DIR")
	if state == "" || !filepath.IsAbs(state) {
		fmt.Fprintln(errw, "imp: FAMILIAR_STATE_DIR is not set; imp open works only inside a Familiar resident")
		return ExitUnavailable
	}
	file := filepath.Join(state, "open.json")
	switch args[0] {
	case "list", "ls":
		if len(args) != 1 {
			return usageError(errw, "open list takes no arguments")
		}
		items, e := readOpenFile(file)
		if e != nil {
			return branchError(errw, e)
		}
		if len(items) == 0 {
			fmt.Fprintln(out, "nothing pushed")
		}
		for _, it := range items {
			fmt.Fprintf(out, "%s  %s  %s\n", str(it, "id"), str(it, "title"), openTarget(it))
		}
		return 0
	case "close", "rm":
		if len(args) != 2 {
			return usageError(errw, "usage: imp open close <id|path|#project>")
		}
		return openClose(file, args[1], out, errw, getenv)
	}
	target, title := "", ""
	for i := 0; i < len(args); i++ {
		switch a := args[i]; {
		case a == "--title" || a == "--label":
			if i+1 >= len(args) {
				return usageError(errw, "%s needs a value", a)
			}
			title = args[i+1]
			i++
		case strings.HasPrefix(a, "--title=") || strings.HasPrefix(a, "--label="):
			title = a[strings.Index(a, "=")+1:]
		case strings.HasPrefix(a, "--"):
			return usageError(errw, "unknown flag %s (see imp open --help)", a)
		case target == "":
			target = a
		default:
			return usageError(errw, "one thing at a time: imp open <path|#project> [--title T]")
		}
	}
	if target == "" {
		return usageError(errw, "usage: imp open <path|#project> [--title T]")
	}
	item, e := openItemFor(target, title, getenv)
	if e != nil {
		return usageError(errw, "%v", e)
	}
	items, e := readOpenFile(file)
	if e != nil {
		return branchError(errw, e)
	}
	key := openTarget(item)
	msg := "opened"
	kept := items[:0]
	for _, it := range items {
		if openTarget(it) == key {
			item["id"] = it["id"]
			msg = "already open; moved to the end"
			continue
		}
		kept = append(kept, it)
	}
	items = append(kept, item)
	if len(items) > maxOpenItems {
		items = items[len(items)-maxOpenItems:]
	}
	if e := writeOpenFile(file, items); e != nil {
		return branchError(errw, e)
	}
	fmt.Fprintf(out, "%s: %s (%s) · id %s\n", msg, str(item, "title"), key, str(item, "id"))
	return 0
}

func openClose(file, which string, out, errw io.Writer, getenv func(string) string) int {
	items, e := readOpenFile(file)
	if e != nil {
		return branchError(errw, e)
	}
	key := which
	if !openIDRe.MatchString(which) || strings.HasPrefix(which, "#") {
		if it, e := openItemFor(which, "", getenv); e == nil {
			key = openTarget(it)
		}
	}
	kept := items[:0]
	var gone map[string]any
	for _, it := range items {
		if gone == nil && (str(it, "id") == which || openTarget(it) == key) {
			gone = it
			continue
		}
		kept = append(kept, it)
	}
	if gone == nil {
		fmt.Fprintf(errw, "imp: nothing pushed matches %s (imp open list)\n", which)
		return ExitUsage
	}
	if e := writeOpenFile(file, kept); e != nil {
		return branchError(errw, e)
	}
	fmt.Fprintf(out, "closed: %s\n", str(gone, "title"))
	return 0
}

func str(m map[string]any, k string) string { s, _ := m[k].(string); return s }

// openTarget is an item's identity for dedupe: its path, or #slug for a board.
func openTarget(it map[string]any) string {
	if str(it, "kind") == "board" {
		return "#" + str(it, "slug")
	}
	return str(it, "path")
}

func openItemFor(target, title string, getenv func(string) string) (map[string]any, error) {
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	switch {
	case strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://"):
		return nil, errors.New("URLs can't go in Open (the Reader shows files); link it in chat instead")
	case strings.HasPrefix(target, "card:"):
		return nil, errors.New("single cards can't go in Open; open the card's board with #project")
	case strings.HasPrefix(target, "#") || strings.HasPrefix(target, "board:"):
		slug := strings.TrimPrefix(strings.TrimPrefix(target, "#"), "board:")
		if !openSlugRe.MatchString(slug) {
			return nil, fmt.Errorf("%q isn't a project slug", slug)
		}
		if title = clip(title, maxOpenTitleRunes); title == "" {
			title = "#" + slug
		}
		return map[string]any{"id": newOpenID(), "kind": "board", "slug": slug, "title": title, "addedAt": now}, nil
	}
	path, e := openDocPath(target, getenv)
	if e != nil {
		return nil, e
	}
	if title = clip(title, maxOpenTitleRunes); title == "" {
		title = clip(docTitle(path), maxOpenTitleRunes)
	}
	return map[string]any{"id": newOpenID(), "kind": "doc", "path": path, "title": title, "addedAt": now}, nil
}

// docRoots mirrors familiar-ui's documentRoots(): FAMILIAR_UI_DOC_ROOTS, else
// the default shelves under $HOME/Projects. A path outside them would be a
// row the Reader refuses to open, so it is refused here instead.
func docRoots(getenv func(string) string) []string {
	if raw := getenv("FAMILIAR_UI_DOC_ROOTS"); raw != "" {
		var roots []string
		for _, r := range strings.Split(raw, ":") {
			if r != "" {
				roots = append(roots, filepath.Clean(r))
			}
		}
		return roots
	}
	home := getenv("HOME")
	if home == "" {
		home = "/home/familiar"
	}
	var roots []string
	for _, r := range []string{"hoard/primers", "wireframes", "opcos", "holdco", "podcasts/episodes"} {
		roots = append(roots, filepath.Join(home, "Projects", r))
	}
	return roots
}

func openDocPath(target string, getenv func(string) string) (string, error) {
	path := target
	if path == "~" || strings.HasPrefix(path, "~/") {
		home := getenv("HOME")
		if home == "" {
			home = "/home/familiar"
		}
		path = filepath.Join(home, strings.TrimPrefix(path, "~"))
	}
	if !filepath.IsAbs(path) {
		if wd, e := os.Getwd(); e == nil {
			path = filepath.Join(wd, path)
		}
	}
	path = filepath.Clean(path)
	info, e := os.Stat(path)
	if e != nil {
		return "", fmt.Errorf("can't open %s: %v", target, e)
	}
	if info.IsDir() {
		found := ""
		for _, name := range []string{"index.md", "index.html", "README.md"} {
			if s, e := os.Stat(filepath.Join(path, name)); e == nil && !s.IsDir() {
				found = filepath.Join(path, name)
				break
			}
		}
		if found == "" {
			return "", fmt.Errorf("%s is a directory with no index.md, index.html or README.md", target)
		}
		path = found
	}
	if !openKinds[strings.ToLower(filepath.Ext(path))] {
		return "", fmt.Errorf("the Reader can't show %s (md, html, pdf, audio or image only)", filepath.Base(path))
	}
	real, e := filepath.EvalSymlinks(path)
	if e != nil {
		real = path
	}
	for _, root := range docRoots(getenv) {
		r, e := filepath.EvalSymlinks(root)
		if e != nil {
			r = root
		}
		if strings.HasPrefix(real, r+string(filepath.Separator)) {
			return path, nil
		}
	}
	return "", fmt.Errorf("%s is outside the Reader's roots (%s); move or copy it under one", target, strings.Join(docRoots(getenv), ", "))
}

var htmlTitleRe = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)

// docTitle: an HTML <title>, a Markdown first "# " heading, else the file
// (or, for index/README, its folder) with dashes as spaces.
func docTitle(path string) string {
	if f, e := os.Open(path); e == nil {
		buf := make([]byte, 16<<10)
		n, _ := io.ReadFull(f, buf)
		f.Close()
		head := string(buf[:n])
		switch strings.ToLower(filepath.Ext(path)) {
		case ".html", ".htm":
			if m := htmlTitleRe.FindStringSubmatch(head); m != nil {
				if t := clip(htmlUnescape(m[1]), maxOpenTitleRunes); t != "" {
					return t
				}
			}
		case ".md", ".markdown":
			for _, line := range strings.Split(head, "\n") {
				if strings.HasPrefix(line, "# ") {
					return strings.TrimSpace(line[2:])
				}
			}
		}
	}
	base := filepath.Base(path)
	stem := strings.TrimSuffix(base, filepath.Ext(base))
	if l := strings.ToLower(stem); l == "index" || l == "readme" {
		stem = filepath.Base(filepath.Dir(path))
	}
	return strings.Join(strings.Fields(strings.NewReplacer("-", " ", "_", " ").Replace(stem)), " ")
}

func htmlUnescape(s string) string {
	return strings.NewReplacer("&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", `"`, "&#39;", "'", "&middot;", "·", "&mdash;", "—", "&ndash;", "–").Replace(s)
}

func newOpenID() string {
	b := make([]byte, 6)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// readOpenFile returns the raw items (unknown keys and items kept as written).
// A missing file is an empty list; a garbled one is an error, never silently
// overwritten.
func readOpenFile(file string) ([]map[string]any, error) {
	b, e := os.ReadFile(file)
	if errors.Is(e, os.ErrNotExist) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var doc struct {
		Items []json.RawMessage `json:"items"`
	}
	if e := json.Unmarshal(b, &doc); e != nil {
		return nil, fmt.Errorf("%s is not readable JSON (%v); fix or remove it", file, e)
	}
	var items []map[string]any
	for _, raw := range doc.Items {
		var it map[string]any
		if json.Unmarshal(raw, &it) == nil && it != nil {
			items = append(items, it)
		}
	}
	return items, nil
}

func writeOpenFile(file string, items []map[string]any) error {
	if items == nil {
		items = []map[string]any{}
	}
	b, e := json.MarshalIndent(map[string]any{"v": 1, "items": items}, "", "  ")
	if e != nil {
		return e
	}
	dir := filepath.Dir(file)
	tmp, e := os.CreateTemp(dir, ".open.json.*")
	if e != nil {
		return e
	}
	_, e = tmp.Write(append(b, '\n'))
	if c := tmp.Close(); e == nil {
		e = c
	}
	if e == nil {
		e = os.Chmod(tmp.Name(), 0600)
	}
	if e == nil {
		e = os.Rename(tmp.Name(), file)
	}
	if e != nil {
		os.Remove(tmp.Name())
	}
	return e
}
