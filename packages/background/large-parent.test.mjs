import test from "node:test";
import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BackgroundHost } from "./host.mjs";

const sdk = process.env.PI_PACKAGE_DIR
  ? await import(
      pathToFileURL(join(process.env.PI_PACKAGE_DIR, "dist/index.js")).href
    )
  : null;

const tick = () => new Promise((resolve) => setImmediate(resolve));
const hex = (n) => n.toString(16).padStart(8, "0");

// A late-compacted v3 session: ~28k audit entries and ~150 MB of raw JSONL
// history that a real long-lived session accrues, then a compaction whose
// retained tail (kept turns plus post-compaction turns) is the small effective
// context Pi would actually send. The compacted-away history carries a marker
// that must never reach a child archive. Written line-by-line to a descriptor
// so the fixture never materializes in memory.
function writeCompactedParent(file, { historyEntries, fillerBytes }) {
  const fd = openSync(file, "wx", 0o600);
  const CHUNK = [];
  let id = 0;
  const push = (entry) => {
    CHUNK.push(JSON.stringify(entry));
    if (CHUNK.length >= 512) {
      writeSync(fd, CHUNK.join("\n") + "\n");
      CHUNK.length = 0;
    }
  };
  const now = new Date().toISOString();
  const sessionId = "01a08d42-e0cd-71d5-bb57-000000000001";
  push({ type: "session", version: 3, id: sessionId, timestamp: now, cwd: "/tmp/fixture" });
  const filler = "X".repeat(fillerBytes);
  let parentId = null;
  const message = (role, content) => {
    const entryId = hex(++id);
    push({
      type: "message",
      id: entryId,
      parentId,
      timestamp: now,
      message: { role, content, timestamp: 1 },
    });
    parentId = entryId;
    return entryId;
  };
  // Compacted-away history: excluded from the effective context by compaction.
  for (let i = 0; i < historyEntries; i++)
    message(i % 2 === 0 ? "user" : "assistant", `COMPACTED_AWAY_MARKER ${i} ${filler}`);
  // Retained tail kept across the compaction boundary.
  const firstKeptEntryId = message("user", "RETAINED_KEPT_MARKER kept question");
  // The compaction entry itself, summarizing everything before firstKeptEntryId.
  const compactionId = hex(++id);
  push({
    type: "compaction",
    id: compactionId,
    parentId,
    timestamp: now,
    summary: "COMPACTION_SUMMARY_MARKER: prior work condensed into a summary.",
    firstKeptEntryId,
    tokensBefore: 1234567,
  });
  parentId = compactionId;
  // Post-compaction tail, ending on the current user turn.
  message("assistant", "POST_TAIL_MARKER retained answer");
  const leafId = message("user", "CURRENT_USER_MARKER latest turn");
  if (CHUNK.length) writeSync(fd, CHUNK.join("\n") + "\n");
  closeSync(fd);
  return { sessionId, leafId };
}

function mockOwner(sm, agentDir) {
  return {
    modelRequired: true,
    available: () => true,
    snapshot: (options) => {
      const entries = sm.getBranch();
      return {
        sessionId: sm.getSessionId(),
        leafId: sm.getLeafId(),
        file: sm.getSessionFile(),
        cwd: agentDir,
        model: { provider: "fixture", id: "model" },
        thinkingLevel: "medium",
        idle: true,
        private: false,
        entries,
        messages: options?.context ? sm.buildSessionContext().messages : [],
      };
    },
    commit: (...args) => sm.commitRuntimeControl(...args),
  };
}

function idleRuntime() {
  return {
    createRuntime: async (r) => ({
      sessionId: r.archive.sessionId,
      file: r.archive.file,
      async run() {},
      async abort() {},
      dispose() {},
    }),
  };
}

