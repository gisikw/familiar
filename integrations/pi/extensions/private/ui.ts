/* ============================================================================
 * Private-mode terminal surfaces
 * ============================================================================
 *
 * Two modal components. Both are deliberately *modal* rather than inline.
 *
 * Private plaintext is never rendered into the ordinary transcript, because the
 * ordinary transcript is terminal scrollback — held in the tmux server, replayed
 * to every viewer that attaches afterwards, including browser viewers. Anything
 * shown inside a modal lives in the redrawn UI region and is gone when the modal
 * closes. Sealed entries in the main transcript always render as sealed, even
 * while unlocked.
 *
 * Terminal primitives arrive through an injected `TuiKit` rather than a direct
 * `@earendil-works/pi-tui` import, so the input handling and passphrase
 * redaction below stay testable without Pi's module tree. `tui-kit.ts` supplies
 * the real one.
 */

export interface TuiKit {
  isEnter(data: string): boolean;
  isExit(data: string): boolean;
  isBackspace(data: string): boolean;
  isKillLine(data: string): boolean;
  truncate(text: string, width: number): string;
  wrap(text: string, width: number): string[];
}

export interface ThemeLike {
  fg(tone: string, text: string): string;
  bold(text: string): string;
}

export interface Component {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

function paint(theme: ThemeLike, tone: string, text: string): string {
  try {
    return theme.fg(tone, text);
  } catch {
    return text;
  }
}

function bold(theme: ThemeLike, text: string): string {
  try {
    return theme.bold(text);
  } catch {
    return text;
  }
}

function isPrintable(data: string): boolean {
  if (data.length === 0) return false;
  for (const character of data) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/* --- masked passphrase ---------------------------------------------------- */

export class PassphrasePrompt implements Component {
  private value = "";
  public onSubmit?: (value: string) => void;
  public onCancel?: () => void;

  constructor(
    private readonly kit: TuiKit,
    private readonly theme: ThemeLike,
    private readonly title: string,
    private readonly hint: string,
  ) {}

  handleInput(data: string): void {
    if (this.kit.isEnter(data)) {
      const value = this.value;
      this.value = "";
      this.onSubmit?.(value);
      return;
    }
    if (this.kit.isExit(data)) {
      this.value = "";
      this.onCancel?.();
      return;
    }
    if (this.kit.isBackspace(data)) {
      this.value = [...this.value].slice(0, -1).join("");
      return;
    }
    if (this.kit.isKillLine(data)) {
      this.value = "";
      return;
    }
    if (isPrintable(data)) this.value += data;
  }

  render(width: number): string[] {
    const masked = "•".repeat([...this.value].length);
    return [
      paint(this.theme, "warning", bold(this.theme, `🔒 ${this.title}`)),
      this.kit.truncate(`   ${masked}▏`, width),
      paint(this.theme, "dim", this.kit.truncate(`   ${this.hint}`, width)),
    ];
  }

  invalidate(): void {}
}

/* --- private console ------------------------------------------------------ */

export interface ConsoleTurn {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
}

export class PrivateConsole implements Component {
  private input = "";
  private turns: ConsoleTurn[] = [];
  private busy = false;
  private notice = "";

  public onSubmit?: (text: string) => void;
  public onExit?: () => void;
  public onCommand?: (command: string) => void;

  constructor(
    private readonly kit: TuiKit,
    private readonly theme: ThemeLike,
    /** Model attestation, shown continuously so the surface can never lie. */
    private readonly attestation: string,
  ) {}

  setTurns(turns: readonly ConsoleTurn[]): void {
    this.turns = [...turns];
  }

  append(turn: ConsoleTurn): void {
    this.turns.push(turn);
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  setNotice(notice: string): void {
    this.notice = notice;
  }

  handleInput(data: string): void {
    // Escape leaves even mid-turn: the way out of private mode must never
    // depend on a request completing.
    if (this.kit.isExit(data)) {
      this.onExit?.();
      return;
    }
    if (this.busy) return;
    if (this.kit.isEnter(data)) {
      const text = this.input.trim();
      this.input = "";
      if (text.length === 0) return;
      if (text.startsWith(":")) {
        this.onCommand?.(text.slice(1).trim());
        return;
      }
      this.onSubmit?.(text);
      return;
    }
    if (this.kit.isBackspace(data)) {
      this.input = [...this.input].slice(0, -1).join("");
      return;
    }
    if (this.kit.isKillLine(data)) {
      this.input = "";
      return;
    }
    if (isPrintable(data)) this.input += data;
  }

  render(width: number): string[] {
    const inner = Math.max(10, width - 2);
    const cut = (text: string, max: number) => this.kit.truncate(text, Math.max(1, max));
    const lines: string[] = [];
    lines.push(paint(this.theme, "warning", bold(this.theme, cut("╭─ PRIVATE — SEALED — LOCAL MODEL ONLY ".padEnd(width, "─"), width))));
    lines.push(paint(this.theme, "dim", cut(`│ ${this.attestation}`, width)));
    lines.push(paint(this.theme, "dim", cut("│ Enter to send · :help for commands · Esc to leave", width)));
    lines.push(paint(this.theme, "warning", cut("├".padEnd(width, "─"), width)));

    for (const turn of this.turns) {
      const tone = turn.role === "user" ? "accent" : turn.role === "system" ? "dim" : "text";
      const label = turn.role === "user" ? "you" : turn.role === "system" ? "···" : "local";
      for (const [index, wrapped] of this.kit.wrap(turn.text, Math.max(1, inner - 8)).entries()) {
        const prefix = index === 0 ? label.padEnd(6) : " ".repeat(6);
        lines.push(paint(this.theme, "warning", "│ ") + paint(this.theme, tone, cut(`${prefix}${wrapped}`, inner - 2)));
      }
      lines.push(paint(this.theme, "warning", "│"));
    }

    if (this.notice) {
      lines.push(paint(this.theme, "warning", "│ ") + paint(this.theme, "warning", cut(this.notice, inner - 2)));
    }
    const prompt = this.busy ? "…         " : "private ▸ ";
    lines.push(
      paint(this.theme, "warning", "│ ") +
        paint(this.theme, "accent", cut(`${prompt}${this.busy ? "" : `${this.input}▏`}`, inner - 2)),
    );
    lines.push(paint(this.theme, "warning", cut("╰".padEnd(width, "─"), width)));
    return lines;
  }

  invalidate(): void {}
}

export const CONSOLE_HELP = [
  ":history show the sealed history",
  ":declassify draft a rejoin payload",
  ":exit leave private mode",
].join(" · ");
