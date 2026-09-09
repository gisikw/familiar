// Isolated real foreground Familiar + production Transport proof. See README.md.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createConnection } from "node:net";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  unlinkSync,
  openSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { projection } from "../../integrations/pi/extensions/agents/contract.mjs";
import {
  ensureDirs,
  worklistPaths,
  listItems,
} from "../../integrations/pi/extensions/worklist/store.ts";

const familiar = fileURLToPath(new URL("../..", import.meta.url));
const drover =
  process.env.FA_PROOF_DROVER_REPO || resolve(familiar, "../drover");
const ui = process.env.FA_PROOF_UI_REPO || resolve(familiar, "../familiar-ui");
function required(name) {
  assert(
    process.env[name],
    `${name} is required; supply configuration/reference, never paste credentials`,
  );
  return process.env[name];
}
const herdr = required("FA_PROOF_HERDR");
const python = required("FA_PROOF_PYTHON");
const controllerPi = required("FA_PROOF_CONTROLLER_PI");
const script = required("FA_PROOF_SCRIPT");
const shell = required("FA_PROOF_SHELL");
const sshd = required("FA_PROOF_SSHD");
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const model = `${required("FA_PROOF_PROVIDER")}/${required("FA_PROOF_MODEL")}`;
const root = mkdtempSync(join(tmpdir(), "familiar-agents-live-"));
console.log("Isolated proof root:", root);
const profile = join(root, "profile");
const controllerProfile = join(root, "controller-profile");
const socket = join(root, "config/herdr/sessions/fa-proof/herdr.sock");
const env = {
  PATH: required("FA_PROOF_WORKER_PATH"),
  HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"),
  SHELL: shell,
  TERM: "xterm-256color",
  LANG: "C.UTF-8",
  FAMILIAR_TIAMAT_URL: required("FA_PROOF_TIAMAT_URL"),
  FAMILIAR_TIAMAT_TOKEN_FILE: required("FA_PROOF_TIAMAT_TOKEN_FILE"),
};
for (const path of [
  env.HOME,
  profile,
  controllerProfile,
  join(env.XDG_CONFIG_HOME, "herdr"),
])
  mkdirSync(path, { recursive: true, mode: 0o700 });
// NixOS interactive bash initialization can reset PATH. This test-owned HOME
// selects an explicit runtime for each test profile; no account rc is changed.
writeFileSync(
  join(env.HOME, ".bashrc"),
  `if [[ "$PI_CODING_AGENT_DIR" == ${JSON.stringify(controllerProfile)} ]]; then export PATH=${JSON.stringify(dirname(controllerPi) + ":" + env.PATH)}; else export PATH=${JSON.stringify(env.PATH)}; fi\n`,
);
writeFileSync(
  join(env.XDG_CONFIG_HOME, "herdr/config.toml"),
  `onboarding = false\n[terminal]\ndefault_shell = ${JSON.stringify(shell)}\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n`,
);
const settings = (extensions) => ({
  lastChangelogVersion: "0.84.1",
  defaultProjectTrust: "yes",
  extensions,
  defaultProvider: process.env.FA_PROOF_PROVIDER,
  defaultModel: process.env.FA_PROOF_MODEL,
});
writeFileSync(
  join(profile, "settings.json"),
  JSON.stringify(
    settings([
      join(familiar, "integrations/pi/extensions/tiamat"),
      join(familiar, "test/agents/question.ts"),
    ]),
  ),
);
writeFileSync(
  join(controllerProfile, "settings.json"),
  JSON.stringify(
    settings([
      join(familiar, "integrations/pi/extensions/tiamat"),
      join(familiar, "test/agents/foreground.ts"),
      join(ui, "packages/extension/dist/index.js"),
    ]),
  ),
);
const repo = join(root, "repo O'Brien");
mkdirSync(repo);
execFileSync("git", ["init", "-q", repo]);
execFileSync("git", [
  "-C",
  repo,
  "-c",
  "user.name=proof",
  "-c",
  "user.email=proof@example.invalid",
  "commit",
  "-qm",
  "initial",
  "--allow-empty",
]);
const worklist = worklistPaths(join(root, "worklist"));
ensureDirs(worklist);
const dbPath = join(root, "controller-ledger/agents.sqlite3");
function jobs() {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT data FROM jobs ORDER BY rowid DESC")
      .all()
      .map((row) => JSON.parse(row.data));
  } finally {
    db.close();
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const client = createConnection(socket);
    let raw = "";
    const timer = setTimeout(
      () => client.destroy(new Error("test RPC deadline")),
      20000,
    );
    client.on("connect", () =>
      client.write(JSON.stringify({ id: "proof", method, params }) + "\n"),
    );
    client.on("data", (b) => {
      raw += b;
      if (raw.length > 1048576)
        return client.destroy(new Error("test RPC bound"));
      if (!raw.includes("\n")) return;
      const result = JSON.parse(raw.split("\n")[0]);
      client.end();
      if (result.error) reject(new Error(`${method}: ${result.error.code}`));
      else resolve(result.result);
    });
    client.on("error", reject);
    client.on("close", () => clearTimeout(timer));
  });
}
function emptyAuth(profile) {
  const file = join(profile, "auth.json");
  // Pi may create an empty auth store on first birth. Non-empty credentials
  // here would be unexpected: this proof supplies only a token-file reference.
  return (
    !existsSync(file) ||
    Object.keys(JSON.parse(readFileSync(file, "utf8"))).length === 0
  );
}
function inferenceErrors() {
  const walk = (dir) =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory()
            ? walk(join(dir, e.name))
            : e.name.endsWith(".jsonl")
              ? [join(dir, e.name)]
              : [],
        )
      : [];
  const profiles = [
    profile,
    controllerProfile,
    ...jobs()
      .map((j) => j.remote_profile)
      .filter(Boolean),
  ];
  for (const p of new Set(profiles))
    for (const file of walk(join(p, "sessions"))) {
      for (const line of readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.type === "error" || event.message?.stopReason === "error")
          throw new Error("real inference streamed an error record");
      }
    }
}
async function until(label, predicate, ms = 180000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    inferenceErrors();
    const job = jobs()[0];
    if (await predicate(job)) {
      console.log(label, job?.job_id, job?.semantic_state, job?.reachability);
      return job;
    }
    await sleep(250);
  }
  throw new Error(
    `Timeout: ${label}; states=${JSON.stringify(jobs().map((j) => ({ id: j.job_id, phase: j.phase, state: j.semantic_state, error: j.last_error })))}`,
  );
}
let fixture,
  foreground,
  bootstrapped = false;
