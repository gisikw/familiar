import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("fork inherits the immutable prompt/tool prefix byte-for-byte", () => {
  const root = mkdtempSync(join(tmpdir(), "familiar-fork-prefix-"));
  try {
    const parent = join(root, "parent.jsonl");
    const sha = "a".repeat(64); // tiamat's digest of assembled system prompt + tool surface
    const prefix = [
      {type:"session",version:3,id:"parent-session",timestamp:"2026-01-01T00:00:00.000Z",cwd:root},
      {type:"custom",id:"prompt01",parentId:null,timestamp:"2026-01-01T00:00:01.000Z",customType:"familiar.system-prompt.v1",data:{sha256:sha,text:"identical prompt and ordered tools"}},
      {type:"message",id:"branch01",parentId:"prompt01",timestamp:"2026-01-01T00:00:02.000Z",message:{role:"assistant",content:[{type:"text",text:"ready"}]}}
    ];
    writeFileSync(parent, prefix.map(x=>JSON.stringify(x)).join("\n")+"\n");
    const sessions = join(root,"sessions"); mkdirSync(sessions);
    const helper = resolve(import.meta.dir,"../../../../scripts/fork-session.mjs");
    const run = spawnSync(process.execPath,[helper,process.env.PI_PACKAGE_DIR!,parent,"branch01",sessions,"parent-session"],{encoding:"utf8"});
    expect(run.status).toBe(0);
    const made = JSON.parse(run.stdout);
    const forkLines = readFileSync(made.file,"utf8").trim().split("\n").map(JSON.parse);
    // The session header necessarily has a new identity. Every graph entry in
    // the inherited prefix is byte-equivalent before fork-only suffix entries.
    expect(forkLines.slice(1,3)).toEqual(prefix.slice(1));
    expect(forkLines[1].data.sha256).toBe(sha);
    expect(forkLines[3].customType).toBe("familiar.fork.v1");
    expect(forkLines[4].customType ?? forkLines[4].message?.customType).toBe("familiar.fork-note.v1");
  } finally { rmSync(root,{recursive:true,force:true}); }
});
