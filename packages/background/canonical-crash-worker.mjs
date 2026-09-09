import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { SessionManager } = await import(pathToFileURL(join(process.env.PI_PACKAGE_DIR, "dist/index.js")));
const [root, kind, boundary] = process.argv.slice(2);
const manager = SessionManager.create(root, root);
manager.commitRuntimeControl(manager.getSessionId(), null, [{ type: "custom", customType: "seed", data: {} }]);
writeFileSync(join(root, "file"), manager.getSessionFile());
const entries = kind === "admission" ? [
  { type: "message", message: { role: "user", content: "exact admitted image/handoff request", timestamp: 1 } },
  { type: "custom", customType: "familiar.background-dispatch", data: { admissionId: "once" } },
] : [{ type: "custom_message", customType: "familiar.background.merge", content: '{"packetId":"once","summary":"bounded refusal"}', display: true, details: { packetId: "once" } }];
manager.commitRuntimeControl(manager.getSessionId(), manager.getLeafId(), entries, (point) => {
  if (point === boundary) process.kill(process.pid, "SIGKILL");
});
throw new Error("crash boundary not reached");
