import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Browser PTY command/session selection is kept dependency-free so its
// contracts can be unit tested without loading native node-pty.
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PtySessionError extends Error {
  constructor(message: string, public statusCode: 400 | 404) { super(message); }
}

export function resolvePresenceSocket(sessionId?: string, role: "primary" | "fork" = "primary"): string {
  if (sessionId && !UUID.test(sessionId)) throw new PtySessionError("invalid session id", 400);
  if (!sessionId || role === "primary") {
    const state = process.env.FAMILIAR_PRESENCE_STATE_DIR || path.join(REPOSITORY_ROOT, "state/presence");
    return process.env.FAMILIAR_PRESENCE_SOCKET || path.join(state, "tmux.sock");
  }
  const stateDir = process.env.FAMILIAR_STATE_DIR;
  if (!stateDir) throw new PtySessionError("fork state directory is unavailable", 404);
  const root = path.join(stateDir, "forks", sessionId);
  try {
    if (!fs.lstatSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new PtySessionError("fork session not found", 404);
  }
  return path.join(root, "presence", "tmux.sock");
}

export function attachCommand(): { file: string; args: string[] } {
  const raw = process.env.FAMILIAR_ATTACH_CMD;
  if (raw && raw.trim()) {
    // Split on whitespace — attach invocations are simple argv, no quoting.
    const parts = raw.trim().split(/\s+/);
    return { file: parts[0], args: parts.slice(1) };
  }
  return { file: process.env.FAMILIAR_VIEWER_BIN || "familiar-viewer", args: [] };
}
