import { describe, expect, test } from "bun:test";
import { completeHandoff } from "./request.ts";
const rejection = "Unsupported value: 'none' is not supported with the 'gpt-6-astra' model. Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'";

describe("handoff reasoning fallback", () => {
  test("retries returned provider rejection once at low", async () => {
    const levels: (string | undefined)[] = [];
    const result = await completeHandoff(async reasoning => {
      levels.push(reasoning);
      return reasoning ? { stopReason: "stop", errorMessage: undefined } : { stopReason: "error", errorMessage: rejection };
    }, new AbortController().signal);
    expect(levels).toEqual([undefined, "low"]);
    expect(result.stopReason).toBe("stop");
  });
  test("retries thrown provider rejection", async () => {
    const levels: (string | undefined)[] = [];
    await completeHandoff(async reasoning => { levels.push(reasoning); if (!reasoning) throw new Error(rejection); return {stopReason:"stop"}; }, new AbortController().signal);
    expect(levels).toEqual([undefined,"low"]);
  });
  test("does not retry unrelated failures or successful responses", async () => {
    for (const response of [{stopReason:"stop"}, {stopReason:"error",errorMessage:"rate limit"}, {stopReason:"aborted"}]) {
      let calls=0;
      expect(await completeHandoff(async () => {calls++;return response;},new AbortController().signal)).toBe(response);
      expect(calls).toBe(1);
    }
  });
  test("does not retry after cancellation", async () => {
    const controller=new AbortController();let calls=0;
    await completeHandoff(async () => {calls++;controller.abort();return {stopReason:"error",errorMessage:rejection};},controller.signal);
    expect(calls).toBe(1);
  });
  test("fallback failure is returned without another retry", async () => {
    let calls=0;
    const result=await completeHandoff(async () => {calls++;return {stopReason:"error",errorMessage:rejection};},new AbortController().signal);
    expect(calls).toBe(2);expect(result.stopReason).toBe("error");
  });
});
