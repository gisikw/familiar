// ---------------------------------------------------------------------------
// Slack-style :emoji: completion. Triggers ONLY on user keystrokes (we tap the
// input before it is written to the pty), never on terminal output. When the
// user has typed `:` followed by 2+ word chars, a floating picker shows fuzzy
// matches; Tab/Enter inserts the emoji (written to pty as UTF-8), Esc dismisses.
// Toggle with Cmd/Ctrl-E.
//
// SHIPPED ON BY DEFAULT, with a debounce as the safety valve. The honest
// hazard is unchanged: we tap keystrokes blind — we can't see whether the
// remote line is a shell prompt, a vim command line, or a TUI. `:wq<Enter>` in
// vim still builds query "wq", and if the picker were up Enter would commit an
// emoji instead of writing+quitting. What makes default-on tolerable is that
// the picker no longer pops the instant you reach `:`+2 chars: it waits for
// typing to settle (EMOJI_DEBOUNCE_MS) first. A `:wq<Enter>` typed at any human
// speed fires and clears the timer before it ever elapses, so the overlay never
// appears — you only see it when you type a `:name` and then pause. Cmd/Ctrl-E
// still toggles it off for a session where even that is unwelcome. On commit we
// erase the typed `:query` (readline DEL) before inserting the glyph so it
// actually replaces — which only makes sense at a shell/readline prompt, so if
// you live in a TUI, toggle it off.
// ---------------------------------------------------------------------------

// Feature flag: default ON. The debounce below (not opt-out) is what keeps it
// from hijacking fast-typed `:wq` etc. Cmd/Ctrl-E toggles per session.
export const EMOJI_DEFAULT_ENABLED = true;

// How long typing must settle after `:`+2 chars before the picker pops. Each
// keystroke resets this, so a burst of typing never flashes the overlay.
export const EMOJI_DEBOUNCE_MS = 1000;

let EMOJI = null; // { shortname: "😀", ... }
let NAMES = []; // sorted shortnames for matching

export async function loadEmoji() {
  if (EMOJI) return;
  const res = await fetch("/vendor/emoji.json");
  EMOJI = await res.json();
  NAMES = Object.keys(EMOJI);
}

// Simple subsequence fuzzy score: lower is better. Returns null if no match.
function fuzzyScore(query, name) {
  let qi = 0;
  let score = 0;
  let lastIdx = -1;
  for (let i = 0; i < name.length && qi < query.length; i++) {
    if (name[i] === query[qi]) {
      score += i - lastIdx; // gaps cost
      lastIdx = i;
      qi++;
    }
  }
  if (qi < query.length) return null;
  // prefer prefix and shorter names
  if (name.startsWith(query)) score -= 100;
  score += name.length * 0.1;
  return score;
}

export function search(query, limit = 8) {
  const q = query.toLowerCase();
  const out = [];
  for (const name of NAMES) {
    const s = fuzzyScore(q, name);
    if (s !== null) out.push({ name, emoji: EMOJI[name], score: s });
  }
  out.sort((a, b) => a.score - b.score);
  return out.slice(0, limit);
}

// The controller wires keystroke interception + the overlay DOM. `writeToPty`
// sends a string to the shell; `getCursorRect` returns the on-screen cursor
// rectangle for anchoring (falls back to bottom-left).
export class EmojiCompleter {
  constructor({ writeToPty, getCursorRect, enabled, debounceMs }) {
    this.writeToPty = writeToPty;
    this.getCursorRect = getCursorRect || (() => null);
    this.enabled = enabled === undefined ? EMOJI_DEFAULT_ENABLED : enabled;
    this.debounceMs = debounceMs === undefined ? EMOJI_DEBOUNCE_MS : debounceMs;
    this.query = ""; // chars typed after the trigger ':'
    this.tracking = false; // building a query; picker not yet shown (in debounce)
    this.active = false; // picker visible
    this.matches = [];
    this.selected = 0;
    this._timer = null; // pending debounce timer
    this._buildDom();
  }

