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

// compressPauses decodes the take to 16 kHz mono PCM, runs the VAD, and when
// the take contains a pause of at least PauseGap returns a WAV of just the
// speech spans (each with PausePad of surrounding audio). nil means
// "transcribe the take as received".
func (s *Server) compressPauses(ctx context.Context, body []byte) []byte {
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
	pad := s.c.PausePad.Seconds()
	var joined []byte
	end := 0.0
	for _, sp := range spans {
		a := sp.Start - pad
		if a < end {
			a = end // never repeat audio when two padded spans would overlap
		}
		joined = append(joined, cut(pcm, a, sp.End+pad)...)
		end = sp.End + pad
	}
	if len(joined) == 0 {
		return nil
	}
	s.c.Logger.Info("compressed pauses", "spans", len(spans), "from_s", len(pcm)/2/vadRate, "to_s", len(joined)/2/vadRate, "ms", time.Since(start).Milliseconds())
	return wavBytes(joined)
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