const request = {
  key: "proof",
  machine_id: "local-proof",
  harness: "pi",
  model,
  repo,
  requested_ref: "HEAD",
  label: "live foreground integration",
  task: "First call proof_question to get human approval. After approval create proof.txt containing exactly Familiar Agents real inference, test it with grep, and review it. Then run sleep 60 using bash to give the human time to interrupt. Do not write settlement yet: after interruption, wait for the human to explicitly tell you to finish and settle.",
};
writeFileSync(join(root, "request.json"), JSON.stringify(request));
async function birth() {
  if (!foreground) {
    const created = await rpc("workspace.create", {
      cwd: root,
      label: "Familiar foreground proof",
      focus: false,
      env: {
        PI_CODING_AGENT_DIR: controllerProfile,
        FAMILIAR_AGENTS_CONFIG: join(root, "agents-config.json"),
        FAMILIAR_AGENTS_STATE_DIR: join(root, "controller-ledger"),
        FAMILIAR_WORKLIST_DIR: join(root, "worklist"),
        FAMILIAR_UI_DESCRIPTOR: join(root, "controller-bridge.json"),
        FAMILIAR_UI_ATTACHMENT_DIR: join(root, "attachments"),
        FA_PROOF_ROOT: root,
      },
    });
    foreground = created.root_pane.pane_id;
  }
  await rpc("agent.start", {
    name: "foreground-proof",
    kind: "pi",
    pane_id: foreground,
    args: ["--familiar-agents-owner", "--continue", "--model", model],
    timeout_ms: 300000,
  });
  // agent.get reconciles managed startup; agent.list alone does not (pinned source).
  for (let i = 0; i < 300; i++) {
    const { agent } = await rpc("agent.get", { target: foreground });
    if (agent.interactive_ready) {
      console.log("Foreground birth:", agent.name);
      return;
    }
    await sleep(200);
  }
  throw new Error("foreground startup deadline");
}
const command = (text) =>
  rpc("agent.prompt", { target: foreground, text: "/" + text });
