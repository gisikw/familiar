package stt

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMarkPausesTiers(t *testing.T) {
	cases := []struct {
		name, whole string
		parts       []string
		gaps        []float64
		want        string
	}{
		{"short pause", "And then I said. Nothing twice.", []string{"and then I said", "nothing twice"}, []float64{6}, "And then I said. [...] Nothing twice."},
		{"long pause", "Okay so. Where was I?", []string{"okay so", "where was I"}, []float64{40}, "Okay so. [......] Where was I?"},
		{"exactly 15 s is long", "a b. c d.", []string{"a b", "c d"}, []float64{15}, "a b. [......] c d."},
		{"two pauses", "one two three four five six", []string{"one two", "three four", "five six"}, []float64{5, 20}, "one two [...] three four [......] five six"},
		// Whole and parts disagree on a word; alignment still finds the seam.
		{"misheard word", "I want to go there now", []string{"I wanna go", "there now"}, []float64{7}, "I want to go [...] there now"},
		// A span the model heard nothing in: one marker, tier from the longest gap crossed.
		{"empty middle span", "first bit last bit", []string{"first bit", "", "last bit"}, []float64{6, 18}, "first bit [......] last bit"},
		// Nothing aligns: transcript untouched.
		{"no alignment", "totally different", []string{"foo", "bar"}, []float64{6}, "totally different"},
		{"empty whole", "", []string{"a", "b"}, []float64{6}, ""},
		// Never a marker at the very start or end.
		{"all words in first span", "just this", []string{"just this", "and more"}, []float64{6}, "just this"},
	}
	for _, c := range cases {
		if got := markPauses(c.whole, c.parts, c.gaps); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

// End to end: the whole take is transcribed for the words, each span on its
// own only to place the marker. The fake backend answers by input size.
func TestHandlerMarksCompressedPause(t *testing.T) {
	c := config(t)
	d := c.TempDir
	src := filepath.Join(d, "src.wav")
	os.WriteFile(src, wavBytes(pcmOf(20)), 0600)
	c.FFmpeg = script(t, d, "ffmpeg2", `#!/bin/sh
in=""; out=""; prev=""; for x in "$@"; do [ "$prev" = "-i" ] && in="$x"; prev="$x"; out="$x"; done
if [ "$(head -c 4 "$in")" = "RIFF" ]; then cp "$in" "$out"; else cp `+src+` "$out"; fi
`)
	c.VAD = script(t, d, "vad", `#!/bin/sh
printf 'Speech segment 0: start = 100.00, end = 300.00\nSpeech segment 1: start = 1500.00, end = 1700.00\n'
`)
	c.VADModel = filepath.Join(d, "vad.bin")
	os.WriteFile(c.VADModel, []byte("v"), 0600)
	c.PauseGap = 3 * time.Second
	c.PausePad = 400 * time.Millisecond
	// whole ~8.8 s, first span 0-3.4 s, second 14.6-20 s (5.4 s).
	c.Transcribe = script(t, d, "transcribe3", `#!/bin/sh
out=""; in=""; while [ $# -gt 0 ]; do case "$1" in -o) shift; out="$1";; -m) shift;; -q|--timestamps) [ "$1" = "--timestamps" ] && shift;; *) in="$1";; esac; shift; done
n=$(wc -c < "$in")
if [ "$n" -gt 250000 ]; then printf 'the first stanza. the last stanza.\n' > "$out"
elif [ "$n" -lt 140000 ]; then printf 'the first stanza\n' > "$out"
else printf 'the last stanza\n' > "$out"; fi
`)
	c.MaxAudio, c.MaxBody = 1<<20, 2<<20
	s, err := New(c)
	if err != nil {
		t.Fatal(err)
	}
	w := request(s.Handler(), "audio/wav", []byte("anything"))
	if w.Code != 200 {
		t.Fatalf("got %d %s", w.Code, w.Body.String())
	}
	if got := text(t, w); got != "the first stanza. [...] the last stanza." {
		t.Fatalf("got %q", got)
	}
}
