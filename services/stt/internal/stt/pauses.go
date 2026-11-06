package stt

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"time"
)

// Pause compression. Parakeet TDT drops or invents the rest of a take after a
// long silence (notes/2026-10-23-stt-audio-check.md: "Okay, and using a
// service okay." for a clip whose tail after a 9 s pause was a full
// sentence). So when a take's speech is separated by a long pause, the pause
// is cut short and the take is transcribed whole, keeping sentence context.
//
// Speech comes from a real VAD (Silero via whisper.cpp's
// whisper-vad-speech-segments), not an energy threshold: squeezing plain
// silence turned noise into invented phrases. Transcribing each span on its
// own also fixed the tails but lost context mid-sentence.
//
// Tuning (Oct 23, WER vs whisper large-v3-turbo; state/stt-tuning/pausesplit):
// pauses of 5 s or more are cut to ~1.6 s (800 ms kept each side). On 77
// takes with long pauses, takes that lost most of their words went 6 -> 1
// and WER 0.173 -> 0.150. On 315 ordinary takes WER is unchanged (0.149).
// A 3 s gap compressed 64% of ordinary takes and cost ~0.2 pt WER there.
// Prep (decode + VAD) is ~90 ms per take. Every failure here degrades to
// the untouched take: compression must never cost a take.
//
// Only interior pauses are cut. The audio before the first span and after
// the last span is kept as received (Nov 6): trimming the trailing silence
// too made Parakeet drop a whole middle stanza of a poem reading ("Nothing
// Twice", 2026-11-06T04-57-51 s2). The same take with its tail intact, or
// with >=3 s of tail, transcribes in full; with the tail clipped to the
// 800 ms pad it lost 5-13 s deterministically, on both the GPU upstream and
// the local CPU model.

// Span is a [Start, End) range in seconds.
type Span struct{ Start, End float64 }

const (
	vadRate         = 16000
	defaultPausePad = 800 * time.Millisecond // room tone kept either side of each speech span
)

var segLine = regexp.MustCompile(`Speech segment \d+: start = ([0-9.]+), end = ([0-9.]+)`)

// parseSegments reads whisper-vad-speech-segments output. Times are in
// centiseconds (whisper.cpp's t0/t1 units).
func parseSegments(out []byte) []Span {
	var spans []Span
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		m := segLine.FindStringSubmatch(sc.Text())
		if m == nil {
			continue
		}
		a, e1 := strconv.ParseFloat(m[1], 64)
		b, e2 := strconv.ParseFloat(m[2], 64)
		if e1 != nil || e2 != nil || b <= a {
			continue
		}
		spans = append(spans, Span{a / 100, b / 100})
	}
	return spans
}

// mergeSpans joins VAD speech segments whose gap is shorter than gap, so only
// real pauses get compressed. It returns nil when the result is a single
// span (or none): nothing to compress.
func mergeSpans(segs []Span, gap float64) []Span {
	var out []Span
	for _, s := range segs {
		if n := len(out); n > 0 && s.Start-out[n-1].End < gap {
			if s.End > out[n-1].End {
				out[n-1].End = s.End
			}
			continue
		}
		out = append(out, s)
	}
	if len(out) < 2 {
		return nil
	}
	return out
}

// compressed is a take whose long interior pauses were cut: the joined WAV
// that gets transcribed, plus each speech piece as its own WAV so the pauses
// can be located in the transcript (see markPauses).
type compressed struct {
	wav    []byte
	pieces [][]byte
	gaps   []float64 // seconds of the original pause after each piece but the last
}

