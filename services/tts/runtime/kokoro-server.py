#!/usr/bin/env python3
"""Small OpenAI-compatible HTTP adapter for nixpkgs' hexgrad/kokoro."""
import argparse
import io
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import soundfile as sf
from kokoro import KModel, KPipeline

VOICE = re.compile(r"^[A-Za-z0-9_-]+$")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--voices-dir", required=True)
    ap.add_argument("--default-voice", default="af_heart")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, required=True)
    args = ap.parse_args()

    # Load fully before binding. The proxy's TCP readiness probe then means usable.
    model = KModel(repo_id="hexgrad/Kokoro-82M", config=args.config, model=args.model).eval()
    pipelines = {}
    lock = threading.Lock()  # KPipeline/model caches are not documented thread-safe.

    def synthesize(text, voice, speed):
        if not VOICE.fullmatch(voice):
            raise ValueError("invalid voice name")
        voice_path = f"{args.voices_dir}/{voice}.pt"
        lang = voice[0].lower()
        if lang not in "abefhipjz":
            raise ValueError("voice name must begin with a supported language code")
        with lock:
            pipeline = pipelines.get(lang)
            if pipeline is None:
                pipeline = pipelines[lang] = KPipeline(lang_code=lang, model=model)
            chunks = [r.audio.numpy() for r in pipeline(text, voice=voice_path, speed=speed) if r.audio is not None]
        if not chunks:
            raise ValueError("text produced no speech")
        return np.concatenate(chunks)

    class Handler(BaseHTTPRequestHandler):
        server_version = "familiar-kokoro/1"

        def log_message(self, fmt, *values):
            # Never log request bodies (which may contain private spoken text).
            print("kokoro:", fmt % values)

        def do_GET(self):
            if self.path in ("/livez", "/readyz"):
                self.send_response(200); self.end_headers(); self.wfile.write(b"ok\n")
            else:
                self.send_error(404)

        def do_POST(self):
            if self.path != "/v1/audio/speech":
                self.send_error(404); return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 1024 * 1024:
                    raise ValueError("invalid body size")
                req = json.loads(self.rfile.read(length))
                text = req.get("input")
                if not isinstance(text, str) or not text:
                    raise ValueError("input is required")
                voice = req.get("voice") or args.default_voice
                speed = float(req.get("speed", 1.0))
                if not 0.25 <= speed <= 4.0:
                    raise ValueError("speed must be between 0.25 and 4")
                fmt = str(req.get("response_format", "wav")).lower()
                formats = {"wav": ("WAV", "audio/wav"), "flac": ("FLAC", "audio/flac"), "pcm": ("RAW", "audio/pcm")}
                if fmt not in formats:
                    raise ValueError("response_format must be wav, flac, or pcm")
                audio = synthesize(text, voice, speed)
                out = io.BytesIO()
                sf.write(out, audio, 24000, format=formats[fmt][0], subtype="PCM_16")
                body = out.getvalue()
                self.send_response(200)
                self.send_header("Content-Type", formats[fmt][1])
                self.send_header("Content-Length", str(len(body)))
                self.end_headers(); self.wfile.write(body)
            except (ValueError, TypeError, json.JSONDecodeError, FileNotFoundError) as exc:
                body = json.dumps({"error": str(exc)}).encode()
                self.send_response(400); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
            except Exception:
                body = b'{"error":"synthesis failed"}'
                self.send_response(500); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
