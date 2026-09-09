// Opt-in release gate: actual Familiar launcher + isolated tmux Presence + UI
// bridge + real provider + two scheduler-owned SDK sessions in that same Pi.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startIsolatedPresence } from "./isolated-presence.mjs";
import { discoverCatalogRow } from "./probe-catalog.mjs";
if (process.env.BACKGROUND_REAL_PROVIDER_PROBE !== "1")
  throw new Error("explicit real probe opt-in required");
const root = mkdtempSync(join(tmpdir(), "background-real-presence-"));
mkdirSync(join(root, "progress"));
const ui = resolve(process.env.FAMILIAR_UI_SOURCE);
const { FamiliarClient } = await import(
  pathToFileURL(join(ui, "packages/client/dist/index.js"))
);
let host,
  client,
  stage = "catalog";
const started = Date.now();
const until = async (predicate) => {
  while (Date.now() - started < 90000) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("real probe deadline");
};
try {
  const row = await discoverCatalogRow({
    baseUrl: process.env.GOLEM_TIAMAT_URL,
    token: readFileSync(process.env.GOLEM_TIAMAT_TOKEN_FILE, "utf8").trim(),
    authorized: JSON.parse(
      readFileSync(process.env.GOLEM_TIAMAT_SNAPSHOT_FILE, "utf8"),
    ),
    modelId: process.env.BACKGROUND_PROBE_MODEL ?? "gpt-5.5",
  });
  const catalog = join(root, "catalog.json");
  writeFileSync(catalog, JSON.stringify([row]), { mode: 0o600 });
  const adapter = join(root, "observer.ts");
  const providerAdapter =
    process.env.BACKGROUND_PROVIDER_ADAPTER ??
    join(process.env.PI_CODING_AGENT_DIR, "golem-tiamat/index.ts");
  writeFileSync(
    adapter,
    `import provider from ${JSON.stringify(providerAdapter)};
import { writeFileSync, renameSync } from 'node:fs';
export default async function(pi) {
  await provider(pi);
  const value = { streaming: false, deltas: 0, toolDeltas: 0, failed: false, pid: process.pid };
  const save = (ctx) => { const file = ${JSON.stringify(join(root, "progress"))} + '/' + ctx.sessionManager.getSessionId() + '.json'; writeFileSync(file+'.tmp', JSON.stringify(value), {mode:0o600}); renameSync(file+'.tmp', file); };
  pi.on('message_start', (event,ctx) => { if(event.message.role==='assistant') {value.streaming=true;save(ctx);} });
  pi.on('message_update', (event,ctx) => { if(event.assistantMessageEvent?.type==='error') value.failed=true; if(event.assistantMessageEvent?.type==='text_delta' && event.assistantMessageEvent.delta.length) value.deltas++; if(event.assistantMessageEvent?.type==='toolcall_delta' && event.assistantMessageEvent.delta.length) value.toolDeltas++; save(ctx); });
  pi.on('message_end', (event,ctx) => { if(event.message.role==='assistant') {value.streaming=false;value.stopReason=event.message.stopReason;if(event.message.stopReason==='error') {value.failed=true; value.errorClasses=['unsupported','schema','required','additionalproperties','authentication','rate limit','context','model','reasoning','instructions','tool','max_output_tokens','not found','permission','name','enum'].filter(term => (event.message.errorMessage ?? '').toLowerCase().includes(term));}save(ctx);} });
}`,
  );
  stage = "isolated-birth";
  host = await startIsolatedPresence({
    uiSource: ui,
    origin: "http://localhost:5173",
    realProvider: {
      adapter,
      provider: process.env.PI_PROVIDER,
      model: row.model,
      GOLEM_TIAMAT_SNAPSHOT_FILE: catalog,
    },
  });
  client = new FamiliarClient({
    url: host.descriptor.url,
    token: host.descriptor.token,
    fetch: (input, options) =>
      fetch(input, {
        ...options,
        headers: { ...options?.headers, Origin: "http://localhost:5173" },
      }),
  });
  client.start();
  await until(() => client.getState().status === "live");
  const snapshot = () => client.getState().snapshot;
  const controls = () =>
    snapshot().branch.flatMap((entry) =>
      entry.backgroundDispatch ? [entry.backgroundDispatch] : [],
    );
  const progress = (id) => {
    try {
      return JSON.parse(
        readFileSync(join(root, "progress", `${id}.json`), "utf8"),
      );
    } catch {
      return null;
    }
  };
  stage = "background-admission";
  const admissionMs = [];
  for (let n = 0; n < 2; n++) {
    const state = snapshot();
    const before = Date.now();
    const response = await client.send({
      type: "message.send",
      delivery: "immediate",
      text: `Harmless real concurrency acceptance test ${n}. Produce an original detailed technical tutorial about ${n === 0 ? "atomic file replacement, directory fsync and durable local admission" : "distributed lease fencing, idempotent job queues and recovery of uncertain remote operations"}. This is an independent topic, not a duplicate of any other workstream. Put the complete tutorial of 5000 to 6000 characters in background_report.summary, with disposition ready and requestedRejoin true. Use the report tool directly; the tutorial is the task, not a proposal to do it later. Do not dispatch children or use any external resources.`,
      background: {
        admissionId: `real-${n}`,
        parentSessionId: state.session.id,
        parentLeafId: state.session.leafId,
        projectId: "probe",
      },
    });
    assert.equal(response.status, "accepted");
    admissionMs.push(Date.now() - before);
    await until(() => controls().length === n + 1);
  }
  const branches = controls().map((receipt) => receipt.branchSessionId);
  const active = () => {
    const states = branches.map(progress);
    if (states.some((state) => state?.failed))
      throw new Error("provider streamed error");
    return states.every(
      (state) => state?.streaming && state.deltas + state.toolDeltas > 0,
    );
  };
  stage = "real-branch-progress";
  await until(active);
  assert.equal(
    snapshot().branch.filter((entry) => entry.message?.role === "assistant")
      .length,
    0,
  );
  stage = "foreground-inference";
  const foregroundStart = Date.now();
  const response = await client.send({
    type: "message.send",
    text: "Synthetic acceptance only. Reply exactly READY. Do not use any tools.",
    delivery: "immediate",
  });
  assert.equal(response.status, "accepted");
  await until(() => {
    if (progress(snapshot().session.id)?.failed)
      throw new Error("foreground streamed error");
    const message = snapshot()
      .branch.filter((entry) => entry.message?.role === "assistant")
      .at(-1)?.message;
    return (
      snapshot().idle &&
      message?.stopReason === "stop" &&
      message.content.some(
        (part) => part.type === "text" && part.text.trim() === "READY",
      )
    );
  });
  const latency = Date.now() - foregroundStart;
  assert.ok(latency < 10000, "foreground responsiveness bound exceeded");
  assert.ok(
    active(),
    "both real branches must remain active at foreground completion",
  );
  assert.equal(
    host.jobs.size,
    0,
    "real probe must not delegate to the synthetic child fixture",
  );
  const observations = branches.map(progress);
  assert.ok(
    observations.every((p) => p.pid === progress(snapshot().session.id).pid),
    "foreground and branches must share this isolated resident Pi",
  );
  stage = "cancellation-drain";
  for (const record of snapshot().background) {
    const receipt = await client.send({
      type: "background.control",
      action: "cancel",
      workstreamId: record.id,
      generation: record.generation,
      commandId: crypto.randomUUID(),
      expectedLeafId: snapshot().session.leafId,
    });
    assert.equal(receipt.status, "accepted");
  }
  await until(() =>
    snapshot().background.every((record) => record.status === "cancelled"),
  );
  console.log(
    JSON.stringify({
      proven: true,
      model: row.model,
      residentBirth: "isolated",
      canonicalAdmission: true,
      admissionMs,
      foregroundLatencyMs: latency,
      branchTextDeltas: observations.map((p) => p.deltas),
      branchToolArgumentDeltas: observations.map((p) => p.toolDeltas),
      inProcessBranchSessions: 2,
      samePiProcess: true,
      cancelledAndDrained: true,
    }),
  );
} catch {
  const observations = readdirSync(join(root, "progress"))
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const value = JSON.parse(
        readFileSync(join(root, "progress", file), "utf8"),
      );
      return {
        streaming: value.streaming,
        deltas: value.deltas,
        toolDeltas: value.toolDeltas,
        stopReason: value.stopReason,
        failed: value.failed,
        errorClasses: value.errorClasses,
      };
    });
  console.error(
    JSON.stringify({
      proven: false,
      stage,
      elapsedMs: Date.now() - started,
      observations,
      note: "No provider payload, credentials, transcript or pane logged",
    }),
  );
  process.exitCode = 1;
} finally {
  client?.close();
  await host?.stop();
  rmSync(root, { recursive: true, force: true });
}
