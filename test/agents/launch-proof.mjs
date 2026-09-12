// Isolated real-Herdr evidence for the Familiar Agents launch failure.
//
// This is an operator/test harness, not Familiar behaviour. It starts a private
// Herdr 0.9 namespace (own HOME/XDG, own named session, own config) and records
// the semantics the Owner's reconciliation depends on, plus the NODE-side fix:
//
//   1. `workspace.create` env reaches the pane process, but the interactive
//      shell's startup files re-export PATH, so an environment handed to a
//      workspace does not survive to `agent.start` (the live failure);
//   2. `agent.start --kind pi` then leaves a permanent placeholder carrying the
//      requested name, `launch_pending: true`, `agent_status: "unknown"` and no
//      `agent` kind, while the pane shows `command not found` and keeps the
//      shell as its own foreground process. That name cannot be relaunched or
//      renamed; only closing the workspace releases it — which is exactly what
//      the Owner's launch-pending/failed reconciliation and cleanup assume;
//   3. with the NODE's own trusted shell initialisation supplying the canonical
//      runtime to every agent pane, `agent.start` reaches a real interactive Pi
//      agent with a single `pi` foreground process — while Familiar sends no
//      environment of its own. That node-side change lives on the Drover node,
//      not in this repository.
//
// No resident Herdr namespace, service, profile or shell configuration is
// touched. Nothing here is a production process.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  launchPendingPlaceholder,
  agentObservation,
} from "../../integrations/pi/extensions/agents/contract.mjs";

const required = (name) => {
  const v = process.env[name];
  assert(v, `${name} is required (reference only, never a credential value)`);
  return v;
};
const herdrBinary = required("FA_PROOF_HERDR"); // pinned herdr 0.9.0
const piBinary = required("FA_PROOF_PI"); // the node runtime's pi executable
const shell = required("FA_PROOF_SHELL"); // the node's interactive shell
const root = mkdtempSync(join(tmpdir(), "fa-launch-proof-"));
console.log("Isolated launch-proof root:", root);
const home = join(root, "home");
mkdirSync(home, { recursive: true });
mkdirSync(join(root, "profile"), { recursive: true });
writeFileSync(
  join(root, "profile/settings.json"),
  JSON.stringify({ defaultProjectTrust: "never", lastChangelogVersion: "0.84.1" }),
);
mkdirSync(join(root, "config/herdr"), { recursive: true });

// The node runtime: ONE node-owned directory holding the agent execution
// runtime, and the node-owned pane-shell seam that puts it on PATH for every
// agent pane. On the fleet this is provisioned by Nix on the Drover node; here
// it is a disposable stand-in with the same shape.
const runtime = join(root, "node-runtime");
mkdirSync(join(runtime, "bin"), { recursive: true });
symlinkSync(piBinary, join(runtime, "bin/pi"));
const nodeRc = join(runtime, "agent-shellrc");
writeFileSync(
  nodeRc,
  `# Node-owned; runs AFTER the system and user startup files own PATH.\n` +
    `[ -r /etc/bashrc ] && . /etc/bashrc\n` +
    `[ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n` +
    `case ":$PATH:" in *:${join(runtime, "bin")}:*) ;; *) PATH="${join(runtime, "bin")}:$PATH";; esac\n` +
    `export PATH\n`,
);
const nodeShell = join(runtime, "agent-shell");
writeFileSync(nodeShell, `#!/bin/sh\nexec ${shell} --rcfile ${nodeRc} "$@"\n`);
chmodSync(nodeShell, 0o755);

