// ---------------------------------------------------------------------------
// OSC 52 clipboard-write bridge (browser boundary).
//
// WHY: the Rust viewer, on drag-selection release, emits an OSC 52 clipboard
// write — `ESC ] 52 ; c ; <base64> BEL` — down the PTY OUTPUT stream. Restty
// 0.2.6's browser path does not honor OSC 52, so the selection never reaches
// the browser's system clipboard. The gateway already taps the PTY output
// stream (feedOutput) for DECSET tracking and the latency probe; this module
// adds a NARROW tap that recognizes the viewer's clipboard-write sequence and
// hands the decoded text to the browser clipboard API.
//
// This is a pure, streaming parser (Osc52Parser) plus a thin browser writer
// (writeSystemClipboard). The tap NEVER strips or rewrites bytes: the full
// output — including the OSC 52 sequence — is still forwarded to Restty exactly
// as before, preserving DECSET/probe/reply behavior. We only OBSERVE.
//
// SECURITY BOUNDS (deliberately strict):
//   - Only the clipboard-WRITE target `c` is accepted. Read/query requests
//     (`ESC ] 52 ; c ; ? ...`) are silently ignored — we NEVER answer a read,
//     so remote output can never exfiltrate the browser clipboard.
//   - Base64 is validated against a strict alphabet and a bounded length; the
//     decoded bytes must be valid UTF-8 (TextDecoder fatal). Anything else is
//     dropped.
//   - Cross-chunk buffering is bounded (MAX_B64) so a never-terminated or
//     oversized sequence cannot grow memory without limit.
//   - Payloads are NEVER logged. Feedback surfaces byte/char counts only.
// ---------------------------------------------------------------------------

// Start marker for the 7-bit OSC 52 introducer plus the `52;` selector. The
// viewer emits the 7-bit form (ESC ]); the rarer 8-bit OSC (0x9d) is not
// produced by our viewer and is intentionally out of scope.
const START = "\x1b]52;";
const BEL = "\x07";
const ST = "\x1b\\"; // 7-bit String Terminator

// Upper bound on the base64 body we will buffer/accept for a single sequence.
// 256 KiB of base64 (~192 KiB of text) is far above any realistic terminal
// selection while capping worst-case memory and clipboard abuse.
export const MAX_B64 = 256 * 1024;

// Strict standard base64: alphabet only, canonical `=` padding, length a
// multiple of 4. No whitespace, no URL-safe chars, no `?` (that is a read).
const STRICT_B64 = /^[A-Za-z0-9+/]+={0,2}$/;

const utf8 = new TextDecoder("utf-8", { fatal: true });

// Decode a strict base64 clipboard body to UTF-8 text, or return null if it
// fails any bound. Reject reads (`?`) and anything that is not clean UTF-8.
function decodeClipboardBody(b64) {
  if (!b64 || b64.length > MAX_B64) return null;
  if (b64.length % 4 !== 0) return null;
  if (!STRICT_B64.test(b64)) return null;
  let binary;
  try {
    binary = atob(b64);
  } catch (_) {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
  try {
    const text = utf8.decode(bytes);
    return text.length ? text : null;
  } catch (_) {
    return null;
  }
}

// Streaming OSC 52 clipboard-write parser. feed(chunk) returns an array of
// decoded UTF-8 clipboard-write payloads found in the (possibly partial)
// stream, correctly reassembling sequences split across chunk boundaries.
export class Osc52Parser {
  constructor() {
    this.buf = "";
  }

  feed(chunk) {
    if (!chunk) return [];
    this.buf += chunk;
    const out = [];

    for (;;) {
      const start = this.buf.indexOf(START);
      if (start === -1) {
        // No sequence in flight. Retain only a short tail that could be the
        // leading bytes of a START marker split across the next chunk.
        this.buf = tail(this.buf, START.length - 1);
        break;
      }

      // Everything before the marker is irrelevant to us; drop it.
      const afterStart = start + START.length;
      const rest = this.buf.slice(afterStart);

      // The body (target + `;` + base64) is terminated by BEL or ST. Base64,
      // `;`, and the target byte never contain ESC or BEL, so the earliest of
      // these two terminators is unambiguous.
      const bel = rest.indexOf(BEL);
      const st = rest.indexOf(ST);
      let term = -1;
      let termLen = 0;
      if (bel !== -1 && (st === -1 || bel < st)) {
        term = bel;
        termLen = BEL.length;
      } else if (st !== -1) {
        term = st;
        termLen = ST.length;
      }

      if (term === -1) {
        // Incomplete sequence. If the unterminated body already exceeds the
        // bound, abandon it (advance past this START so we do not re-match or
        // buffer unboundedly); otherwise wait for more bytes.
        if (rest.length > MAX_B64) {
          this.buf = this.buf.slice(afterStart);
          continue;
        }
        this.buf = this.buf.slice(start);
        break;
      }

      const body = rest.slice(0, term);
      this.buf = rest.slice(term + termLen);

      // Split target from data on the first `;`. Accept ONLY the exact
      // clipboard-write target `c`; ignore reads, primary selection, or any
      // multi-target selector.
      const semi = body.indexOf(";");
      if (semi !== -1) {
        const target = body.slice(0, semi);
        const data = body.slice(semi + 1);
        if (target === "c") {
          const text = decodeClipboardBody(data);
          if (text !== null) out.push(text);
        }
      }
      // Loop to find further sequences already in the buffer.
    }

    return out;
  }
}

function tail(s, n) {
  return s.length > n ? s.slice(s.length - n) : s;
}

// ---------------------------------------------------------------------------
// Browser clipboard writer. Prefers the async Clipboard API, which works in a
// secure context (loopback/HTTPS) when backed by the transient user activation
// from the browser pointerup that initiated the drag selection. Falls back to
// the legacy execCommand path ONLY when the async API is unavailable (e.g. a
// non-secure context or an ancient engine); that fallback likewise consumes the
// same transient activation.
//
// Returns the method used ("async" | "exec") on success; throws on failure.
// The clipboard payload is never logged.
// ---------------------------------------------------------------------------
export async function writeSystemClipboard(text, deps = {}) {
  const nav = deps.navigator || (typeof navigator !== "undefined" ? navigator : undefined);
  const doc = deps.document || (typeof document !== "undefined" ? document : undefined);
  const secure = deps.isSecureContext !== undefined
    ? deps.isSecureContext
    : (typeof window !== "undefined" ? window.isSecureContext : false);

  if (secure && nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
    await nav.clipboard.writeText(text);
    return "async";
  }

  if (doc && typeof doc.execCommand === "function") {
    const ta = doc.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    doc.body.appendChild(ta);
    try {
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = doc.execCommand("copy");
      if (!ok) throw new Error("execCommand copy rejected");
      return "exec";
    } finally {
      ta.remove();
    }
  }

  throw new Error("no clipboard API available");
}

// ---------------------------------------------------------------------------
// Glue: build an output tap that parses OSC 52 clipboard writes and, for each,
// writes to the system clipboard, reporting success/failure via callbacks. The
// clipboard writer is injectable for tests. Returns a `feed(chunk)` function.
// ---------------------------------------------------------------------------
export function createOsc52Bridge({ writeClipboard = writeSystemClipboard, onCopied, onFailed } = {}) {
  const parser = new Osc52Parser();
  return function feed(chunk) {
    const payloads = parser.feed(chunk);
    for (const text of payloads) {
      Promise.resolve()
        .then(() => writeClipboard(text))
        .then((method) => { onCopied && onCopied({ chars: text.length, method }); })
        .catch((err) => { onFailed && onFailed(err); });
    }
    return payloads.length;
  };
}
