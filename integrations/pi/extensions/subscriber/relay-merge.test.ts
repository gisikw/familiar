import { afterEach, expect, test } from "bun:test";
import { IMP_BRANCH_HANDLER } from "../imp/ingress.mjs";
import { PendingEchoes } from "./echo.ts";
import { RelayClient } from "./relay.ts";

afterEach(() => { delete (process as any)[IMP_BRANCH_HANDLER]; });

test("a relay merge command invokes the Imp operator merge path", () => {
  const calls: unknown[] = [];
  (process as any)[IMP_BRANCH_HANDLER] = {
    operatorMerge(quiet: boolean) { calls.push(quiet); },
  };
  const client = new RelayClient({} as any, new PendingEchoes());

  client.enact({ type: "merge", quiet: true });
  client.enact({ type: "merge" });

  expect(calls).toEqual([true, false]);
});