// compressPauses decodes the take to 16 kHz mono PCM, runs the VAD, and when
// the take contains a pause of at least PauseGap returns a WAV of just the
// speech spans (each with PausePad of surrounding audio). nil means
// "transcribe the take as received".
func (s *Server) compressPauses(ctx context.Context, body []byte) *compressed {
	if s.c.VADModel == "" {
		return nil
	}
	start := time.Now()
	dir, err := os.MkdirTemp(s.c.TempDir, "familiar-stt-vad-")
	if err != nil {
		return nil
	}
	defer os.RemoveAll(dir)
	in, wav := filepath.Join(dir, "input"), filepath.Join(dir, "audio.wav")
	if os.WriteFile(in, body, 0600) != nil {
		return nil
	}
	if run(ctx, s.c.FFmpeg, "-hide_banner", "-loglevel", "error", "-i", in, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", "-y", wav) != nil {
		return nil
	}
	out, err := exec.CommandContext(ctx, s.c.VAD, "-vm", s.c.VADModel, "-f", wav, "-np", "-t", "2").Output()
	if err != nil {
		s.c.Logger.Warn("vad failed; transcribing as received", "error", safeError(err))
		return nil
	}
	spans := mergeSpans(parseSegments(out), s.c.PauseGap.Seconds())
	if spans == nil {
		return nil
	}
	pcm, err := readPCM(wav)
	if err != nil {
		return nil
	}
	pieces := spanPieces(pcm, spans, s.c.PausePad.Seconds())
	var joined []byte
	c := &compressed{}
	for i, p := range pieces {
		joined = append(joined, p...)
		c.pieces = append(c.pieces, wavBytes(p))
		if i+1 < len(spans) {
			c.gaps = append(c.gaps, spans[i+1].Start-spans[i].End)
		}
	}
	if len(joined) == 0 {
		return nil
	}
	c.wav = wavBytes(joined)
	s.c.Logger.Info("compressed pauses", "spans", len(spans), "from_s", len(pcm)/2/vadRate, "to_s", len(joined)/2/vadRate, "ms", time.Since(start).Milliseconds())
	return c
}

// joinSpans keeps the take from its first sample to the end of the first
// span (+pad), each interior span with pad either side, and the last span
// (-pad) through the final sample: only the long pauses between spans shrink.
func joinSpans(pcm []byte, spans []Span, pad float64) []byte {
	var joined []byte
	for _, p := range spanPieces(pcm, spans, pad) {
		joined = append(joined, p...)
	}
	return joined
}

// spanPieces is joinSpans before the join: one PCM slice per speech span,
// in order, with the take's lead-in on the first and its tail on the last.
func spanPieces(pcm []byte, spans []Span, pad float64) [][]byte {
	var pieces [][]byte
	end := 0.0
	total := float64(len(pcm)/2) / vadRate
	for i, sp := range spans {
		a, z := sp.Start-pad, sp.End+pad
		if i == 0 {
			a = 0
		}
		if i == len(spans)-1 {
			z = total
		}
		if a < end {
			a = end // never repeat audio when two padded spans would overlap
		}
		pieces = append(pieces, cut(pcm, a, z)) // one per span, even if empty, so pieces line up with spans
		end = z
	}
	return pieces
}

// readPCM returns the sample bytes of a 16-bit PCM WAV written by ffmpeg,
// locating the "data" chunk rather than assuming a 44-byte header.
func readPCM(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(b) < 12 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
		return nil, errors.New("not wav")
	}
	for i := 12; i+8 <= len(b); {
		id, n := string(b[i:i+4]), int(binary.LittleEndian.Uint32(b[i+4:i+8]))
		i += 8
		if id == "data" {
			if n < 0 || i+n > len(b) {
				n = len(b) - i
			}
			return b[i : i+n], nil
		}
		i += n + n%2
	}
	return nil, errors.New("no data chunk")
}

func cut(pcm []byte, a, z float64) []byte {
	n := len(pcm) / 2
	i, j := int(a*vadRate), int(z*vadRate)
	if i < 0 {
		i = 0
	}
	if j > n {
		j = n
	}
	if i >= j {
		return nil
	}
	return pcm[i*2 : j*2]
}

func wavBytes(pcm []byte) []byte {
	var b bytes.Buffer
	w := func(v any) { _ = binary.Write(&b, binary.LittleEndian, v) }
	b.WriteString("RIFF")
	w(uint32(36 + len(pcm)))
	b.WriteString("WAVEfmt ")
	w(uint32(16))
	w(uint16(1)) // PCM
	w(uint16(1)) // mono
	w(uint32(vadRate))
	w(uint32(vadRate * 2))
	w(uint16(2))
	w(uint16(16))
	b.WriteString("data")
	w(uint32(len(pcm)))
	b.Write(pcm)
	return b.Bytes()
}
