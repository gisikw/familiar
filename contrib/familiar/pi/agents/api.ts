import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export type Workspace = { project: string; worktree: string } | { repo: string; ref?: string; worktree: string };
export type Dispatch = { harness: string; model: string; workspace: Workspace; prompt: string; idempotency_key?: string };
export type Capabilities = { harnesses: Record<string,{models:string[]}>; projects:{name:string;description?:string}[]; clone_enabled:boolean };

export class GolemClient {
  endpoint: string; token?: string;
  constructor(endpoint=process.env.GOLEM_ENDPOINT||"http://127.0.0.1:7337", token=process.env.GOLEM_TOKEN){this.endpoint=endpoint.replace(/\/$/,"");this.token=token||undefined}
  async raw(method:string,path:string,body?:unknown):Promise<{status:number;headers:Record<string,string|string[]|undefined>;body:Uint8Array}>{
    const unix=this.endpoint.startsWith("unix://"); const target=unix?new URL("http://unix"+path):new URL(this.endpoint+path); const payload=body===undefined?undefined:Buffer.from(JSON.stringify(body));
    return await new Promise((resolve,reject)=>{const fn=target.protocol==="https:"?httpsRequest:httpRequest;const req=fn({protocol:target.protocol,hostname:target.hostname,port:target.port,path:target.pathname+target.search,method,socketPath:unix?this.endpoint.slice(7):undefined,headers:{...(payload?{"content-type":"application/json","content-length":String(payload.length)}:{}),...(this.token?{authorization:`Bearer ${this.token}`}:{})}},res=>{const chunks:Buffer[]=[];res.on("data",x=>chunks.push(x));res.on("end",()=>resolve({status:res.statusCode||0,headers:res.headers,body:Buffer.concat(chunks)}))});req.on("error",reject);if(payload)req.write(payload);req.end()})
  }
  async json(method:string,path:string,body?:unknown):Promise<any>{const r=await this.raw(method,path,body);const text=Buffer.from(r.body).toString("utf8");if(r.status<200||r.status>=300)throw new Error(`golemd ${r.status}: ${text.slice(0,1000)}`);return text?JSON.parse(text):null}
  capabilities():Promise<Capabilities>{return this.json("GET","/v1/capabilities")}
  async dispatch(p:Dispatch):Promise<any>{const c=await this.capabilities();const h=c.harnesses[p.harness];if(!h)throw new Error(`harness ${p.harness} is not advertised`);if(!h.models.includes(p.model))throw new Error(`model ${p.model} is not advertised for ${p.harness}`);if("project" in p.workspace&&!c.projects.some(x=>x.name===p.workspace.project))throw new Error(`project ${p.workspace.project} is not advertised`);if("repo" in p.workspace&&!c.clone_enabled)throw new Error("this golemd does not allow repository clones");return this.json("POST","/v1/jobs",p)}
  list(state?:string){return this.json("GET","/v1/jobs"+(state?`?state=${encodeURIComponent(state)}`:""))}
  status(id:string){return this.json("GET",`/v1/jobs/${encodeURIComponent(id)}`)}
  answer(id:string,body:{idempotency_key:string;question_id:string;text:string}){return this.json("POST",`/v1/jobs/${encodeURIComponent(id)}/answer`,body)}
  steer(id:string,text:string){return this.json("POST",`/v1/jobs/${encodeURIComponent(id)}/steer`,{text})}
  cancel(id:string){return this.json("POST",`/v1/jobs/${encodeURIComponent(id)}/cancel`,{})}
  artifacts(id:string){return this.json("GET",`/v1/jobs/${encodeURIComponent(id)}/artifacts`)}
  async fetchArtifact(id:string,path:string){const safe=path.split("/");if(safe.some(x=>!x||x==="."||x===".."||x.includes("\\")))throw new Error("invalid artifact path");const r=await this.raw("GET",`/v1/jobs/${encodeURIComponent(id)}/artifacts/${safe.map(encodeURIComponent).join("/")}`);if(r.status<200||r.status>=300)throw new Error(`golemd ${r.status}`);return r.body}
}
