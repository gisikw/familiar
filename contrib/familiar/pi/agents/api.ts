import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export type Workspace = { project: string; worktree: string } | { repo: string; ref?: string; worktree: string };
export type Dispatch = { harness: string; model: string; workspace: Workspace; prompt: string; idempotency_key?: string };
export type Capabilities = { harnesses: Record<string,{models:string[]}>; projects:{name:string;description?:string}[]; clone_enabled:boolean };

export class GolemClient {
  endpoint: string; token?: string;
  constructor(endpoint=process.env.GOLEM_ENDPOINT||"http://127.0.0.1:7337", token=process.env.GOLEM_TOKEN,
    readonly limits = { timeoutMs: 30_000, responseBytes: 4 * 1024 * 1024 }) {
    if (!Number.isFinite(limits.timeoutMs) || limits.timeoutMs <= 0 ||
      !Number.isSafeInteger(limits.responseBytes) || limits.responseBytes <= 0)
      throw new Error("invalid Golem transport limits");
    this.endpoint=endpoint.replace(/\/$/,"");this.token=token||undefined;
  }
  async raw(method:string,path:string,body?:unknown):Promise<{status:number;headers:Record<string,string|string[]|undefined>;body:Uint8Array}>{
    const unix=this.endpoint.startsWith("unix://"); const target=unix?new URL("http://unix"+path):new URL(this.endpoint+path); const payload=body===undefined?undefined:Buffer.from(JSON.stringify(body));
    return await new Promise((resolve,reject)=>{
      const fn=target.protocol==="https:"?httpsRequest:httpRequest;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fail=(error:Error)=>{clearTimeout(timer);reject(error)};
      const req=fn({protocol:target.protocol,hostname:target.hostname,port:target.port,path:target.pathname+target.search,method,socketPath:unix?this.endpoint.slice(7):undefined,headers:{...(payload?{"content-type":"application/json","content-length":String(payload.length)}:{}),...(this.token?{authorization:`Bearer ${this.token}`}:{})}},res=>{
        const chunks:Buffer[]=[];let bytes=0;
        res.on("data",x=>{
          bytes+=x.length;
          if(bytes>this.limits.responseBytes){
            const error=new Error("golemd response exceeds byte budget");
            fail(error);res.destroy(error);req.destroy(error);return;
          }
          chunks.push(x);
        });
        res.on("error",fail);
        res.on("aborted",()=>fail(new Error("golemd response aborted")));
        res.on("end",()=>{clearTimeout(timer);resolve({status:res.statusCode||0,headers:res.headers,body:Buffer.concat(chunks)})});
      });
      // An absolute deadline, not socket inactivity: trickled bytes must not
      // keep a cancellation/status request alive indefinitely.
      timer=setTimeout(()=>{
        const error=new Error("golemd request deadline exceeded; outcome may be uncertain");
        fail(error);req.destroy(error);
      },this.limits.timeoutMs);
      req.on("error",fail);if(payload)req.write(payload);req.end();
    })
  }
  async json(method:string,path:string,body?:unknown):Promise<any>{const r=await this.raw(method,path,body);const text=Buffer.from(r.body).toString("utf8");if(r.status<200||r.status>=300)throw new Error(`golemd ${r.status}: ${text.slice(0,1000)}`);return text?JSON.parse(text):null}
  capabilities():Promise<Capabilities>{return this.json("GET","/v1/capabilities")}
  async dispatch(p:Dispatch):Promise<any>{const c=await this.capabilities();const h=c.harnesses[p.harness];if(!h)throw new Error(`harness ${p.harness} is not advertised`);if(!h.models.includes(p.model))throw new Error(`model ${p.model} is not advertised for ${p.harness}`);if("project" in p.workspace&&!c.projects.some(x=>x.name===p.workspace.project))throw new Error(`project ${p.workspace.project} is not advertised`);if("repo" in p.workspace&&!c.clone_enabled)throw new Error("this golemd does not allow repository clones");return this.json("POST","/v1/jobs",p)}
  list(state?:string){return this.json("GET","/v1/jobs"+(state?`?state=${encodeURIComponent(state)}`:""))}
  // Durable, sequenced SSE. Opens GET /v1/events?since=N and invokes onEvent for
  // each `data:` frame. Resolves on stream end/abort; rejects on connect/HTTP
  // error so the caller's reconnect loop can back off. Never buffers the whole
  // response (the stream is long-lived); parses newline-framed JSON incrementally.
  streamEvents(since:number,onEvent:(e:any)=>void,signal:AbortSignal):Promise<void>{
    const unix=this.endpoint.startsWith("unix://");const p=`/v1/events?since=${Math.max(0,Math.floor(since))}`;const target=unix?new URL("http://unix"+p):new URL(this.endpoint+p);
    return new Promise((resolve,reject)=>{
      if(signal.aborted)return resolve();
      const fn=target.protocol==="https:"?httpsRequest:httpRequest;
      let headerTimer: ReturnType<typeof setTimeout> | undefined;
      const finish=(error?:Error)=>{clearTimeout(headerTimer);signal.removeEventListener("abort",abort);if(error)reject(error);else resolve()};
      const abort=()=>{finish();req.destroy()};
      const req=fn({protocol:target.protocol,hostname:target.hostname,port:target.port,path:target.pathname+target.search,method:"GET",socketPath:unix?this.endpoint.slice(7):undefined,headers:{accept:"text/event-stream",...(this.token?{authorization:`Bearer ${this.token}`}:{})}},res=>{
        clearTimeout(headerTimer);
        if((res.statusCode||0)!==200){finish(new Error(`golemd events ${res.statusCode}`));res.destroy();return}
        let buf="";res.setEncoding("utf8");
        res.on("data",chunk=>{
          buf+=chunk;
          // Check the entire unparsed buffer BEFORE splitting. A peer that never
          // sends a newline cannot grow memory indefinitely.
          if(Buffer.byteLength(buf)>this.limits.responseBytes){
            const error=new Error("golemd event frame exceeds byte budget");
            finish(error);res.destroy(error);req.destroy(error);return;
          }
          let i;
          while((i=buf.indexOf("\n"))>=0){
            const line=buf.slice(0,i).replace(/\r$/,"");buf=buf.slice(i+1);
            if(line.startsWith("data:")){
              const j=line.slice(5).trim();if(!j)continue;
              let event;try{event=JSON.parse(j)}catch{continue}
              try{onEvent(event)}catch(error){
                // Consumer failure is not malformed JSON. Disconnect so the
                // durable cursor/reconciliation path can retry the event.
                finish(error instanceof Error?error:new Error(String(error)));req.destroy();return;
              }
            }
          }
        });
        res.on("end",()=>finish());res.on("error",finish);
        res.on("aborted",()=>finish(new Error("golemd events aborted")));
      });
      req.on("error",finish);
      headerTimer=setTimeout(()=>{const error=new Error("golemd events connect deadline exceeded");finish(error);req.destroy(error)},this.limits.timeoutMs);
      req.setTimeout(this.limits.timeoutMs,()=>{const error=new Error("golemd events idle deadline exceeded");finish(error);req.destroy(error)});
      signal.addEventListener("abort",abort,{once:true});
      req.end();
    })
  }
  status(id:string){return this.json("GET",`/v1/jobs/${encodeURIComponent(id)}`)}
  answer(id:string,body:{idempotency_key:string;question_id:string;text:string}){return this.json("POST",`/v1/jobs/${encodeURIComponent(id)}/answer`,body)}
  steer(id:string,text:string){return this.json("POST",`/v1/jobs/${encodeURIComponent(id)}/steer`,{text})}
  cancel(id:string){return this.json("POST",`/v1/jobs/${encodeURIComponent(id)}/cancel`,{})}
  artifacts(id:string){return this.json("GET",`/v1/jobs/${encodeURIComponent(id)}/artifacts`)}
  async fetchArtifact(id:string,path:string){const safe=path.split("/");if(safe.some(x=>!x||x==="."||x===".."||x.includes("\\")))throw new Error("invalid artifact path");const r=await this.raw("GET",`/v1/jobs/${encodeURIComponent(id)}/artifacts/${safe.map(encodeURIComponent).join("/")}`);if(r.status<200||r.status>=300)throw new Error(`golemd ${r.status}`);return r.body}
}
