import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { GolemClient } from "./api.ts";
import { SettlementRelay } from "./relay.ts";
import {
  registry,
  WORKLIST_SINK,
  WORKLIST_SINK_VERSION,
  type DurableSink,
} from "../../../../integrations/pi/extensions/lib/capabilities.ts";
import { Text } from "@earendil-works/pi-tui";
import { callText, resultText } from "./render.ts";
import { run, result } from "./tool-result.ts";
// Compact/expandable TUI renderers for the agents_* tools (see render.ts).
// Collapsed shows a concise semantic line; Ctrl+O expands to full useful detail.
// The model always receives the complete result — rendering only affects display.
const renderers=(name:string)=>({
 renderCall:(args:any,theme:any,context:any)=>new Text(callText(name,args,theme,context),0,0),
 renderResult:(r:any,options:any,theme:any,context:any)=>new Text(resultText(name,r,options,theme,context),0,0)
});
// Durable settlement state lives under the instance state dir (never in source).
// FAMILIAR_AGENTS_STATE_DIR wins; else derive from PI_CODING_AGENT_DIR.
function settlementStateDir():string|undefined{
 const explicit=process.env.FAMILIAR_AGENTS_STATE_DIR;
 if(explicit)return explicit;
 const pi=process.env.PI_CODING_AGENT_DIR;
 if(pi)return path.join(pi,"golem-settlement");
 return undefined;
}
// Worklist's official out-of-process drop-box, used as the durable fallback when
// the in-process capability sink is unresolvable across pi's extension-loader
// module boundary (external contrib plugin vs built-in worklist get isolated
// module instances, so the process-local registry singleton may not cross it).
// Mirrors worklist's own root resolution (FAMILIAR_WORKLIST_DIR, then legacy
// FAMILIAR_INBOX_DIR). Undefined → no dropbox → relay retains pending.
function worklistDropboxDir():string|undefined{
 const root=process.env.FAMILIAR_WORKLIST_DIR||process.env.FAMILIAR_INBOX_DIR;
 return root?path.join(root,"incoming"):undefined;
}
export default function(pi:ExtensionAPI){const api=new GolemClient();
 // Background settlement relay: surfaces terminal settlements of jobs dispatched
 // through THIS extension into the worklist. FIRST choice is the neutral durable
 // sink (resolved lazily so loader order is irrelevant); if that module boundary
 // isolates the registry, it falls back to worklist's durable incoming drop-box.
 // Never a direct pi.sendMessage. If no durable state dir is derivable, the relay
 // is disabled (tools still work).
 const stateDir=settlementStateDir();
 const relay=stateDir?new SettlementRelay({client:api,stateDir,dropboxDir:worklistDropboxDir(),resolveSink:()=>registry.resolve<DurableSink>(WORKLIST_SINK,WORKLIST_SINK_VERSION)}):undefined;
 pi.on("session_start",async()=>{if(relay)try{await relay.start()}catch{/* relay start is best-effort; tools remain usable */}});
 pi.on("session_shutdown",async()=>{if(relay)try{await relay.stop()}catch{/* nothing to recover */}});
 pi.registerTool({name:"agents_capabilities",label:"Agent Capabilities",description:"List golemd's advertised harness/model and project choices.",parameters:Type.Object({}),execute:()=>run(()=>api.capabilities()),...renderers("agents_capabilities")});
 pi.registerTool({name:"agents_dispatch",label:"Dispatch Agent",description:"Dispatch using a harness, model, and workspace advertised by golemd capabilities.",parameters:Type.Object({prompt:Type.String(),harness:Type.String(),model:Type.String(),worktree:Type.String(),project:Type.Optional(Type.String()),repo:Type.Optional(Type.String()),ref:Type.Optional(Type.String()),key:Type.Optional(Type.String())}),execute:(_id,p:any)=>run(async()=>{if(Boolean(p.project)===Boolean(p.repo))throw new Error("provide exactly one of project or repo");const workspace=p.project?{project:p.project,worktree:p.worktree}:{repo:p.repo,ref:p.ref,worktree:p.worktree};return api.dispatch({harness:p.harness,model:p.model,workspace,prompt:p.prompt,idempotency_key:p.key||randomUUID()}).then(async(job:any)=>{const id=job?.id;if(relay&&typeof id==="string"&&id)await relay.recordDispatch(id);return job})}),...renderers("agents_dispatch")});
 pi.registerTool({name:"agents_status",label:"Agent Status",description:"List jobs or inspect one. Blocked job output includes its question.",parameters:Type.Object({id:Type.Optional(Type.String()),state:Type.Optional(Type.String())}),execute:(_id,p:any)=>run(async()=>{if(!p.id)return api.list(p.state);const job=await api.status(p.id);
 // Opening one job's response directly IS the receipt: a settled job read
 // here must not later interrupt via the sidecar settlement item. Worklist
 // NUDGES are untouched (an already-delivered item refuses withdrawal and
 // still requires an explicit ack); blocked questions are never acked by a
 // mere read. Best-effort: a receipt failure never breaks the status tool.
 if(relay)try{await relay.noteDirectReceipt(p.id,job)}catch{/* receipt is best-effort */}
 return job}),...renderers("agents_status")});
 pi.registerTool({name:"agents_answer",label:"Answer Agent",description:"Answer the question on a blocked job.",parameters:Type.Object({id:Type.String(),text:Type.String(),question_id:Type.Optional(Type.String()),key:Type.Optional(Type.String())}),execute:(_id,p:any)=>run(async()=>{const job=p.question_id?null:await api.status(p.id);const q=p.question_id||job?.question?.id;if(!q)throw new Error("job has no blocked question");return api.answer(p.id,{idempotency_key:p.key||randomUUID(),question_id:q,text:p.text})}),...renderers("agents_answer")});
 pi.registerTool({name:"agents_steer",label:"Steer Agent",description:"Send guidance to a running job.",parameters:Type.Object({id:Type.String(),text:Type.String()}),execute:(_id,p:any)=>run(()=>api.steer(p.id,p.text)),...renderers("agents_steer")});
 pi.registerTool({name:"agents_cancel",label:"Cancel Agent",description:"Request cancellation.",parameters:Type.Object({id:Type.String()}),execute:(_id,p:any)=>run(()=>api.cancel(p.id)),...renderers("agents_cancel")});
 pi.registerTool({name:"agents_artifacts",label:"List Agent Artifacts",description:"List retained job artifacts.",parameters:Type.Object({id:Type.String()}),execute:(_id,p:any)=>run(async()=>{const a=await api.artifacts(p.id);if(relay)try{await relay.noteDirectReceipt(p.id)}catch{/* best-effort */}return a}),...renderers("agents_artifacts")});
 pi.registerTool({name:"agents_artifact_fetch",label:"Fetch Agent Artifact",description:"Fetch an artifact as base64 (maximum 2 MiB).",parameters:Type.Object({id:Type.String(),path:Type.String()}),execute:(_id,p:any)=>run(async()=>{const b=await api.fetchArtifact(p.id,p.path);if(b.byteLength>2*1024*1024)throw new Error("artifact exceeds 2 MiB tool limit");if(relay)try{await relay.noteDirectReceipt(p.id)}catch{/* best-effort */}return{id:p.id,path:p.path,encoding:"base64",data:Buffer.from(b).toString("base64")}}),...renderers("agents_artifact_fetch")});
}
