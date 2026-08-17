import { PENDING_ECHO_MAX } from "./protocol.ts";

/* --- Pending echoes: submit id → user-message correlation ----------------- */

// Dispatched-but-unechoed submits (delta doc #2): when pi echoes the user
// message back through message_start, we attach the client-chosen submit id
// so the client can claim its optimistic bubble / release its durable take.
//
// Matched by exact content, not FIFO position: a message typed directly into
// the TUI can interleave between dispatch and echo, and must not steal a
// correlation id. Identical texts resolve oldest-first (dispatch order).
// A miss degrades to an uncorrelated echo — never a wrong correlation.
export class PendingEchoes {
  private entries: { id: number; text: string }[] = [];

  push(id: number, text: string) {
    this.entries.push({ id, text });
    if (this.entries.length > PENDING_ECHO_MAX) this.entries.shift();
  }

  claim(content: string): number | undefined {
    const i = this.entries.findIndex((e) => e.text === content);
    if (i < 0) return undefined;
    return this.entries.splice(i, 1)[0].id;
  }
}
