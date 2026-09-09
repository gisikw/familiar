import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "./ledger.mjs";
import { LIMITS } from "./contract.mjs";

test("SIGKILL preserves WAL admission and notification outbox; next process generation takes over", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fa-crash-")),
    file = join(root, "ledger.sqlite");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = `import {Ledger} from ${JSON.stringify(new URL("./ledger.mjs", import.meta.url).href)};
 const db=new Ledger(${JSON.stringify(file)}),f=db.acquire('killed-process');
 const j=db.admit(f,{key:'crash-key',machine_id:'test',harness:'pi',model:'test/model',repo:'/repo',requested_ref:'HEAD',task:'test',label:'crash'},{name:'test',session:'test'},'foreground');
 db.update(f,j,{semantic_state:'settled',settlement_json:'{"verdict":"done"}'},{id:j.job_id+'-settled',summary:'done'});
 console.log(JSON.stringify({id:j.job_id,nonce:j.settlement_nonce}));setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const admitted = await new Promise((resolve, reject) => {
    let raw = "";
    child.stdout.on("data", (b) => {
      raw += b;
      if (raw.includes("\n")) resolve(JSON.parse(raw.split("\n")[0]));
    });
    child.on("error", reject);
    child.on("exit", () => reject(new Error("child exited before admission")));
  });
  const dead = new Promise((r) => child.once("exit", r));
  child.kill("SIGKILL");
  await dead;
  const db = new Ledger(file);
  t.after(() => db.close());
  const fence = db.acquire("replacement");
  assert.equal(fence.generation, 2);
  assert.equal(db.get(admitted.id).settlement_nonce, admitted.nonce);
  assert.equal(db.pending(fence).length, 1);
  db.delivered(fence, admitted.id + "-settled");
  assert.equal(db.pending(fence).length, 0);
  assert.throws(
    () =>
      db.update(
        { owner: "killed-process", generation: 1 },
        db.get(admitted.id),
        {},
      ),
    /lease lost/,
  );
});
