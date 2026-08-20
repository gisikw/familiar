// claude-cache-hygiene.test.ts — port of tiamat's cache/continuation wire
// hygiene tests (turn/claude_gateway_strip_coupling_test.go + relocate/strip
// behavior). These are the SPEC. Run:
//   nix develop .#stt -c bun test extensions/lib/claude-cache-hygiene.test.ts
import { expect, test, describe } from "bun:test";
import {
  relocateClaudeContinuationCacheControl,
  stripClaudeContinuationArtifacts,
  relocateBreakpointsBeforeCut,
  applyCacheHygiene,
  countCacheControlBlocks,
} from "./claude-cache-hygiene.ts";

const CONT = "<tool-result>Tool call complete. Results are above.</tool-result>";
const cc = () => ({ type: "ephemeral", ttl: "1h" });

function body(messages: any[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...extra, messages });
}
function msgs(b: string): any[] {
  return JSON.parse(b).messages;
}

describe("relocateClaudeContinuationCacheControl", () => {
  test("moves continuation-block cache_control onto the real tool_result", () => {
    const b = body([
      { role: "user", content: [{ type: "text", text: "orig" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "out" }] },
      { role: "assistant", content: [{ type: "text", text: "No response requested." }] },
      { role: "user", content: [{ type: "text", text: CONT, cache_control: cc() }] },
    ]);
    const { body: out, mutations } = relocateClaudeContinuationCacheControl(b);
    expect(mutations).toBe(1);
    const m = msgs(out);
    expect(m[2].content[0].cache_control).toEqual(cc()); // moved to tool_result
    expect(m[4].content[0].cache_control).toBeUndefined(); // removed from continuation
    // net breakpoint count unchanged
    expect(countCacheControlBlocks(m)).toBe(1);
  });

  test("no-op returns ORIGINAL bytes unchanged (determinism)", () => {
    const b = body([
      { role: "user", content: [{ type: "text", text: "hi", cache_control: cc() }] },
      { role: "assistant", content: [{ type: "text", text: "yo" }] },
    ]);
    const { body: out, mutations } = relocateClaudeContinuationCacheControl(b);
    expect(mutations).toBe(0);
    expect(out).toBe(b); // byte-identical, not reserialized
  });
});

// Port of TestStripCouplesRelocationAcrossShapes: strip-without-relocate is
// unreachable — for every accepted shape, any breakpoint that would be deleted
// is relocated onto the nearest surviving block; the anchor is never orphaned
// and the count never exceeds 4.
describe("stripClaudeContinuationArtifacts couples relocation across shapes", () => {
  const cases: { name: string; messages: any[]; wantStrip: number; wantAnchor: boolean }[] = [
    {
      name: "breakpoint_on_continuation_block (already-handled shape)",
      messages: [
        { role: "user", content: [{ type: "text", text: "orig" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "out" }] },
        { role: "assistant", content: [{ type: "text", text: "No response requested." }] },
        { role: "user", content: [{ type: "text", text: CONT, cache_control: cc() }] },
      ],
      wantStrip: 2, wantAnchor: true,
    },
    {
      name: "breakpoint_on_tool_result (survives; must remain)",
      messages: [
        { role: "user", content: [{ type: "text", text: "orig" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "out", cache_control: cc() }] },
        { role: "assistant", content: [{ type: "text", text: "No response requested." }] },
        { role: "user", content: [{ type: "text", text: CONT }] },
      ],
      wantStrip: 2, wantAnchor: true,
    },
    {
      name: "breakpoint_on_assistant_bridge (removed; must relocate)",
      messages: [
        { role: "user", content: [{ type: "text", text: "orig" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "out" }] },
        { role: "assistant", content: [{ type: "text", text: "No response requested.", cache_control: cc() }] },
        { role: "user", content: [{ type: "text", text: CONT }] },
      ],
      wantStrip: 2, wantAnchor: true,
    },
    {
      name: "multiblock_continuation_not_stripped (predicate rejects; no orphaning)",
      messages: [
        { role: "user", content: [{ type: "text", text: "orig" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "out" }] },
        { role: "assistant", content: [{ type: "text", text: "No response requested." }] },
        { role: "user", content: [{ type: "text", text: CONT }, { type: "text", text: "extra", cache_control: cc() }] },
      ],
      wantStrip: 0, wantAnchor: true,
    },
    {
      name: "breakpoint_on_prior_surviving_user_block (already safe; unchanged)",
      messages: [
        { role: "user", content: [{ type: "text", text: "orig", cache_control: cc() }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "out" }] },
        { role: "assistant", content: [{ type: "text", text: "No response requested." }] },
        { role: "user", content: [{ type: "text", text: CONT }] },
      ],
      wantStrip: 2, wantAnchor: true,
    },
  ];

  for (const tc of cases) {
    test(tc.name, () => {
      const { body: out, strips } = stripClaudeContinuationArtifacts(body(tc.messages));
      expect(strips).toBe(tc.wantStrip);
      const m = msgs(out);
      if (tc.wantAnchor) expect(countCacheControlBlocks(m)).toBeGreaterThan(0);
      expect(countCacheControlBlocks(m)).toBeLessThanOrEqual(4); // Anthropic max-4
    });
  }
});

