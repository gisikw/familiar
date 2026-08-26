import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const source=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
test("registers all v1 API tools without credential/provider plumbing",()=>{const names=[...source.matchAll(/name:\"(agents_[^\"]+)/g)].map(x=>x[1]);expect(names).toEqual(["agents_capabilities","agents_dispatch","agents_status","agents_answer","agents_steer","agents_cancel","agents_artifacts","agents_artifact_fetch"]);expect(source).toContain("api.dispatch");expect(source).toContain("job?.question?.id");expect(source).not.toContain("provider");expect(source).not.toContain("execFile");expect(source).not.toContain("GOLEM_CLI")});