async function restart() {
  await command("proof-stop");
  for (let i = 0; i < 100; i++) {
    if (!(await rpc("agent.list")).agents.some((a) => a.pane_id === foreground))
      break;
    await sleep(100);
  }
  await birth();
}
async function bridgeSnapshot() {
  const d = JSON.parse(
    readFileSync(join(root, "controller-bridge.json"), "utf8"),
  );
  const response = await fetch(d.url + "/v1/events", {
    headers: { Authorization: "Bearer " + d.token, Origin: d.origin },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let raw = "";
  try {
    while (!raw.includes("\n\n")) {
      const result = await reader.read();
      raw += Buffer.from(result.value).toString("utf8");
    }
    return JSON.parse(
      raw
        .split("\n")
        .find((line) => line.startsWith("data: "))
        .slice(6),
    );
  } finally {
    await reader.cancel();
  }
}
try {
  execFileSync(herdr, ["--session", "fa-proof", "remote-client-bridge"], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 20000,
  });
  bootstrapped = true;
  execFileSync(herdr, ["integration", "install", "pi"], {
    env: { ...env, PI_CODING_AGENT_DIR: controllerProfile },
    stdio: "ignore",
  });
  writeFileSync(
    join(root, "fixture-input.json"),
    JSON.stringify({
      path: env.PATH,
      herdr,
      python,
      sshd,
      socket,
      model,
      worker_env: {
        PATH: env.PATH,
        FAMILIAR_TIAMAT_URL: env.FAMILIAR_TIAMAT_URL,
        FAMILIAR_TIAMAT_TOKEN_FILE: env.FAMILIAR_TIAMAT_TOKEN_FILE,
      },
    }),
  );
  const log = openSync(join(root, "fixture.log"), "w");
  fixture = spawn(
    python,
    [join(familiar, "test/agents/drover-fixture.py"), root, drover],
    { stdio: ["ignore", log, log] },
  );
  for (let i = 0; i < 300 && !existsSync(join(root, "fixture-ready")); i++) {
    assert.equal(fixture.exitCode, null, "fixture failed");
    await sleep(100);
  }
  assert(existsSync(join(root, "fixture-ready")), "fixture readiness");
  assert.equal((await rpc("ping")).protocol, 22);
  await birth();
  await command("proof-dispatch");
  let job = await until("blocked", (j) => j?.semantic_state === "blocked");
  assert(
    (await rpc("workspace.list")).workspaces.some(
      (w) => w.workspace_id === job.herdr_workspace_id && w.label === job.label,
    ),
  );
  const processInfo = (
    await rpc("pane.process_info", { pane_id: job.herdr_pane_id })
  ).process_info;
  assert.equal(processInfo.foreground_processes.length, 1);
  assert.equal(processInfo.foreground_processes[0].name, "pi");
  console.log("Actual foreground process:", JSON.stringify(processInfo));
  await rpc("workspace.focus", { workspace_id: job.herdr_workspace_id });
  try {
    execFileSync(
      "timeout",
      [
        "3",
        script,
        "-q",
        "-c",
        `stty rows 40 cols 140; exec ${shellQuote(herdr)} --session fa-proof`,
        join(root, "native-attach.log"),
      ],
      { env, stdio: "ignore", timeout: 7000 },
    );
  } catch (e) {
    if (e.status !== 124) throw e;
  }
  assert(
    readFileSync(join(root, "native-attach.log"), "utf8")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .includes("familiar/"),
  );
  console.log("Native Herdr attach sees the named workspace");
  const before = Date.now();
  await command("proof-ping");
  for (let i = 0; i < 100 && !existsSync(join(root, "foreground-ping")); i++)
    await sleep(20);
  assert(existsSync(join(root, "foreground-ping")));
  const latency = Date.now() - before;
  assert(latency < 2000);
  console.log("Foreground command latency ms:", latency);
  assert(
    (await bridgeSnapshot()).state.agents.jobs.some(
      (j) => j.job_id === job.job_id && j.semantic_state === "blocked",
    ),
  );
  console.log("Existing UI bridge projects the blocked job");
  await command("proof-answer");
  job = await until(
    "edited-running",
    (j) =>
      j?.remote_worktree &&
      existsSync(join(j.remote_worktree, "proof.txt")) &&
      j.semantic_state === "running",
  );
  await sleep(1500);
  await rpc("agent.send_keys", { target: job.herdr_pane_id, keys: ["esc"] });
  job = await until(
    "manual-interrupt-idle-unsettled",
    (j) => j?.semantic_state === "idle_unsettled",
  );
  assert.equal(job.settlement_json, null);
  const processes = (await rpc("pane.process_info", { pane_id: foreground }))
    .process_info.foreground_processes;
  assert.equal(processes.length, 1);
  assert.equal(processes[0].name, "pi");
  const killedAt = Date.now();
  console.log("SIGKILL isolated foreground:", processes[0].pid);
  process.kill(processes[0].pid, "SIGKILL");
  await sleep(1000);
  await birth();
  await command("proof-reconcile");
  job = await until(
    "crash-reconciled-unsettled",
    (j) => j?.semantic_state === "idle_unsettled" && j.updated_at > killedAt,
  );
  assert(
    Date.now() - killedAt < 15000,
    "proven-dead owner must reconcile immediately, not wait for lease expiry",
  );
  await rpc("agent.prompt", {
    target: job.herdr_pane_id,
    text: "Human steering: finish the original proof now. Recheck proof.txt, review, and atomically self-settle using the original job identity, nonce and exact path. Do not sleep again.",
  });
  await until("resumed", (j) => j?.semantic_state === "running");
  writeFileSync(
    join(root, "disconnect"),
    "disconnect actual Drover control WebSocket",
  );
  await until("route-loss-unknown", (j) => j?.reachability === "unknown");
  await sleep(15000);
  unlinkSync(join(root, "disconnect"));
  await command("proof-reconcile");
  job = await until("self-settled", (j) => j?.semantic_state === "settled");
  assert.match(
    readFileSync(join(job.remote_worktree, "proof.txt"), "utf8"),
    /Familiar Agents real inference/,
  );
  await sleep(4000);
  await restart();
  await command("proof-dispatch");
  await sleep(4000);
  assert.equal(jobs().length, 1);
  assert.equal(
    listItems(worklist).filter((n) => n.id.endsWith("-settled")).length,
    1,
  );
  assert(
    emptyAuth(profile) && emptyAuth(controllerProfile),
    "no ambient auth credentials copied",
  );
  const first = projection(job);
  delete first.settlement.nonce;

  // Second dispatch proves the generated, credential-free Tiamat profile and
  // retryable retention cleanup over the same production SSH machine route.
  const config = JSON.parse(
    readFileSync(join(root, "agents-config.json"), "utf8"),
  );
  config.machines[0].profile_mode = "familiar-tiamat-v1";
  delete config.machines[0].profile;
  writeFileSync(join(root, "agents-config.json"), JSON.stringify(config));
  writeFileSync(
    join(root, "request.json"),
    JSON.stringify({
      ...request,
      key: "proof-auto",
      label: "generated profile proof",
      task: "Create auto.txt containing exactly generated Familiar profile, run a grep test, review the file, and atomically self-settle using the supplied contract. No need to ask a question or sleep.",
    }),
  );
  await restart();
  await command("proof-dispatch");
  let auto = await until(
    "generated-profile-self-settled",
    (j) => j?.admission_key === "proof-auto" && j.semantic_state === "settled",
  );
  assert(auto.remote_profile.startsWith(dirname(auto.settlement_path)));
  assert(emptyAuth(auto.remote_profile));
  await command(`familiar-agent-cleanup ${auto.job_id}`);
  await until(
    "dirty-cleanup-retained",
    (j) => j?.cleanup_state === "needs_attention",
  );
  assert(existsSync(join(auto.remote_worktree, "auto.txt")));
  // Explicit test-operator action on this local enrolled host; never force GC.
  execFileSync("git", ["-C", auto.remote_worktree, "add", "--", "auto.txt"]);
  execFileSync("git", [
    "-C",
    auto.remote_worktree,
    "-c",
    "user.name=proof",
    "-c",
    "user.email=proof@example.invalid",
    "commit",
    "-qm",
    "retain reviewed proof",
  ]);
  await command(`familiar-agent-cleanup ${auto.job_id}`);
  await until("cleanup-retry-complete", (j) => j?.cleanup_state === "complete");
  assert(!existsSync(auto.remote_worktree) && !existsSync(auto.remote_profile));
  inferenceErrors();
  writeFileSync(
    join(root, "evidence.json"),
    JSON.stringify(
      {
        root,
        model,
        controllerPi,
        herdr,
        latency,
        firstJob: first,
        generatedProfileJob: auto.job_id,
        settledNotifications: listItems(worklist).filter((n) =>
          n.id.endsWith("-settled"),
        ).length,
        outcome: "PASS",
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: real foreground extension, production Drover/SSH, native attach, real inference, blocked answer, manual interruption/resume, SIGKILL takeover, actual route loss, dedup, generated profile, retryable cleanup",
  );
} finally {
  if (foreground) await command("proof-stop").catch(() => {});
  if (fixture && fixture.exitCode === null) {
    const ended = new Promise((r) => fixture.once("exit", r));
    fixture.kill("SIGTERM");
    await ended;
  }
  if (bootstrapped) await rpc("server.stop").catch(() => {});
}