describe("applyCacheHygiene (coupled relocate-then-strip)", () => {
  test("real 2.1.197 artifact shape: relocate onto tool_result, strip tail, anchor on stable prefix", () => {
    // This mirrors the captured upstream body: assistant 'No response requested.'
    // + user continuation+CC tail after a tool_result.
    const b = body([
      { role: "user", content: [{ type: "text", text: "sys-reminder" }, { type: "text", text: "weather in Paris?" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_x", name: "mcp__pi__weather_now", input: { city: "Paris" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "sunny 42" }, { type: "text", text: CONT }] },
      { role: "assistant", content: [{ type: "text", text: "No response requested." }] },
      { role: "user", content: [{ type: "text", text: CONT, cache_control: cc() }] },
    ], { model: "claude-opus-4-8", system: [{ type: "text", text: "sys", cache_control: cc() }] });

    const { body: out, cacheRewrites, strips } = applyCacheHygiene(b);
    expect(cacheRewrites).toBe(1); // continuation CC relocated onto the tool_result
    expect(strips).toBe(2); // artifact tail removed
    const m = msgs(out);
    // Leaf is now the real tool_result message, carrying the cache anchor.
    expect(m).toHaveLength(3);
    const leaf = m[m.length - 1];
    expect(leaf.role).toBe("user");
    const tr = leaf.content.find((c: any) => c.type === "tool_result");
    expect(tr.cache_control).toEqual(cc()); // anchor on the STABLE prefix
    // Message-content breakpoint count stays 1 (system CC is separate).
    expect(countCacheControlBlocks(m)).toBe(1);
    // System array breakpoint is untouched (hygiene never touches system/tools).
    expect(JSON.parse(out).system[0].cache_control).toEqual(cc());
  });

  test("stable-prefix anchoring: prefix bytes identical across two projected turns", () => {
    // Turn N and turn N+1 share the same stable prefix (system + earlier
    // messages). After hygiene, the shared prefix must be byte-identical so the
    // cache hits. We assert the serialized prefix (everything up to the last
    // user message) matches.
    const prefix = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const turnN = body([...prefix, { role: "user", content: [{ type: "text", text: "q1" }] }]);
    const turnN1 = body([...prefix, { role: "user", content: [{ type: "text", text: "q2" }] }]);
    // No artifact tails → both pass through unchanged (determinism).
    expect(applyCacheHygiene(turnN).body).toBe(turnN);
    expect(applyCacheHygiene(turnN1).body).toBe(turnN1);
    // The shared prefix serialization is identical.
    const pfxN = JSON.stringify(msgs(applyCacheHygiene(turnN).body).slice(0, 2));
    const pfxN1 = JSON.stringify(msgs(applyCacheHygiene(turnN1).body).slice(0, 2));
    expect(pfxN).toBe(pfxN1);
  });

  test("idempotent: applying hygiene twice yields the same bytes", () => {
    const b = body([
      { role: "user", content: [{ type: "text", text: "orig" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "out" }] },
      { role: "assistant", content: [{ type: "text", text: "No response requested." }] },
      { role: "user", content: [{ type: "text", text: CONT, cache_control: cc() }] },
    ]);
    const once = applyCacheHygiene(b).body;
    const twice = applyCacheHygiene(once).body;
    expect(twice).toBe(once);
  });
});

describe("max-4 breakpoint invariant under relocation", () => {
  test("relocateBreakpointsBeforeCut never increases total breakpoints", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "a", cache_control: cc() }] },
      { role: "assistant", content: [{ type: "text", text: "b", cache_control: cc() }] },
      { role: "user", content: [{ type: "text", text: "c", cache_control: cc() }] },
      { role: "assistant", content: [{ type: "text", text: "removed1", cache_control: cc() }] },
      { role: "user", content: [{ type: "text", text: "removed2", cache_control: cc() }] },
    ];
    const before = countCacheControlBlocks(messages);
    relocateBreakpointsBeforeCut(messages, 3); // cut removes last 2
    const survivors = messages.slice(0, 3);
    // survivors still have their 3 anchors; nearest-surviving already had one so
    // removed breakpoints are dropped (merged), not added.
    expect(countCacheControlBlocks(survivors)).toBeLessThanOrEqual(before);
    expect(countCacheControlBlocks(survivors)).toBeLessThanOrEqual(4);
  });
});
