import net from "node:net";

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (net.isIPv4(normalized)) return normalized.startsWith("127.");
  if (net.isIPv6(normalized)) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
    return mapped !== undefined && net.isIPv4(mapped) && mapped.startsWith("127.");
  }
  return false;
}

export function requireSafeGatewayHost(host: string, allowNonLoopback: boolean): void {
  if (!isLoopbackHost(host) && !allowNonLoopback) {
    throw new Error(`refusing unauthenticated non-loopback gateway bind ${JSON.stringify(host)}; set FAMILIAR_GATEWAY_ALLOW_NONLOOPBACK=1 only behind an authenticated network boundary`);
  }
}
