// Package session reads Kev's own words out of a Pi session JSONL.
// Only human-authored user text counts as evidence: merges, notices,
// reminders, attachment manifests and fork briefs are stripped.
package session

import (
	"bytes"
	"bufio"
	"encoding/json"
	"io"
	"os"
	"regexp"
	"strings"
	"time"
)

type Turn struct {
	Role string // "kev" or "doc" (a tool result: primary document)
	ID   string
	At   time.Time
	Text string
}

type entry struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`
	Message   *struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

var (
	tagBlock    = regexp.MustCompile(`(?s)<(familiar-[a-z-]+|system-reminder)[^>]*>.*?</(familiar-[a-z-]+|system-reminder)>`)
	tagSelf     = regexp.MustCompile(`<familiar-[a-z-]+[^>]*/>`)
	attachBlock = regexp.MustCompile(`(?s)\[familiar-ui:attachments[^\]]*\].*?\[/familiar-ui:attachments\]`)
	readingLine = regexp.MustCompile(`(?m)^\[reading: [^\]]*\]\s*$`)
	noticeLine  = regexp.MustCompile(`(?m)^\[(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [^\]]*\].*$`)
	forkBrief   = regexp.MustCompile(`(?s)^You are (a fork|fork) `)
)

// Clean returns only Kev's words, or "" if the message isn't his.
func Clean(s string) string {
	if forkBrief.MatchString(s) || strings.HasPrefix(s, "The conversation history before this point") ||
		strings.HasPrefix(s, "Handoff from the previous context") {
		return ""
	}
	if i := noticeLine.FindStringIndex(s); i != nil {
		s = s[:i[0]]
	}
	s = tagBlock.ReplaceAllString(s, "")
	s = tagSelf.ReplaceAllString(s, "")
	s = attachBlock.ReplaceAllString(s, "")
	s = readingLine.ReplaceAllString(s, "")
	s = strings.TrimPrefix(strings.TrimSpace(s), "🗣")
	return strings.TrimSpace(s)
}

func textOf(raw json.RawMessage) string {
	var str string
	if json.Unmarshal(raw, &str) == nil {
		return str
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) != nil {
		return ""
	}
	var b strings.Builder
	for _, p := range parts {
		if p.Type == "text" {
			b.WriteString(p.Text)
			b.WriteString("\n")
		}
	}
	return b.String()
}

// KevTurns reads Kev's turns with timestamp in [since, until).
// Docs also returns tool results (fetched pages, file reads) as Role "doc".
func Docs(path string, since, until time.Time) ([]Turn, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return read(f, since, until, true)
}

func KevTurns(path string, since, until time.Time) ([]Turn, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return read(f, since, until, false)
}

func Read(r io.Reader, since, until time.Time) ([]Turn, error) { return read(r, since, until, false) }

func read(r io.Reader, since, until time.Time, docs bool) ([]Turn, error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	sinceS := since.UTC().Format("2006-01-02T15:04:05")
	var out []Turn
	for sc.Scan() {
		line := sc.Bytes()
		// Cheap prefilter before JSON: only user messages (and tool results for docs).
		isUser := bytesContains(line, `"role":"user"`)
		isTool := docs && bytesContains(line, `"role":"toolResult"`)
		if !isUser && !isTool {
			continue
		}
		var e entry
		if json.Unmarshal(line, &e) != nil || e.Type != "message" || e.Message == nil ||
			(e.Message.Role != "user" && !(docs && e.Message.Role == "toolResult")) {
			continue
		}
		if e.Timestamp < sinceS {
			continue
		}
		at, _ := time.Parse(time.RFC3339Nano, e.Timestamp)
		if !until.IsZero() && !at.Before(until) {
			continue
		}
		if e.Message.Role == "toolResult" {
			if t := strings.TrimSpace(textOf(e.Message.Content)); len(t) > 200 {
				out = append(out, Turn{Role: "doc", ID: e.ID, At: at, Text: t})
			}
			continue
		}
		t := Clean(textOf(e.Message.Content))
		if t == "" {
			continue
		}
		out = append(out, Turn{Role: "kev", ID: e.ID, At: at, Text: t})
	}
	return out, sc.Err()
}

func bytesContains(b []byte, s string) bool { return bytes.Contains(b, []byte(s)) }
