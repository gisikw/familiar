import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { BackgroundHost } from "./host.mjs";
const sdk = process.env.PI_PACKAGE_DIR
  ? await import(
      pathToFileURL(join(process.env.PI_PACKAGE_DIR, "dist/index.js"))
    )
  : null;
const transaction = (name) =>
  ["written", "before-commit", "after-commit"].map(
    (point) => `${name}:${point}`,
  );
const canonical = [
  "control:appending",
  "control:written",
  "control:fsynced",
];
for (const [phase, points] of Object.entries({
  admission: [
    ...transaction("admit"),
    "archive:written",
    "archive:fsynced",
    "archive:directory-synced",
    "archive:root-synced",
    ...transaction("prepare"),
    ...canonical,
    ...transaction("admit-receipt"),
  ],
  "delivery-failure": transaction("delivery-pending"),
  merge: [
    ...transaction("archive-sealed"),
    ...transaction("rejoin"),
    ...canonical,
    ...transaction("delivered"),
  ],
}))
  for (const point of points)
    test(
      `host transaction SIGKILL/rebirth: ${phase} ${point}`,
      { skip: !sdk },
      async () => {
        const root = mkdtempSync(join(tmpdir(), "host-kill-"));
        let host;
        try {
          const child = spawnSync(
            process.execPath,
            [
              fileURLToPath(
                new URL("./host-crash-worker.mjs", import.meta.url),
              ),
              root,
              phase,
              point,
            ],
            { env: process.env, timeout: 20000 },
          );
          assert.equal(child.signal, "SIGKILL", child.stderr?.toString());
          const file = readFileSync(join(root, "file"), "utf8");
          const sm = sdk.SessionManager.open(file);
          const entries = sm.getEntries();
          const dispatches = entries.filter(
            (e) => e.customType === "familiar.background-dispatch",
          );
          assert.ok(dispatches.length <= 1);
          assert.equal(
            entries.filter(
              (entry) =>
                entry.customType === "familiar.background.admission-context",
            ).length,
            dispatches.length,
          );
          assert.equal(
            entries.filter(
              (e) => e.type === "message" && e.message.role === "user",
            ).length,
            dispatches.length,
          );
          assert.equal(
            entries.filter(
              (e) => e.type === "message" && e.message.role === "assistant",
            ).length,
            0,
          );
          const merges = entries.filter(
            (e) => e.customType === "familiar.background.merge",
          );
          assert.ok(merges.length <= 1);
          let starts = 0;
          host = new BackgroundHost({
            root: join(root, "background"),
            owner: {
              snapshot: () => ({
                sessionId: sm.getSessionId(),
                leafId: sm.getLeafId(),
                cwd: root,
                model: { provider: "fixture", id: "model" },
                thinkingLevel: "medium",
                idle: true,
                private: false,
                entries,
                messages: sm.buildSessionContext().messages,
              }),
              commit: (...args) => sm.commitRuntimeControl(...args),
            },
            createRuntime: () => {
              starts++;
              throw new Error("must not replay uncertain work");
            },
          });
          await new Promise((r) => setImmediate(r));
          assert.equal(starts, 0);
          assert.equal(
            existsSync(`${file}.runtime-control.tmp`),
            false,
            "dead canonical temporary reclaimed under owner lease",
          );
          const records = host.store.list();
          assert.ok(records.length <= 1);
          for (const record of records) {
            assert.equal(
              record.status,
              merges.length ? "rejoined" : "orphaned",
            );
            if (merges.length) {
              assert.equal(
                JSON.parse(merges[0].content).packetId,
                record.deliveredPacketId,
              );
              assert.equal(
                sm.buildSessionContext().messages.at(-1).content,
                merges[0].content,
              );
            }
            assert.throws(() => host.admit(record.admission));
          }
        } finally {
          if (host) await host.shutdown();
          rmSync(root, { recursive: true, force: true });
        }
      },
    );