const seam = process.env.FA_PROOF_NODE_RUNTIME === "0" ? null : nodeShell;
writeFileSync(
  join(root, "config/herdr/config.toml"),
  `[terminal]\ndefault_shell = ${JSON.stringify(shell)}\n`,
);
const session = "fa-launch-proof";
const socket = join(root, `config/herdr/sessions/${session}/herdr.sock`);
function startServer(defaultShell) {
  writeFileSync(
    join(root, "config/herdr/config.toml"),
    `[terminal]\ndefault_shell = ${JSON.stringify(defaultShell)}\n`,
  );
  return spawn(herdrBinary, ["--session", session, "server"], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_DATA_HOME: join(root, "data"),
      SHELL: shell,
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rpc(method, params = {}, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const c = createConnection(socket, () =>
      c.write(JSON.stringify({ id: "1", method, params }) + "\n"),
    );
    c.on("error", reject);
    c.on("data", (d) => {
      buffer += d;
      const i = buffer.indexOf("\n");
      if (i < 0) return;
      c.end();
      const m = JSON.parse(buffer.slice(0, i));
      if (m.error)
        reject(
          Object.assign(
            new Error(m.error.code ?? m.error.error?.code ?? "herdr error"),
            { body: m.error },
          ),
        );
      else resolve(m.result);
    });
    setTimeout(() => reject(new Error("timeout " + method)), timeoutMs);
  });
}
async function waitForSocket() {
  for (let i = 0; i < 200 && !existsSync(socket); i++) await sleep(100);
  assert(existsSync(socket), "isolated Herdr did not start");
  await sleep(500);
}
// Exactly what the Owner sends: semantic inputs only, no runtime, no PATH.
async function dedicatedPane(label) {
  const created = await rpc("workspace.create", {
    cwd: root,
    label,
    focus: false,
    env: {
      FAMILIAR_AGENT_EXPECTED_MODEL: "proof/model",
      PI_CODING_AGENT_DIR: join(root, "profile"),
      PATH: `${join(runtime, "bin")}:/usr/bin`, // enrolled best effort
    },
  });
  await sleep(1500);
  const { panes } = await rpc("pane.list", {
    workspace_id: created.workspace.workspace_id,
  });
  assert.equal(panes.length, 1, "dedicated pane expected");
  return { workspace: created.workspace.workspace_id, pane: panes[0].pane_id };
}
const nonce = "0123456789abcdef0123456789abcdef";
// Node-side evidence only. This script asks the NODE whether its trusted shell
// initialisation put the canonical runtime on PATH. Familiar itself never types
// this, or anything else, into an Agent pane, and never attests a pane PATH.
async function nodeRuntimeResolution(pane) {
  const info = (await rpc("pane.process_info", { pane_id: pane })).process_info;
  assert.equal(
    info.foreground_process_group_id,
    info.shell_pid,
    "expected an idle shell prompt",
  );
  await rpc("pane.send_input", {
    pane_id: pane,
    text: `printf 'NODE''-RUNTIME %s [%s]\\n' '${nonce}' "$(command -v pi)"`,
    keys: ["Enter"],
  });
  await sleep(1500);
  const { read } = await rpc("pane.read", {
    pane_id: pane,
    source: "recent",
    lines: 40,
  });
  const found = new RegExp(`NODE-RUNTIME ${nonce} \\[([^\\]]*)\\]`).exec(
    read.text.replace(/\r?\n/g, ""),
  );
  return found?.[1]?.startsWith("/") ? found[1] : null;
}
const failures = [];
const proof = async (name, fn) => {
  try {
    await fn();
    console.log("ok   -", name);
  } catch (error) {
    failures.push(name);
    console.log("FAIL -", name, "\n     ", error.message);
  }
};