  _buildDom() {
    this.el = document.createElement("div");
    this.el.id = "emoji-picker";
    this.el.hidden = true;
    document.body.appendChild(this.el);
  }

  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) this.dismiss();
    return this.enabled;
  }

  dismiss() {
    this._cancelTimer();
    this.active = false;
    this.tracking = false;
    this._pendingColon = false;
    this.query = "";
    this.el.hidden = true;
  }

  // Debounce plumbing: after `:`+2 chars we arm a timer and re-arm it on every
  // subsequent keystroke, so the picker only surfaces once typing pauses.
  _cancelTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _scheduleShow() {
    this._cancelTimer();
    this._timer = setTimeout(() => this._activate(), this.debounceMs);
  }

  _activate() {
    this._timer = null;
    if (!this.enabled || !this.tracking || this.query.length < 2) return;
    this.tracking = false;
    this.active = true;
    this._update();
  }

  _reset() {
    this._cancelTimer();
    this.tracking = false;
    this._pendingColon = false;
    this.query = "";
  }

  _render() {
    if (!this.matches.length) {
      this.dismiss();
      return;
    }
    this.el.innerHTML = this.matches
      .map(
        (m, i) =>
          `<div class="emoji-row${i === this.selected ? " sel" : ""}">` +
          `<span class="emoji-glyph">${m.emoji}</span>` +
          `<span class="emoji-name">:${escapeHtml(m.name)}:</span></div>`
      )
      .join("");
    // Anchor near cursor if available, else bottom-left of terminal.
    const rect = this.getCursorRect();
    this.el.hidden = false;
    const pad = 8;
    let left = pad;
    let top = window.innerHeight - this.el.offsetHeight - pad;
    if (rect) {
      left = Math.min(rect.left, window.innerWidth - this.el.offsetWidth - pad);
      // place above the cursor line
      top = rect.top - this.el.offsetHeight - 4;
      if (top < pad) top = rect.bottom + 4; // flip below if no room
    }
    this.el.style.left = `${Math.max(pad, left)}px`;
    this.el.style.top = `${Math.max(pad, top)}px`;
  }

  _commit() {
    const m = this.matches[this.selected];
    if (m) {
      // The colon + query chars were already echoed to the shell line, so
      // replace them: send readline DEL (0x7f) for each, then the glyph. This
      // only makes sense at a shell/readline prompt — if you live in a TUI,
      // toggle the feature off (Cmd/Ctrl-E).
      const erase = "\x7f".repeat(this.query.length + 1);
      this.writeToPty(erase + m.emoji);
    }
    this.dismiss();
  }

  // Intercept a keydown BEFORE it is forwarded to the pty. Return true if the
  // key was consumed (caller must then NOT forward it).
  handleKeydown(e) {
    if (!this.enabled) return false;

    // Toggle handled by caller (Cmd-E). Here we handle picker navigation and
    // the trigger tracking.
    if (this.active) {
      switch (e.key) {
        case "Escape":
          this.dismiss();
          return true;
        case "Tab":
        case "Enter":
          this._commit();
          return true;
        case "ArrowDown":
          this.selected = (this.selected + 1) % this.matches.length;
          this._render();
          return true;
        case "ArrowUp":
          this.selected =
            (this.selected - 1 + this.matches.length) % this.matches.length;
          this._render();
          return true;
        case "Backspace":
          this.query = this.query.slice(0, -1);
          if (this.query.length < 2) {
            this.dismiss();
            return false; // let backspace reach the shell
          }
          this._update();
          return false; // also let the shell delete the char
        default:
          if (e.key.length === 1 && /[\w+-]/.test(e.key)) {
            this.query += e.key;
            this._update();
            return false; // still echo the char to the shell
          }
          // any other key dismisses but is forwarded
          this.dismiss();
          return false;
      }
    }

    // Not active (picker hidden). We may still be `tracking`: query built,
    // waiting out the debounce. Extend the query and re-arm the timer on each
    // word char; the picker only pops once typing pauses for debounceMs. A
    // fast-typed `:wq<Enter>` clears the timer (Enter is not a word char) long
    // before it fires, so the overlay never appears.
    if (e.key === ":") {
      this._cancelTimer();
      this.query = "";
      this.active = false;
      this.tracking = false;
      this._pendingColon = true;
      return false;
    }
    if ((this._pendingColon || this.tracking) && e.key.length === 1 && /\w/.test(e.key)) {
      this.query += e.key;
      if (this.query.length >= 2) {
        this._pendingColon = false;
        this.tracking = true;
        this._scheduleShow(); // arm/re-arm; picker shows after the pause
      }
      return false;
    }
    // Backspace while tracking: shrink the query, drop out below the threshold.
    if (this.tracking && e.key === "Backspace") {
      this.query = this.query.slice(0, -1);
      if (this.query.length < 2) {
        this._reset();
      } else {
        this._scheduleShow();
      }
      return false;
    }
    // Any other key abandons an in-flight trigger; the key is still forwarded.
    if (this._pendingColon || this.tracking) {
      this._reset();
    }
    return false;
  }

  _update() {
    this.matches = search(this.query);
    this.selected = 0;
    this._render();
  }
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]
  );
}
