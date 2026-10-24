package stt

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestParseSegments(t *testing.T) {
	out := []byte("\nDetected 3 speech segments:\nSpeech segment 0: start = 263.00, end = 429.00\nSpeech segment 1: start = 1440.00, end = 1513.00\njunk\nSpeech segment 2: start = 1667.00, end = 1814.00\n")
	got := parseSegments(out)
	want := []Span{{2.63, 4.29}, {14.4, 15.13}, {16.67, 18.14}}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if d := got[i].Start - want[i].Start; d > 1e-9 || d < -1e-9 {
			t.Fatalf("span %d: got %v want %v", i, got[i], want[i])
		}
	}
}

func TestMergeSpans(t *testing.T) {
	segs := []Span{{2.63, 4.29}, {14.4, 15.13}, {16.67, 18.14}}
	got := mergeSpans(segs, 3)
	if len(got) != 2 || got[0] != (Span{2.63, 4.29}) || got[1] != (Span{14.4, 18.14}) {
		t.Fatalf("got %v", got)
	}
	if mergeSpans([]Span{{0, 1}, {2, 3}}, 3) != nil {
		t.Fatal("short pauses must not compress")
	}
	if mergeSpans(nil, 3) != nil {
		t.Fatal("no speech must not compress")
	}
}

func pcmOf(sec float64) []byte {
	n := int(sec * vadRate)
	b := make([]byte, n*2)
	for i := 0; i < n; i++ {
		binary.LittleEndian.PutUint16(b[i*2:], uint16(i))
	}
	return b
}

func TestWavRoundTripAndCut(t *testing.T) {
	pcm := pcmOf(2)
	p := filepath.Join(t.TempDir(), "a.wav")
	os.WriteFile(p, wavBytes(pcm), 0600)
	got, err := readPCM(p)
	if err != nil || !bytes.Equal(got, pcm) {
		t.Fatalf("round trip failed: %v", err)
	}
	if c := cut(pcm, -1, 0.5); len(c) != vadRate {
		t.Fatalf("cut clamps start: %d", len(c))
	}
	if c := cut(pcm, 1.5, 9); len(c) != vadRate {
		t.Fatalf("cut clamps end: %d", len(c))
	}
	if cut(pcm, 3, 4) != nil {
		t.Fatal("out of range cut must be empty")
	}
}

// End to end through the handler: a fake ffmpeg writes a 20 s WAV, a fake VAD
// reports speech at 1-3 s and 15-17 s, and the backend must receive ~5.6 s
// of audio (two 2 s spans + 0.4 s pad each side) instead of 20 s.
func TestCompressesLongPauseBeforeTranscribing(t *testing.T) {
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
	seen := filepath.Join(d, "seen.wav")
	c.Transcribe = script(t, d, "transcribe2", `#!/bin/sh
out=""; in=""; while [ $# -gt 0 ]; do case "$1" in -o) shift; out="$1";; -m) shift;; -q|--timestamps) [ "$1" = "--timestamps" ] && shift;; *) in="$1";; esac; shift; done
cp "$in" `+seen+`; printf 'tail survived\n' > "$out"
`)
	c.MaxAudio, c.MaxBody = 1<<20, 2<<20
	s, err := New(c)
	if err != nil {
		t.Fatal(err)
	}
	w := request(s.Handler(), "audio/wav", []byte("anything"))
	if w.Code != 200 || text(t, w) != "tail survived" {
		t.Fatalf("got %d %s", w.Code, w.Body.String())
	}
	pcm, err := readPCM(seen)
	if err != nil {
		t.Fatal(err)
	}
	if got := float64(len(pcm)/2) / vadRate; got < 5.5 || got > 5.7 {
		t.Fatalf("backend got %.2f s of audio, want ~5.6", got)
	}
}

func TestMissingVADDisablesCompression(t *testing.T) {
	c := config(t)
	c.VAD = filepath.Join(c.TempDir, "nope")
	c.VADModel = filepath.Join(c.TempDir, "nope.bin")
	c.PauseGap = time.Second
	s, err := New(c)
	if err != nil {
		t.Fatal(err)
	}
	if s.c.VADModel != "" {
		t.Fatal("compression should be off without the VAD")
	}
	if w := request(s.Handler(), "audio/webm", []byte("sound")); w.Code != 200 || text(t, w) != "hello world" {
		t.Fatalf("got %d %s", w.Code, w.Body.String())
	}
}
