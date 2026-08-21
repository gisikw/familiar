import { describe, expect, test } from "bun:test";
import { notifyDroppedFile } from "../src/upload.ts";

describe("upload Presence compatibility ingress", () => {
  test("sends the dropped path through the existing pi relay", async () => {
    let delivered = "";
    const result = await notifyDroppedFile("/private/drop.png", (message) => {
      delivered = message;
      return true;
    });
    expect(result).toEqual({ notified: true });
    expect(delivered).toBe("[file dropped: /private/drop.png]");
  });

  test("diagnoses a disconnected relay without claiming delivery", async () => {
    const result = await notifyDroppedFile("/private/drop.png", () => false);
    expect(result.notified).toBe(false);
    expect(result.error).toContain("no connected pi subscriber");
  });
});
