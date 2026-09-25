// Run with: node --experimental-transform-types --test test/pty.test.ts
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attachCommand, resolvePresenceSocket } from "../src/attach.ts";

const savedAttach = process.env.FAMILIAR_ATTACH_CMD;
const savedViewer = process.env.FAMILIAR_VIEWER_BIN;
const savedState = process.env.FAMILIAR_STATE_DIR;

afterEach(() => {
  if (savedAttach === undefined) delete process.env.FAMILIAR_ATTACH_CMD;
  else process.env.FAMILIAR_ATTACH_CMD = savedAttach;
  if (savedViewer === undefined) delete process.env.FAMILIAR_VIEWER_BIN;
  else process.env.FAMILIAR_VIEWER_BIN = savedViewer;
  if (savedState === undefined) delete process.env.FAMILIAR_STATE_DIR;
  else process.env.FAMILIAR_STATE_DIR = savedState;
});

test("default attach runs familiar-viewer directly", () => {
  delete process.env.FAMILIAR_ATTACH_CMD;
  delete process.env.FAMILIAR_VIEWER_BIN;
  assert.deepEqual(attachCommand(), { file: "familiar-viewer", args: [] });
});

test("packaging can select an absolute viewer binary", () => {
  delete process.env.FAMILIAR_ATTACH_CMD;
  process.env.FAMILIAR_VIEWER_BIN = "/nix/store/example/bin/familiar-viewer";
  assert.deepEqual(attachCommand(), {
    file: "/nix/store/example/bin/familiar-viewer",
    args: [],
  });
});

test("FAMILIAR_ATTACH_CMD remains the highest-priority test override", () => {
  process.env.FAMILIAR_VIEWER_BIN = "/ignored/familiar-viewer";
  process.env.FAMILIAR_ATTACH_CMD = "  /bin/bash --norc  ";
  assert.deepEqual(attachCommand(), { file: "/bin/bash", args: ["--norc"] });
});

test("fork PTY resolution rejects malformed and absent ids", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-pty-"));
  process.env.FAMILIAR_STATE_DIR = root;
  try {
    assert.throws(() => resolvePresenceSocket("../../primary", "fork"), /invalid session id/);
    assert.throws(() => resolvePresenceSocket("11111111-1111-4111-8111-111111111111", "fork"), /not found/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("fork PTY resolution selects its private Presence socket", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-pty-"));
  const id = "11111111-1111-4111-8111-111111111111";
  fs.mkdirSync(path.join(root, "forks", id), { recursive: true });
  process.env.FAMILIAR_STATE_DIR = root;
  try {
    assert.equal(resolvePresenceSocket(id, "fork"), path.join(root, "forks", id, "presence", "tmux.sock"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
