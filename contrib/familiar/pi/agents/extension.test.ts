import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildDispatchParameters,
  dispatchDescription,
  dispatchProjectDescription,
  dispatchRepoDescription,
  dispatchWorkspace,
} from "./dispatch.ts";

const source=readFileSync(new URL("./index.ts",import.meta.url),"utf8");

test("registers all v1 API tools without credential/provider plumbing",()=>{const names=[...source.matchAll(/name:"(agents_[^"]+)/g)].map(x=>x[1]);expect(names).toEqual(["agents_capabilities","agents_dispatch","agents_status","agents_answer","agents_steer","agents_cancel","agents_artifacts","agents_artifact_fetch"]);expect(source).toContain("api.dispatch");expect(source).toContain("job?.question?.id");expect(source).not.toContain("provider");expect(source).not.toContain("execFile");expect(source).not.toContain("GOLEM_CLI")});

const base={prompt:"do the work",harness:"pi",model:"model",worktree:"task"};

describe("agents_dispatch contract",()=>{
  test("advertises genuinely optional selectors and explicit omission semantics",()=>{
    const fakeType={
      String:(options:any={})=>({type:"string",...options}),
      Optional:(schema:any)=>({...schema,optional:true}),
      Object:(properties:any)=>({type:"object",properties,required:Object.entries(properties).filter(([,schema]:any)=>!schema.optional).map(([name])=>name)}),
    };
    const schema:any=buildDispatchParameters(fakeType);

    expect(source).toContain("description:dispatchDescription,parameters:dispatchParameters");
    expect(schema.required).toEqual(["prompt","harness","model","worktree"]);
    expect(schema.properties.project.minLength).toBe(1);
    expect(schema.properties.repo.minLength).toBe(1);
    expect(schema.properties.project.description).toBe(dispatchProjectDescription);
    expect(schema.properties.repo.description).toBe(dispatchRepoDescription);
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
    expect(dispatchDescription).toContain("provide project and omit repo, or provide repo and omit project");
    expect(dispatchDescription).toContain("Never send both fields or placeholders/empty strings");
    expect(dispatchProjectDescription).toContain("Omit project entirely when using repo");
    expect(dispatchRepoDescription).toContain("Omit repo entirely when using project");
  });

  test("accepts project without ref and repo with or without ref",()=>{
    expect(dispatchWorkspace({...base,project:"familiar"})).toEqual({project:"familiar",worktree:"task"});
    expect(dispatchWorkspace({...base,repo:"https://example.test/repo.git"})).toEqual({repo:"https://example.test/repo.git",ref:undefined,worktree:"task"});
    expect(dispatchWorkspace({...base,repo:"https://example.test/repo.git",ref:"main"})).toEqual({repo:"https://example.test/repo.git",ref:"main",worktree:"task"});
  });

  test("rejects every present ref when project is selected",()=>{
    expect(()=>dispatchWorkspace({...base,project:"familiar",ref:"main"})).toThrow("ref is only valid with repo; omit ref when using project");
    expect(()=>dispatchWorkspace({...base,project:"familiar",ref:""})).toThrow("ref is only valid with repo; omit ref when using project");
  });

  test("rejects missing, duplicate, and empty selectors at runtime",()=>{
    expect(()=>dispatchWorkspace(base)).toThrow("provide exactly one");
    expect(()=>dispatchWorkspace({...base,project:"familiar",repo:"https://example.test/repo.git"})).toThrow("provide exactly one");
    expect(()=>dispatchWorkspace({...base,project:""})).toThrow("project must be a non-empty string");
    expect(()=>dispatchWorkspace({...base,repo:""})).toThrow("repo must be a non-empty string");
  });
});
