import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BackgroundHost } from "./host.mjs";
const { SessionManager } = await import(
  pathToFileURL(join(process.env.PI_PACKAGE_DIR, "dist/index.js"))
);
const [root, phase, point] = process.argv.slice(2);
mkdirSync(join(root, "canonical"));
const sm = SessionManager.create(root, join(root, "canonical"));
sm.commitRuntimeControl(sm.getSessionId(), null, [
  { type: "custom", customType: "seed", data: {} },
]);
writeFileSync(join(root, "file"), sm.getSessionFile());
let stage = "admission";
const boundary = (at) => {
  if (phase === stage && at === point) process.kill(process.pid, "SIGKILL");
};
const owner = {
  snapshot: () => ({
    sessionId: sm.getSessionId(),
    leafId: sm.getLeafId(),
    file: sm.getSessionFile(),
    cwd: root,
    model: { provider: "fixture", id: "model" },
    thinkingLevel: "medium",
    idle: true,
    private: false,
    entries: sm.getBranch(),
    messages: sm.buildSessionContext().messages,
  }),
  commit: (...args) => {
    if (phase === "delivery-failure" && stage !== "admission") {
      stage = "delivery-failure";
      throw new Error("injected canonical I/O failure");
    }
    return sm.commitRuntimeControl(...args, boundary);
  },
};
const host = new BackgroundHost({
  root: join(root, "background"),
  owner,
  boundary,
  createRuntime: async (r) => ({
    sessionId: r.archive.sessionId,
    file: r.archive.file,
    async run() {},
    async abort() {},
    dispose() {},
  }),
});
const receipt = host.admit({
  admissionId: "once",
  parentSessionId: sm.getSessionId(),
  parentLeafId: sm.getLeafId(),
  projectId: "project",
  content: "exact current user",
});
for (let n = 0; n < 5; n++)
  await new Promise((resolve) => setImmediate(resolve));
const r = host.store.get(receipt.workstreamId);
const packet = host.report(r.id, r.generation, {
  reportId: "final",
  disposition: "refused",
  summary: "Bounded refusal",
  questions: ["Which target?"],
  requestedRejoin: false,
});
stage = "merge";
host.rejoin(r.id, r.generation, packet.packetId, sm.getLeafId());
await host.shutdown();
throw new Error("crash boundary not reached");
