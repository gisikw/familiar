import { WorkstreamStore } from "./store.mjs";
import { BranchScheduler } from "./scheduler.mjs";
import { OwnedChildren } from "./children.mjs";
const [root, target] = process.argv.slice(2);
const store = new WorkstreamStore(root, {
  boundary: (point) => {
    if (point === target) process.kill(process.pid, "SIGKILL");
  },
});
const r = store.create({
  admissionId: "admission-1",
  parentSessionId: "parent",
  parentLeafId: "leaf",
  projectId: "project",
  content: "exact admitted turn\n",
}).record;
store.prepare(r.id, 1, {
  file: "/synthetic/branch.jsonl",
  sha256: "a".repeat(64),
  sessionId: "branch",
});
store.admitReceipt(r.id, 1, { userEntryId: "user", controlEntryId: "control" });
store.start(r.id, 1);
if (target.startsWith("child-")) {
  let job = { id: "job", state: "running" };
  const children = new OwnedChildren(store, r.id, 1, {
    dispatch: async () => job,
    status: async () => job,
    answer: async () => ({}),
  });
  await children.dispatch("create", { prompt: "task" });
  job = {
    id: "job",
    state: "blocked",
    question: { id: "question", prompt: "choose" },
  };
  await children.observe({ job_id: "job", seq: 1 });
  await children.answer("job", "question", "answer", "yes");
  children.acknowledgeEvent("job", 1);
}
if (target.startsWith("command-") || target.startsWith("retire")) {
  const scheduler = new BranchScheduler(store);
  scheduler.register(r.id, 1, {
    sessionId: "branch",
    file: "/synthetic/branch.jsonl",
    run: async () => {},
    abort: async () => {
      if (target.startsWith("retire-error")) throw new Error("abort failure");
    },
    dispose() {},
  });
  scheduler.steer(r.id, 1, "command", "direction");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await scheduler.shutdown();
}
if (target.startsWith("steer:")) store.enqueue(r.id, 1, "steer", "direction");
store.settle(r.id, 1, 1);
const p = store.saveReport(r.id, 1, {
  reportId: "report",
  disposition: "ready",
  summary: "ready",
  requestedRejoin: true,
});
if (target.startsWith("cancel:")) store.cancel(r.id, 1);
else {
  store.beginRejoin(r.id, 1, p.packetId);
  if (!target.startsWith("recover:")) store.delivered(r.id, 1, p.packetId);
}
store.recover(() => false);
throw new Error(`unreached crash boundary ${target}`);
