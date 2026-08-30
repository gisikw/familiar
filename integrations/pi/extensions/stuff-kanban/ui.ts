import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { LANES, laneOf, type KanbanBoard, type Lane, type StuffItem } from "./stuff.ts";

interface BoardActions {
  move(item: StuffItem, lane: Lane): Promise<StuffItem>;
  open(item: StuffItem): Promise<void>;
}

interface Theme {
  bold(text: string): string;
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
}

const LABELS: Record<Lane, string> = {
  open: "OPEN",
  in_progress: "IN PROGRESS",
  ready_for_review: "READY FOR REVIEW",
  done: "DONE",
};

export async function openKanban(ctx: ExtensionContext, board: KanbanBoard, actions: BoardActions): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const component = new KanbanComponent(board, theme as Theme, actions, () => tui.requestRender(), () => done());
    return component;
  });
}

export class KanbanComponent {
  private items: StuffItem[];
  private laneIndex = 0;
  private rowIndex = 0;
  private showDetail = false;
  private busy = false;
  private message = "";

  constructor(
    private readonly board: KanbanBoard,
    private readonly theme: Theme,
    private readonly actions: BoardActions,
    private readonly changed: () => void,
    private readonly close: () => void,
  ) {
    this.items = [...board.items];
    const firstLane = LANES.findIndex((lane) => this.inLane(lane).length > 0);
    this.laneIndex = Math.max(0, firstLane);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines = [
      truncateToWidth(this.theme.fg("accent", this.theme.bold(`Stuff Kanban — ${this.board.batch.name}`)), safeWidth),
      truncateToWidth(this.theme.fg("dim", `${this.board.batch.id}  •  ${this.items.length} cards`), safeWidth),
      "",
    ];

    if (safeWidth < 72) lines.push(...this.renderNarrow(safeWidth));
    else lines.push(...this.renderWide(safeWidth));

    if (this.showDetail) lines.push(...this.renderDetail(safeWidth));
    if (this.message) lines.push(truncateToWidth(this.theme.fg(this.busy ? "warning" : "muted", this.message), safeWidth));
    lines.push(truncateToWidth(this.theme.fg("dim", "←→/hjkl lanes & cards  ↑↓/jk select  enter details  [ ] move  o open  q/esc close"), safeWidth));
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) {
      this.close();
      return;
    }
    if (matchesKey(data, Key.left) || data === "h") this.changeLane(-1);
    else if (matchesKey(data, Key.right) || data === "l") this.changeLane(1);
    else if (matchesKey(data, Key.up) || data === "k") this.changeRow(-1);
    else if (matchesKey(data, Key.down) || data === "j") this.changeRow(1);
    else if (matchesKey(data, Key.enter)) this.showDetail = !this.showDetail;
    else if (data === "[") void this.move(-1);
    else if (data === "]") void this.move(1);
    else if (data === "o") void this.open();
    this.changed();
  }

  invalidate(): void {}

  private renderWide(width: number): string[] {
    const gap = 1;
    const columnWidth = Math.max(10, Math.floor((width - gap * 3) / 4));
    const laneItems = LANES.map((lane) => this.inLane(lane));
    const maxCards = Math.max(1, ...laneItems.map((items) => items.length));
    const rows: string[] = [];

    rows.push(LANES.map((lane, index) => {
      const count = laneItems[index]!.length;
      const heading = `${LABELS[lane]} (${count})`;
      const styled = index === this.laneIndex ? this.theme.fg("accent", this.theme.bold(heading)) : this.theme.fg("muted", heading);
      return pad(styled, columnWidth);
    }).join(" "));

    for (let row = 0; row < maxCards; row++) {
      rows.push(laneItems.map((items, lane) => this.card(items[row], lane === this.laneIndex && row === this.rowIndex, columnWidth)).join(" "));
    }
    rows.push("");
    return rows;
  }

  private renderNarrow(width: number): string[] {
    const lane = LANES[this.laneIndex]!;
    const items = this.inLane(lane);
    const lines = [truncateToWidth(this.theme.fg("accent", this.theme.bold(`${LABELS[lane]} (${items.length})  ${this.laneIndex + 1}/4`)), width)];
    if (items.length === 0) lines.push(truncateToWidth(this.theme.fg("dim", "  No cards"), width));
    else items.forEach((item, row) => lines.push(this.card(item, row === this.rowIndex, width)));
    lines.push("");
    return lines;
  }

  private card(item: StuffItem | undefined, selected: boolean, width: number): string {
    if (!item) return " ".repeat(width);
    const prefix = selected ? "› " : "  ";
    let text = truncateToWidth(prefix + item.name, width);
    text = pad(text, width);
    return selected ? this.theme.bg("selectedBg", this.theme.fg("text", text)) : text;
  }

  private renderDetail(width: number): string[] {
    const item = this.selected();
    if (!item) return [this.theme.fg("dim", "No card selected."), ""];
    const meta = JSON.stringify(item.metadata, null, 2);
    const heading = this.theme.fg("accent", this.theme.bold(`${item.name}  ${item.id}`));
    const body = `${heading}\n${this.theme.fg("muted", `status: ${laneOf(item)}  revision: ${item.revision}`)}\n${meta}`;
    return [...wrapTextWithAnsi(body, width), ""];
  }

  private changeLane(delta: number): void {
    this.laneIndex = clamp(this.laneIndex + delta, 0, LANES.length - 1);
    this.rowIndex = clamp(this.rowIndex, 0, Math.max(0, this.inLane(LANES[this.laneIndex]!).length - 1));
    this.message = "";
  }

  private changeRow(delta: number): void {
    const count = this.inLane(LANES[this.laneIndex]!).length;
    this.rowIndex = clamp(this.rowIndex + delta, 0, Math.max(0, count - 1));
    this.message = "";
  }

  private async move(delta: number): Promise<void> {
    const item = this.selected();
    const targetIndex = this.laneIndex + delta;
    if (!item || targetIndex < 0 || targetIndex >= LANES.length || this.busy) return;
    const target = LANES[targetIndex]!;
    this.busy = true;
    this.message = `Moving ${item.id} to ${target}…`;
    this.changed();
    try {
      const updated = await this.actions.move(item, target);
      this.items = this.items.map((candidate) => candidate.id === item.id ? updated : candidate);
      this.laneIndex = targetIndex;
      this.rowIndex = Math.max(0, this.inLane(target).findIndex((candidate) => candidate.id === item.id));
      this.message = `Moved to ${target}`;
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  private async open(): Promise<void> {
    const item = this.selected();
    if (!item || this.busy) return;
    try {
      await this.actions.open(item);
      this.message = `Opened ${item.id}`;
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    }
    this.changed();
  }

  private selected(): StuffItem | undefined {
    return this.inLane(LANES[this.laneIndex]!)[this.rowIndex];
  }

  private inLane(lane: Lane): StuffItem[] {
    return this.items.filter((item) => laneOf(item) === lane);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pad(text: string, width: number): string {
  const clipped = truncateToWidth(text, width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
