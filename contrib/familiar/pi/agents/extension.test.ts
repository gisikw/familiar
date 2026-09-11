import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildDispatchParameters,
  dispatchDescription,
  dispatchWorkspace,
  dispatchWorkspaceDescription,
  prepareDispatchArguments,
} from "./dispatch.ts";

const piPackageDir=process.env.PI_PACKAGE_DIR;
if(!piPackageDir)throw new Error("PI_PACKAGE_DIR is required; run this test in the agents devshell");
const {Type}=await import(`${piPackageDir}/node_modules/typebox/build/index.mjs`);
const {convertResponsesTools}=await import(`${piPackageDir}/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js`);
const source=readFileSync(new URL("./index.ts",import.meta.url),"utf8");

test("registers all v1 API tools without credential/provider plumbing",()=>{const names=[...source.matchAll(/name:"(agents_[^"]+)/g)].map(x=>x[1]);expect(names).toEqual(["agents_capabilities","agents_dispatch","agents_status","agents_answer","agents_steer","agents_cancel","agents_artifacts","agents_artifact_fetch"]);expect(source).toContain("api.dispatch");expect(source).toContain("job?.question?.id");expect(source).not.toContain("provider");expect(source).not.toContain("execFile");expect(source).not.toContain("GOLEM_CLI")});

const base={prompt:"do the work",harness:"pi",model:"model",worktree:"task"};

describe("agents_dispatch contract",()=>{
  test("advertises one required project-or-repo workspace union",()=>{
    const schema:any=buildDispatchParameters(Type);
    const workspace=schema.properties.workspace;

    expect(source).toContain("constrainedSampling:false");
    expect(source).toContain("prepareArguments:prepareDispatchArguments");
    expect(schema.required).toEqual(["prompt","harness","model","worktree","workspace"]);
    expect(Object.keys(schema.properties)).toEqual(["prompt","harness","model","worktree","workspace","key"]);
    expect(workspace.description).toBe(dispatchWorkspaceDescription);
    expect(workspace.anyOf).toHaveLength(2);
    expect(workspace.anyOf[0].required).toEqual(["project"]);
    expect(workspace.anyOf[0].additionalProperties).toBe(false);
    expect(workspace.anyOf[1].required).toEqual(["repo"]);
    expect(workspace.anyOf[1].additionalProperties).toBe(false);
    expect(dispatchDescription).toContain("{project}");
    expect(dispatchDescription).toContain("{repo, ref?}");
  });

  test("preserves the object union when OpenAI strict sampling is disabled",()=>{
    const parameters:any=buildDispatchParameters(Type);
    const [tool]:any=convertResponsesTools([{
      name:"agents_dispatch",
      description:dispatchDescription,
      parameters,
      constrainedSampling:false,
    }],{strict:null,supportsStrictMode:true});
    expect(tool.strict).toBeNull();
    expect(tool.parameters.properties.workspace.anyOf).toHaveLength(2);
    expect(tool.parameters.required).toContain("workspace");
  });

  test("builds project and repo API workspaces",()=>{
    expect(dispatchWorkspace({project:"familiar"},base.worktree)).toEqual({project:"familiar",worktree:"task"});
    expect(dispatchWorkspace({repo:"https://example.test/repo.git"},base.worktree)).toEqual({repo:"https://example.test/repo.git",worktree:"task"});
    expect(dispatchWorkspace({repo:"https://example.test/repo.git",ref:"main"},base.worktree)).toEqual({repo:"https://example.test/repo.git",ref:"main",worktree:"task"});
    expect(dispatchWorkspace({repo:"https://example.test/repo.git",ref:null},base.worktree)).toEqual({repo:"https://example.test/repo.git",worktree:"task"});
  });

  test("rejects empty values",()=>{
    expect(()=>dispatchWorkspace({project:""},base.worktree)).toThrow("project must be a non-empty string");
    expect(()=>dispatchWorkspace({repo:""},base.worktree)).toThrow("repo must be a non-empty string");
  });

  test("prepares valid legacy flat calls before schema validation",()=>{
    expect(prepareDispatchArguments({...base,project:"familiar"})).toEqual({...base,workspace:{project:"familiar"}});
    expect(prepareDispatchArguments({...base,project:"familiar",repo:null,ref:null})).toEqual({...base,workspace:{project:"familiar"}});
    expect(prepareDispatchArguments({...base,repo:"https://example.test/repo.git",ref:"main"})).toEqual({...base,workspace:{repo:"https://example.test/repo.git",ref:"main"}});
    const current={...base,workspace:{repo:"https://example.test/repo.git"}};
    expect(prepareDispatchArguments(current)).toBe(current);
  });

  test("does not guess how to repair invalid legacy selectors",()=>{
    const missing={...base};
    const duplicate={...base,project:"familiar",repo:"https://example.test/repo.git"};
    const projectWithRef={...base,project:"familiar",ref:"main"};
    expect(prepareDispatchArguments(missing)).toBe(missing);
    expect(prepareDispatchArguments(duplicate)).toBe(duplicate);
    expect(prepareDispatchArguments(projectWithRef)).toBe(projectWithRef);
  });
});
