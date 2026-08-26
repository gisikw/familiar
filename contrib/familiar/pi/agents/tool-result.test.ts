/* Tests for pi's custom-tool error contract as enforced by run()/result().
 *
 * pi marks a tool result failed (isError: true, reported to the model) ONLY when
 * execute() THROWS. The old wrapper returned an `isError` property instead,
 * which pi ignores — so failures looked like successes. These tests pin the
 * corrected contract: failures throw (with the useful message intact) and
 * successes return the full structured result.
 *
 * Run: bun test contrib/familiar/pi/agents/tool-result.test.ts
 */
import { test, expect } from "bun:test";
import { run, result } from "./tool-result.ts";

test("result() returns the full structured value (model sees complete JSON)", () => {
  const value = { ok: true, id: "j1", nested: { a: 1 } };
  const r = result(value);
  expect(r.details).toBe(value);
  expect(JSON.parse(r.content[0].text)).toEqual(value);
  // The model-facing content is the complete, untruncated value.
  expect(r.content[0].text).toBe(JSON.stringify(value, null, 2));
});

test("run(): success resolves to the full result (no isError property)", async () => {
  const value = { state: "done" };
  const r = await run(async () => value);
  expect(r.details).toBe(value);
  expect(r).not.toHaveProperty("isError"); // we no longer fabricate isError
});

test("run(): failure THROWS (so pi marks the result failed), preserving the message", async () => {
  await expect(run(async () => {
    throw new Error("golemd 404: job j1 not found");
  })).rejects.toThrow("golemd 404: job j1 not found");
});

test("run(): failure throws even though it must NOT be swallowed as a success", async () => {
  // The old behavior returned {ok:false,error,isError:true} and resolved. The
  // corrected behavior rejects — pi only sets isError for a thrown error.
  let threw = false;
  try {
    await run(async () => {
      throw new Error("harness claude-code is not advertised");
    });
  } catch (e) {
    threw = true;
    expect((e as Error).message).toBe("harness claude-code is not advertised");
  }
  expect(threw).toBe(true);
});

test("run(): non-Error rejections are normalized to an Error with a message", async () => {
  await expect(run(async () => {
    throw "something went wrong"; // a raw string, not an Error
  })).rejects.toThrow("something went wrong");
});
