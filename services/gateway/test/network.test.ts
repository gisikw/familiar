import { describe, expect, test } from "bun:test";
import { isLoopbackHost, requireSafeGatewayHost } from "../src/network.ts";

describe("gateway bind safety", () => {
  test("accepts loopback address forms", () => {
    for (const host of ["localhost", "127.0.0.1", "127.42.0.9", "::1", "[::1]", "::ffff:127.0.0.1"]) {
      expect(isLoopbackHost(host)).toBe(true);
      expect(() => requireSafeGatewayHost(host, false)).not.toThrow();
    }
  });

  test("rejects non-loopback hosts unless explicitly allowed", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "gateway.example.invalid"]) {
      expect(isLoopbackHost(host)).toBe(false);
      expect(() => requireSafeGatewayHost(host, false)).toThrow("refusing unauthenticated non-loopback");
      expect(() => requireSafeGatewayHost(host, true)).not.toThrow();
    }
  });
});