// ---------------------------------------------------------------- live failure
let server = startServer(shell); // no node runtime seam
server.stderr.resume();
await waitForSocket();
const broken = await dedicatedPane("fa-proof-live-failure");
const brokenName = "fa-proof-broken";
await proof(
  "without the node seam the pane shell discards the workspace PATH",
  async () => {
    assert.equal(
      await nodeRuntimeResolution(broken.pane),
      null,
      "expected the pane shell to resolve nothing, exactly as live",
    );
  },
);
await proof(
  "agent.start then leaves an unreapable placeholder and command-not-found",
  async () => {
    const started = await rpc("agent.start", {
      name: brokenName,
      kind: "pi",
      pane_id: broken.pane,
      args: ["--version"],
      timeout_ms: 5000,
    });
    assert.ok(launchPendingPlaceholder(agentObservation(started.agent)));
    await sleep(1500);
    const { agents } = await rpc("agent.list", {});
    const found = agents.find((a) => a.name === brokenName);
    assert.ok(found, "placeholder expected in agent.list");
    assert.ok(
      launchPendingPlaceholder(agentObservation(found)),
      "expected a truthful pending placeholder with no agent kind",
    );
    const { read } = await rpc("pane.read", {
      pane_id: broken.pane,
      source: "recent",
      lines: 20,
    });
    assert.match(read.text, /command not found/);
    const info = (await rpc("pane.process_info", { pane_id: broken.pane }))
      .process_info;
    assert.equal(
      info.foreground_process_group_id,
      info.shell_pid,
      "a failed startup leaves the pane at its own shell",
    );
    // The pane is still only the shell: no harness process was ever created.
    assert.deepEqual(
      (info.foreground_processes ?? []).map((p) => p.pid),
      (info.foreground_processes ?? []).map(() => info.shell_pid),
    );
    await assert.rejects(
      rpc("agent.start", {
        name: brokenName,
        kind: "pi",
        pane_id: broken.pane,
        args: [],
        timeout_ms: 5000,
      }),
      /agent_name_taken/,
      "the burned name must not be silently relaunchable",
    );
    await assert.rejects(
      rpc("agent.rename", { target: broken.pane, name: null }),
      /agent_launch_pending/,
    );
  },
);
await proof("closing the workspace is what releases the name", async () => {
  await rpc("workspace.close", { workspace_id: broken.workspace });
  await sleep(1000);
  const { agents } = await rpc("agent.list", {});
  assert.equal(agents.filter((a) => a.name === brokenName).length, 0);
});
try {
  await rpc("server.stop", {});
} catch {}
server.kill("SIGTERM");
await sleep(1500);

// ------------------------------------------------------------- node remediated
rmSync(join(root, "config/herdr/sessions"), { recursive: true, force: true });
server = startServer(seam ?? shell);
server.stderr.resume();
await waitForSocket();
const fixed = await dedicatedPane("fa-proof-remediated");
await proof(
  "the node runtime seam makes the canonical executable resolvable in every pane",
  async () => {
    assert.equal(
      await nodeRuntimeResolution(fixed.pane),
      join(runtime, "bin/pi"),
    );
  },
);
await proof(
  "agent.start then reaches a real interactive Pi agent in that pane",
  async () => {
    await rpc("agent.start", {
      name: "fa-proof-fixed",
      kind: "pi",
      pane_id: fixed.pane,
      args: [],
      timeout_ms: 60000,
    });
    let observed = null;
    for (let i = 0; i < 30; i++) {
      await sleep(1500);
      const { agents } = await rpc("agent.list", {});
      const found = agents.find((a) => a.name === "fa-proof-fixed");
      if (!found) continue;
      const seen = agentObservation(found);
      // Exactly the Owner's own gate: a pending or not-yet-interactive agent is
      // never treated as launched, and is never prompted.
      if (!launchPendingPlaceholder(seen) && !seen.launch_pending && seen.interactive_ready) {
        observed = seen;
        break;
      }
    }
    assert.ok(observed, "the agent never became interactive");
    assert.equal(observed.agent, "pi");
    assert.equal(observed.pane_id, fixed.pane);
    assert.ok(
      ["idle", "working", "done"].includes(observed.agent_status),
      `unexpected agent status ${JSON.stringify(observed)}`,
    );
    const info = (await rpc("pane.process_info", { pane_id: fixed.pane }))
      .process_info;
    const foreground = (info.foreground_processes ?? [])[0];
    assert.ok(foreground, "the harness must own the pane foreground");
    assert.equal((info.foreground_processes ?? []).length, 1);
    assert.notEqual(info.foreground_process_group_id, info.shell_pid);
    assert.deepEqual(foreground.argv, ["pi"]);
  },
);
try {
  await rpc("server.stop", {});
} catch {}
server.kill("SIGTERM");
await sleep(500);
if (!process.env.FA_PROOF_KEEP) rmSync(root, { recursive: true, force: true });
if (failures.length) {
  console.error("launch proof failed:", failures.join("; "));
  process.exit(1);
}
console.log("Herdr 0.9 launch semantics and the node-side runtime fix recorded");
