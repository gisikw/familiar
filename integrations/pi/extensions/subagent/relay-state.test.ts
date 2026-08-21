import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  commitRelay,
  reconcilePassClaims,
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

  test("restart reconciles both settlement and blocked-interrupt claims", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pass-"));
    const relayed = path.join(dir, "relayed-7");
    const blocked = path.join(dir, "blocked-7");
    expect(takeRelayClaim(relayed)).toBe(true);
    expect(takeRelayClaim(blocked)).toBe(true);
    reconcilePassClaims(dir, 7);
    expect(fs.existsSync(relayClaimPath(relayed))).toBe(false);
    expect(fs.existsSync(relayClaimPath(blocked))).toBe(false);
    expect(takeRelayClaim(blocked)).toBe(true); // blocked question can retry
    releaseRelayClaim(blocked);
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
