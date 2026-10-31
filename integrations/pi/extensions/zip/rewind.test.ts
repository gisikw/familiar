import { describe, expect, test } from "bun:test";
import { planRewind, rewindKind, type BranchEntry } from "./rewind.ts";

const user = (id: string, text: string): BranchEntry => ({ id, type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const reply = (id: string, text = "ok"): BranchEntry => ({ id, type: "message", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
const toolAsk = (id: string): BranchEntry => ({ id, type: "message", message: { role: "assistant", content: [{ type: "text", text: "looking" }, { type: "toolCall", id: "t", name: "bash" }], stopReason: "toolUse" } });
const toolResult = (id: string): BranchEntry => ({ id, type: "message", message: { role: "toolResult", content: [{ type: "text", text: "out" }] } });
const custom = (id: string): BranchEntry => ({ id, type: "custom_message" });

const branch = [user("u1", "hi"), reply("a1"), user("u2", "do it"), toolAsk("a2"), toolResult("r2"), reply("a3"), custom("c1"), user("u3", "classifier bait"), reply("a4")];

describe("rewindKind", () => {
  test("user messages and turn-ending replies are checkpoints", () => {
    expect(rewindKind(user("u", "x"))).toBe("user");
    expect(rewindKind(reply("a"))).toBe("assistant");
  });
  test("tool-calling replies, tool results and custom entries are not", () => {
    expect(rewindKind(toolAsk("a"))).toBeUndefined();
    expect(rewindKind(toolResult("r"))).toBeUndefined();
    expect(rewindKind(custom("c"))).toBeUndefined();
  });
});

describe("planRewind", () => {
  test("assistant target keeps the reply and drops what follows", () => {
    expect(planRewind(branch, "a3")).toEqual({ ok: true, targetId: "a3", kind: "assistant", dropped: 3 });
  });
  test("user target drops the message itself and hands its text back", () => {
    expect(planRewind(branch, "u3")).toEqual({ ok: true, targetId: "u3", kind: "user", dropped: 2, editorText: "classifier bait" });
  });
  test("accepts a #-prefixed id", () => {
    expect(planRewind(branch, "#a1")).toMatchObject({ ok: true, targetId: "a1", dropped: 7 });
  });
  test("refuses the current leaf", () => {
    expect(planRewind(branch, "a4")).toMatchObject({ ok: false });
  });
  test("refuses entries off the active branch", () => {
    expect(planRewind(branch, "elsewhere")).toMatchObject({ ok: false, error: expect.stringContaining("not on the active branch") });
  });
  test("refuses mid-turn targets", () => {
    expect(planRewind(branch, "a2")).toMatchObject({ ok: false });
    expect(planRewind(branch, "r2")).toMatchObject({ ok: false });
  });
  test("refuses an empty id", () => {
    expect(planRewind(branch, "  ")).toMatchObject({ ok: false, error: expect.stringContaining("Usage") });
  });
});
