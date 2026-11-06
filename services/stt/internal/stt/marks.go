package stt

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"time"
	"unicode"
)

// Pause markers. When a take's long interior pauses were compressed, the
// transcript says where, so the reader can tell Kev trailed off (Nov 6: "so
// you know I trailed off"). Two tiers: " [...] " for a pause under
// longPause, " [......] " for longPause or more (stepped away, lost in
// thought).
//
// The words still come from transcribing the joined take whole: transcribing
// each span on its own loses context mid-sentence and costs accuracy (see
// pauses.go). Each span is ALSO transcribed on its own, only to find which
// words of the whole transcript belong to which span; the marker goes at
// each span boundary. Any failure there returns the whole transcript
// unmarked, so marking can never cost a take its words.

const (
	pauseMarker     = "[...]"
	longPauseMarker = "[......]"
	longPause       = 15.0 // seconds
)

// maxMarkedPieces bounds the extra per-span transcriptions for one take.
const maxMarkedPieces = 8

// serveMarked transcribes a compressed take whole, then marks its pauses.
func (s *Server) serveMarked(ctx context.Context, w http.ResponseWriter, r *http.Request, c *compressed, start time.Time) {
	// The span transcriptions run alongside the whole one, so marking costs
	// about one extra backend round trip of latency, not one per span.
	type res struct {
		text string
		ok   bool
	}
	var results []chan res
	if len(c.pieces) >= 2 && len(c.pieces) <= maxMarkedPieces {
		for _, p := range c.pieces {
			ch := make(chan res, 1)
			results = append(results, ch)
			pr := pieceRequest(ctx, r, p) // built before dispatch touches r
			go func() {
				t, ok := s.transcribeRequest(ctx, pr)
				ch <- res{t, ok}
			}()
		}
	}
	rec := httptest.NewRecorder()
	s.dispatch(ctx, rec, r, start)
	whole, ok := textOf(rec)
	parts := make([]string, 0, len(results))
	for _, ch := range results {
		v := <-ch
		if !v.ok {
			ok = false
		}
		parts = append(parts, v.text)
	}
	if !ok || len(results) == 0 {
		if len(results) > 0 {
			s.c.Logger.Warn("pause marking skipped: a transcription failed")
		}
		copyRecorded(w, rec)
		return
	}
	marked := markPauses(whole, parts, c.gaps)
	s.c.Logger.Info("marked pauses", "spans", len(parts), "markers", strings.Count(marked, "[..."), "ms", time.Since(start).Milliseconds())
	reply(w, 200, map[string]string{"text": marked})
}

// pieceRequest is a copy of orig carrying one span's WAV instead.
func pieceRequest(ctx context.Context, orig *http.Request, wav []byte) *http.Request {
	r := orig.Clone(ctx)
	r.Header.Set("Content-Type", "audio/wav")
	r.Body = io.NopCloser(bytes.NewReader(wav))
	r.ContentLength = int64(len(wav))
	return r
}

// transcribeRequest runs a request through the same backend path and
// returns just its text.
func (s *Server) transcribeRequest(ctx context.Context, r *http.Request) (string, bool) {
	rec := httptest.NewRecorder()
	s.dispatch(ctx, rec, r, time.Now())
	return textOf(rec)
}

func textOf(rec *httptest.ResponseRecorder) (string, bool) {
	if rec.Code < 200 || rec.Code >= 300 {
		return "", false
	}
	var v struct {
		Text *string `json:"text"`
	}
	if json.Unmarshal(rec.Body.Bytes(), &v) != nil || v.Text == nil {
		return "", false
	}
	return *v.Text, true
}

func copyRecorded(w http.ResponseWriter, rec *httptest.ResponseRecorder) {
	for k, v := range rec.Header() {
		w.Header()[k] = v
	}
	w.Header().Del("Content-Length")
	w.WriteHeader(rec.Code)
	_, _ = w.Write(rec.Body.Bytes())
}

// markPauses inserts a pause marker into whole at each boundary between the
// spans whose separate transcripts are parts; gaps[i] is the original pause
// after part i and picks the tier (the longest gap crossed, if a span had no
// words of its own). Words of whole are aligned to
// the concatenated part words (longest common subsequence on normalized
// words); each whole word takes the span of its match, unmatched words take
// the span of the nearest preceding match. A marker is never placed at the
// very start or end, and never twice in a row.
func markPauses(whole string, parts []string, gaps []float64) string {
	ws := strings.Fields(whole)
	if len(ws) == 0 || len(parts) < 2 {
		return whole
	}
	var cs []string
	var label []int
	for i, p := range parts {
		for _, f := range strings.Fields(p) {
			cs = append(cs, norm(f))
			label = append(label, i)
		}
	}
	if len(cs) == 0 {
		return whole
	}
	wn := make([]string, len(ws))
	for i, f := range ws {
		wn[i] = norm(f)
	}
	// LCS table, suffix form.
	n, m := len(wn), len(cs)
	dp := make([][]int, n+1)
	for i := range dp {
		dp[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if wn[i] != "" && wn[i] == cs[j] {
				dp[i][j] = dp[i+1][j+1] + 1
			} else if dp[i+1][j] >= dp[i][j+1] {
				dp[i][j] = dp[i+1][j]
			} else {
				dp[i][j] = dp[i][j+1]
			}
		}
	}
	span := make([]int, n)
	for i := range span {
		span[i] = -1
	}
	matched := 0
	for i, j := 0, 0; i < n && j < m; {
		switch {
		case wn[i] != "" && wn[i] == cs[j]:
			span[i] = label[j]
			matched++
			i++
			j++
		case dp[i+1][j] >= dp[i][j+1]:
			i++
		default:
			j++
		}
	}
	if matched == 0 {
		return whole
	}
	// Unmatched words: leading ones belong to the first matched span, the
	// rest to the preceding word's span.
	first := 0
	for _, sp := range span {
		if sp >= 0 {
			first = sp
			break
		}
	}
	cur := first
	for i := range span {
		if span[i] < 0 {
			span[i] = cur
		}
		cur = span[i]
	}
	var out []string
	for i, f := range ws {
		if i > 0 && span[i] > span[i-1] {
			longest := 0.0
			for k := span[i-1]; k < span[i] && k < len(gaps); k++ {
				if gaps[k] > longest {
					longest = gaps[k]
				}
			}
			if longest >= longPause {
				out = append(out, longPauseMarker)
			} else {
				out = append(out, pauseMarker)
			}
		}
		out = append(out, f)
	}
	return strings.Join(out, " ")
}

func norm(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return unicode.ToLower(r)
		}
		return -1
	}, s)
}
