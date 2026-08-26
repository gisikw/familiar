// ---------------------------------------------------------------------------
// App-mouse forwarding. restty DOES encode mouse down/up/move via its internal
// MouseController, but only when its DECSET tracking state (1000/1002/1003/1006)
// is active — and in our IPC transport path plain clicks weren't reaching the
// remote app (remote terminal), while local selection worked. Rather than fight
// restty's selection-vs-mouse arbitration, we own app-mouse explicitly:
//
//   1. Parse the pty OUTPUT stream for DECSET/DECRST 1000/1002/1003/1006/1015/
//      1016 to know exactly when the application wants mouse reports and in
//      which encoding.
//   2. When tracking is active, translate pointerdown/up/move/wheel over the
//      terminal element into the correct mouse report bytes and write them to
//      the pty — capturing the events BEFORE restty's canvas listeners so we
//      don't double-report.
//
// This is testable in isolation (encodeMouse + DecsetTracker below) and does
// not depend on restty internals.
// ---------------------------------------------------------------------------

// Track which mouse modes the application has enabled, parsed from output.
export class DecsetTracker {
  constructor() {
    // reporting modes
    this.report = { 1000: false, 1002: false, 1003: false, 9: false };
    // encoding modes
    this.sgr = false; // 1006
    this.sgrPixels = false; // 1016
    this.urxvt = false; // 1015
  }

  // Feed a chunk of terminal OUTPUT. Scans for CSI ? Pm h / l sequences.
  feed(chunk) {
    // Match ESC [ ? <digits;digits...> h|l  (private mode set/reset)
    const re = /\x1b\[\?([0-9;]+)([hl])/g;
    let m;
    while ((m = re.exec(chunk))) {
      const set = m[2] === "h";
      for (const p of m[1].split(";")) {
        const code = parseInt(p, 10);
        if (code === 1000 || code === 1002 || code === 1003 || code === 9)
          this.report[code] = set;
        else if (code === 1006) this.sgr = set;
        else if (code === 1016) this.sgrPixels = set;
        else if (code === 1015) this.urxvt = set;
      }
    }
  }

  isActive() {
    return (
      this.report[1000] ||
      this.report[1002] ||
      this.report[1003] ||
      this.report[9]
    );
  }

  // Motion policy: none (press only), drag (button held), any (all motion).
  motion() {
    if (this.report[1003]) return "any";
    if (this.report[1002]) return "drag";
    return "none";
  }

  format() {
    if (this.sgr) return "sgr";
    if (this.sgrPixels) return "sgr_pixels";
    if (this.urxvt) return "urxvt";
    return "x10";
  }
}

// Encode a mouse event to the wire bytes for the active format.
// kind: "down" | "up" | "move" | "wheel"
// button: 0=left 1=middle 2=right ; wheel uses 64(up)/65(down)
// col/row are 1-based cell coords. mods: {shift,alt,ctrl}
export function encodeMouse(kind, opts) {
  const { format, button, col, row, mods, motion } = opts;
  let cb = button;
  if (kind === "move") cb = button + 32; // motion flag
  // modifier bits: shift=4, meta/alt=8, ctrl=16
  let modBits = 0;
  if (mods) {
    if (mods.shift) modBits |= 4;
    if (mods.alt) modBits |= 8;
    if (mods.ctrl) modBits |= 16;
  }
  cb += modBits;

  if (format === "sgr" || format === "sgr_pixels") {
    const final = kind === "up" ? "m" : "M"; // release = lowercase
    return `\x1b[<${cb};${col};${row}${final}`;
  }
  // x10 / normal encoding: for release, button becomes 3 (unless wheel)
  let b = cb;
  if (kind === "up") b = 3 + modBits;
  // X10: each byte is value + 32. enc() adds the 32; pass raw values.
  const enc = (n) => String.fromCharCode(Math.min(255, 32 + n));
  return `\x1b[M${enc(b)}${enc(col)}${enc(row)}`;
}

// Map a DOM button to terminal button code.
export function domButtonToCode(button) {
  if (button === 1) return 1; // middle
  if (button === 2) return 2; // right
  return 0; // left / default
}
