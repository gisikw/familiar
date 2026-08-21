import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  commitRelay,
  reconcileRelayClaim,
  relayClaimPath,
  releaseRelayClaim,
  takeRelayClaim,
} from "./relay-state.ts";

const marker = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-state-")), "relayed-1");

describe("recoverable relay ownership", () => {
  test("process death after claim never looks committed; restart can retry", () => {
    const m = marker();
    expect(takeRelayClaim(m)).toBe(true);
    expect(fs.existsSync(m)).toBe(false);
    expect(takeRelayClaim(m)).toBe(false);
    reconcileRelayClaim(m); // bootstrap after owner process died
    expect(fs.existsSync(relayClaimPath(m))).toBe(false);
    expect(takeRelayClaim(m)).toBe(true);
    releaseRelayClaim(m);
  });

  test("only explicit post-acceptance commit creates terminal ownership", () => {
    const m = marker();
    expect(takeRelayClaim(m)).toBe(true);
    // Simulated sink rejection/send throw: release without commit.
    releaseRelayClaim(m);
    expect(fs.existsSync(m)).toBe(false);
    // Simulated durable sink acceptance/successful direct send.
    expect(takeRelayClaim(m)).toBe(true);
    commitRelay(m);
    releaseRelayClaim(m);
    expect(fs.existsSync(m)).toBe(true);
    expect(takeRelayClaim(m)).toBe(true); // caller rechecks terminal under lock
    commitRelay(m); // idempotent retry
    releaseRelayClaim(m);
  });
});
