import { describe, expect, test } from "bun:test";
import { BoundedBody, BodyLimitError } from "./bounded-body.ts";

describe("BoundedBody", () => {
  test("accepts exact boundary across chunks", () => {
    const b = new BoundedBody(5); b.push(Buffer.from("ab")); b.push(Buffer.from("cde"));
    expect(b.finish().toString()).toBe("abcde"); expect(b.size).toBe(5);
  });
  test("rejects before retaining an over-boundary chunk and clears retained private data", () => {
    const b = new BoundedBody(5); b.push(Buffer.from("abcd"));
    expect(() => b.push(Buffer.from("ef"))).toThrow(BodyLimitError);
    expect(b.size).toBe(0); expect(b.finish().length).toBe(0);
  });
  test("rejects a single oversized chunk", () => {
    expect(() => new BoundedBody(1).push(Buffer.alloc(2))).toThrow(/exceeds 1 bytes/);
  });
});
