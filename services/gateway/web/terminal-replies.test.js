import assert from "node:assert/strict";
import test from "node:test";
import { TerminalReplyGate } from "./terminal-replies.js";

test("allows one DA1 reply per query and drops restty's duplicate", () => {
  const gate = new TerminalReplyGate();
  gate.observeOutput("redraw\x1b[");
  gate.observeOutput("cafter");
  gate.observeOutput("later redraw"); // must not count the completed query twice

  assert.equal(gate.allowInput("\x1b[?1;2c"), true);
  assert.equal(gate.allowInput("\x1b[?1;2c"), false);
});

test("preserves ordinary input and one reply for every real query", () => {
  const gate = new TerminalReplyGate();
  gate.observeOutput("\x1b[c\x1b[0c");

  assert.equal(gate.allowInput("x"), true);
  assert.equal(gate.allowInput("\x1b[?1;2c"), true);
  assert.equal(gate.allowInput("\x1b[?64;1;2c"), true);
  assert.equal(gate.allowInput("\x1b[?1;2c"), false);
});
