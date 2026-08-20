const os = require("os");
const pty = require("node-pty");

// Resolve the user's login shell. Honor $SHELL; fall back sensibly per-platform.
function resolveShell() {
  if (process.env.SHELL) return process.env.SHELL;
  if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
  return "/bin/bash";
}

// Spawn a login, interactive shell in a real PTY. Login (`-l`) so the user's
// normal environment (paths, ssh-agent, etc.) is present — Kevin sshes out of
// this shell, so this needs to behave exactly like his terminal's shell.
function spawn({ cols, rows, onData, onExit }) {
  const shell = resolveShell();
  const shellName = shell.split("/").pop();

  const isWin = process.platform === "win32";
  const args = isWin ? [] : ["-l"];

  const child = pty.spawn(shell, args, {
    name: "xterm-256color",
    cols: cols || 80,
    rows: rows || 24,
    cwd: os.homedir(),
    env: {
      ...process.env,
      TERM: "xterm-256color",
      // Advertise the app so shells/tmux can special-case if desired.
      TERM_PROGRAM: "Familiar",
      COLORTERM: "truecolor",
    },
  });

  child.onData(onData);
  child.onExit(onExit);

  return {
    proc: child,
    shellName,
    write: (data) => child.write(data),
  };
}

function resize(handle, cols, rows) {
  try {
    handle.proc.resize(Math.max(1, cols | 0), Math.max(1, rows | 0));
  } catch (_) {
    /* pty may have exited */
  }
}

function kill(handle) {
  try {
    handle.proc.kill();
  } catch (_) {
    /* already gone */
  }
}

module.exports = { spawn, resizePty: resize, killPty: kill };
