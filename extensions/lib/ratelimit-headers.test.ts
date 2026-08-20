// ratelimit-headers.test.ts. Run:
//   nix develop .#stt -c bun test extensions/lib/ratelimit-headers.test.ts
import { expect, test, describe } from "bun:test";
import { selectRatelimitHeaders } from "./ratelimit-headers.ts";

describe("selectRatelimitHeaders", () => {
  test("selects the full anthropic-ratelimit-unified-* set + request-id (real 2.1.197 shape)", () => {
    const upstream = {
      "content-type": "text/event-stream",
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.3",
      "anthropic-ratelimit-unified-7d-utilization": "0.66",
      "anthropic-ratelimit-unified-5h-reset": "1787275200",
      "request-id": "req_011CeEk6dhDMM5UviDaULQjH",
      "x-should-not-appear": "nope",
    };
    const out = selectRatelimitHeaders(upstream);
    expect(out["anthropic-ratelimit-unified-status"]).toBe("allowed");
    expect(out["anthropic-ratelimit-unified-5h-utilization"]).toBe("0.3");
    expect(out["anthropic-ratelimit-unified-7d-utilization"]).toBe("0.66");
    expect(out["request-id"]).toBe("req_011CeEk6dhDMM5UviDaULQjH");
    expect(out["x-should-not-appear"]).toBeUndefined();
    expect(out["content-type"]).toBeUndefined();
  });

  test("captures retry-after on a 429", () => {
    const out = selectRatelimitHeaders({ "retry-after": "42", "anthropic-ratelimit-unified-status": "rejected" });
    expect(out["retry-after"]).toBe("42");
    expect(out["anthropic-ratelimit-unified-status"]).toBe("rejected");
  });

  test("case-insensitive keys, joins array values", () => {
    const out = selectRatelimitHeaders({ "Anthropic-RateLimit-Unified-Status": "allowed", "Retry-After": ["1", "2"] as any });
    expect(out["anthropic-ratelimit-unified-status"]).toBe("allowed");
    expect(out["retry-after"]).toBe("1,2");
  });

  test("empty when nothing relevant", () => {
    expect(selectRatelimitHeaders({ "content-type": "application/json" })).toEqual({});
  });
});