test(
  "large compacted parent: O(batch) append admission, effective child context, no whole-parent rewrite",
  { skip: !sdk },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "large-parent-"));
    const agentDir = join(root, "pi");
    const file = join(agentDir, "canonical.jsonl");
    let host;
    try {
      mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      const historyEntries = Number(process.env.FAMILIAR_LARGE_PARENT_ENTRIES ?? 28000);
      const fillerBytes = Number(process.env.FAMILIAR_LARGE_PARENT_FILLER ?? 5200);
      writeCompactedParent(file, { historyEntries, fillerBytes });
      const rawBytes = statSync(file).size;
      assert.ok(rawBytes > 128 * 1024 * 1024, `parent should be ~150MB, got ${rawBytes}`);

      const sm = sdk.SessionManager.open(file);
      // The raw branch is huge; the effective context is small (<1 MiB).
      const effective = sm.buildSessionContext().messages;
      const effectiveBytes = Buffer.byteLength(JSON.stringify(effective));
      assert.ok(effectiveBytes < 1024 * 1024, `effective context <1MiB, got ${effectiveBytes}`);
      assert.ok(sm.getEntries().length > historyEntries);

      host = new BackgroundHost({
        root: join(root, "background"),
        owner: mockOwner(sm, agentDir),
        ...idleRuntime(),
      });

      // Structural proof the commit is O(batch): capture size and the trailing
      // bytes at the current end, admit, then confirm the pre-commit prefix is
      // byte-for-byte unchanged, the file grew only a few KiB, and no
      // whole-parent temporary was ever created.
      const sizeBefore = statSync(file).size;
      const tailProbe = Buffer.alloc(4096);
      const probeFd = openSync(file, "r");
      readSync(probeFd, tailProbe, 0, tailProbe.length, sizeBefore - tailProbe.length);
      closeSync(probeFd);

      const receipt = host.admit({
        admissionId: "large-admission",
        parentSessionId: sm.getSessionId(),
        parentLeafId: sm.getLeafId(),
        projectId: "project",
        content: "EXACT_ADMITTED_REQUEST please continue",
      });

      const sizeAfter = statSync(file).size;
      assert.ok(sizeAfter > sizeBefore, "canonical grew");
      assert.ok(sizeAfter - sizeBefore < 8 * 1024, `parent grew only a few KiB, grew ${sizeAfter - sizeBefore}`);
      assert.equal(existsSync(`${file}.runtime-control.tmp`), false, "no whole-parent temp rewrite");
      // Pre-commit bytes remain an exact prefix (append-only, never rewritten).
      const afterProbe = Buffer.alloc(4096);
      const afterFd = openSync(file, "r");
      readSync(afterFd, afterProbe, 0, afterProbe.length, sizeBefore - afterProbe.length);
      closeSync(afterFd);
      assert.deepEqual(afterProbe, tailProbe, "canonical prefix unchanged by append");

      // The child archive holds the effective compacted context plus the exact
      // request, and never the compacted-away history.
      const workstreamDir = join(root, "background", receipt.workstreamId);
      const childFile = join(workstreamDir, "branch.jsonl");
      const childRaw = readFileSync(childFile, "utf8");
      assert.ok(childRaw.includes("COMPACTION_SUMMARY_MARKER"));
      assert.ok(childRaw.includes("RETAINED_KEPT_MARKER"));
      assert.ok(childRaw.includes("POST_TAIL_MARKER"));
      assert.ok(childRaw.includes("CURRENT_USER_MARKER"));
      assert.ok(childRaw.includes("EXACT_ADMITTED_REQUEST"));
      assert.ok(!childRaw.includes("COMPACTED_AWAY_MARKER"), "compacted-away history excluded");
      const child = sdk.SessionManager.open(childFile);
      assert.equal(child.buildSessionContext().messages.at(-1).content, "EXACT_ADMITTED_REQUEST please continue");

      // The append committed exactly the dispatch control entry last; admission
      // is proven by that entry, and the verifier confirms the committed record.
      const record = host.store.get(receipt.workstreamId);
      assert.equal(record.status, "running");
      assert.equal(host.hasCanonicalAdmission(record), true);

      // Rejoin the large parent and prove idempotent replay.
      for (let i = 0; i < 5; i++) await tick();
      const settled = host.store.get(receipt.workstreamId);
      assert.equal(settled.settledRun, settled.run);
      const packet = host.report(settled.id, settled.generation, {
        reportId: "final",
        disposition: "returned",
        summary: "bounded return",
        requestedRejoin: false,
      });
      const growthBeforeMerge = statSync(file).size;
      host.rejoin(settled.id, settled.generation, packet.packetId, sm.getLeafId());
      assert.equal(host.store.get(settled.id).status, "rejoined");
      assert.ok(statSync(file).size - growthBeforeMerge < 8 * 1024, "merge also O(batch)");
      // Replaying the same rejoin is a no-op, never a duplicate delivery.
      assert.throws(
        () => host.rejoin(settled.id, settled.generation, packet.packetId, sm.getLeafId()),
        /rejoin or replay/,
      );
      const reopened = sdk.SessionManager.open(file);
      assert.equal(
        reopened.getEntries().filter((e) => e.details?.packetId === packet.packetId).length,
        1,
      );
    } finally {
      if (host) await host.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "effective child context over 16 MiB refuses before any record or directory is created",
  { skip: !sdk },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "oversize-context-"));
    const agentDir = join(root, "pi");
    const file = join(agentDir, "canonical.jsonl");
    let host;
    try {
      mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      // A tiny session whose single retained turn is a >16 MiB effective context.
      const fd = openSync(file, "wx", 0o600);
      const now = new Date().toISOString();
      writeSync(
        fd,
        JSON.stringify({ type: "session", version: 3, id: "01a08d42-e0cd-71d5-bb57-000000000002", timestamp: now, cwd: agentDir }) + "\n",
      );
      writeSync(
        fd,
        JSON.stringify({ type: "message", id: hex(1), parentId: null, timestamp: now, message: { role: "assistant", content: "ok", timestamp: 1 } }) + "\n",
      );
      writeSync(
        fd,
        JSON.stringify({ type: "message", id: hex(2), parentId: hex(1), timestamp: now, message: { role: "user", content: "Y".repeat(17 * 1024 * 1024), timestamp: 1 } }) + "\n",
      );
      closeSync(fd);

      const sm = sdk.SessionManager.open(file);
      const stateRoot = join(root, "background");
      host = new BackgroundHost({ root: stateRoot, owner: mockOwner(sm, agentDir), ...idleRuntime() });
      const before = readdirSync(stateRoot);
      assert.throws(
        () =>
          host.admit({
            admissionId: "too-big",
            parentSessionId: sm.getSessionId(),
            parentLeafId: sm.getLeafId(),
            projectId: "project",
            content: "small request",
          }),
        /byte budget|exceeds/,
      );
      assert.equal(host.store.list().length, 0, "no durable record created");
      assert.deepEqual(readdirSync(stateRoot), before, "no branch directory created");
    } finally {
      if (host) await host.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "torn final line reopens safely and a partial admission batch is not proven",
  { skip: !sdk },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "torn-parent-"));
    const agentDir = join(root, "pi");
    const file = join(agentDir, "canonical.jsonl");
    let host;
    try {
      mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      const { leafId } = writeCompactedParent(file, { historyEntries: 64, fillerBytes: 64 });
      const sm = sdk.SessionManager.open(file);
      host = new BackgroundHost({ root: join(root, "background"), owner: mockOwner(sm, agentDir), ...idleRuntime() });
      const receipt = host.admit({
        admissionId: "torn-admission",
        parentSessionId: sm.getSessionId(),
        parentLeafId: sm.getLeafId(),
        projectId: "project",
        content: "EXACT_REQUEST",
      });
      const record = host.store.get(receipt.workstreamId);
      assert.equal(host.hasCanonicalAdmission(record), true);

      // Simulate a torn trailing line: truncate the file mid-way through the
      // final (dispatch) entry. loadEntriesFromFile drops the malformed final
      // line, so a reopen is safe and the admission is no longer proven.
      const raw = readFileSync(file);
      const lastNl = raw.lastIndexOf(10);
      const secondLastNl = raw.lastIndexOf(10, lastNl - 1);
      const tornFile = join(agentDir, "torn.jsonl");
      const tornBody = raw.subarray(0, secondLastNl + 1 + 10); // keep partial dispatch line
      const tfd = openSync(tornFile, "wx", 0o600);
      writeSync(tfd, tornBody);
      closeSync(tfd);
      const tornManager = sdk.SessionManager.open(tornFile);
      // Reopen did not throw; the torn final line was dropped.
      assert.ok(tornManager.getEntries().length >= 1);
      const tornHost = new BackgroundHost({
        root: join(root, "background-torn"),
        owner: mockOwner(tornManager, agentDir),
        ...idleRuntime(),
      });
      try {
        // The exact dispatch control entry is absent, so the verifier refuses to
        // treat this as a committed admission (no silent duplicate execution).
        assert.equal(tornHost.hasCanonicalAdmission(record), false);
      } finally {
        await tornHost.shutdown();
      }
    } finally {
      if (host) await host.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
