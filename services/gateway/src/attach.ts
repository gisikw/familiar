// Browser PTY command selection is kept dependency-free so its default and
// test override contracts can be unit tested without loading native node-pty.
export function attachCommand(): { file: string; args: string[] } {
  const raw = process.env.FAMILIAR_ATTACH_CMD;
  if (raw && raw.trim()) {
    // Split on whitespace — attach invocations are simple argv, no quoting.
    const parts = raw.trim().split(/\s+/);
    return { file: parts[0], args: parts.slice(1) };
  }
  return { file: process.env.FAMILIAR_VIEWER_BIN || "familiar-viewer", args: [] };
}
