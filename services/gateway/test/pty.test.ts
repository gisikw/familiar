// Run with: node --experimental-transform-types --test test/pty.test.ts
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { attachCommand } from "../src/attach.ts";

const savedAttach = process.env.FAMILIAR_ATTACH_CMD;
const savedViewer = process.env.FAMILIAR_VIEWER_BIN;

afterEach(() => {
  if (savedAttach === undefined) delete process.env.FAMILIAR_ATTACH_CMD;
  else process.env.FAMILIAR_ATTACH_CMD = savedAttach;
  if (savedViewer === undefined) delete process.env.FAMILIAR_VIEWER_BIN;
  else process.env.FAMILIAR_VIEWER_BIN = savedViewer;
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
