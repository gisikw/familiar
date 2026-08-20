// ---------------------------------------------------------------------------
// Slack-style :emoji: completion. Triggers ONLY on user keystrokes (we tap the
// input before it is written to the pty), never on terminal output. When the
// user has typed `:` followed by 2+ word chars, a floating picker shows fuzzy
// matches; Tab/Enter inserts the emoji (written to pty as UTF-8), Esc dismisses.
// Toggle with Cmd/Ctrl-E.
//
// SHIPPED OFF BY DEFAULT (feature flag). Rationale, honestly: we tap keystrokes
// blind — we can't see whether the remote line is a shell prompt, a vim command
// line, or a TUI. Triggering on bare `:`+2 word chars means `:wq<Enter>` in vim
// builds query "wq", pops the picker, and Enter would commit an emoji instead of
// writing+quitting. There is no reliable way to distinguish those contexts from
// the renderer, so the picker fights vim by construction. It's kept behind
// EMOJI_DEFAULT_ENABLED=false and Cmd/Ctrl-E so it never touches typing unless a
// user opts in for a shell session. When enabled, commit erases the typed
// `:query` (readline DEL) before inserting the glyph so it actually replaces.
// ---------------------------------------------------------------------------

// Feature flag: default OFF so it can't hijack vim's `:wq` etc. Cmd/Ctrl-E on.
export const EMOJI_DEFAULT_ENABLED = false;

let EMOJI = null; // { shortname: "😀", ... }
let NAMES = []; // sorted shortnames for matching

export async function loadEmoji() {
  if (EMOJI) return;
  const res = await fetch("./vendor/emoji.json");
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
  constructor({ writeToPty, getCursorRect, enabled }) {
    this.writeToPty = writeToPty;
    this.getCursorRect = getCursorRect || (() => null);
    this.enabled = enabled === undefined ? EMOJI_DEFAULT_ENABLED : enabled;
    this.query = ""; // chars typed after the trigger ':'
    this.active = false; // picker visible
    this.matches = [];
    this.selected = 0;
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
    this.active = false;
    this.query = "";
    this.el.hidden = true;
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
      // only makes sense at a shell/readline prompt — another reason the
      // feature is opt-in.
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

    // Not active: watch for a ':' that starts a trigger. We can't see the shell
    // buffer, so we begin tracking on ':' and require 2+ following word chars.
    if (e.key === ":") {
      this.query = "";
      this.active = false;
      this._pendingColon = true;
      return false;
    }
    if (this._pendingColon && e.key.length === 1 && /\w/.test(e.key)) {
      this.query += e.key;
      if (this.query.length >= 2) {
        this.active = true;
        this._update();
      }
      return false;
    }
    if (this._pendingColon) {
      this._pendingColon = false;
      this.query = "";
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
