import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceCall } from "./familiar-services.ts";
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
async function fakeService(reply: object) { const dir=mkdtempSync(join(tmpdir(),"familiar-services-client-"));const path=join(dir,"service.sock");const requests:any[]=[];const server:Server=createServer(socket=>{let input="";socket.setEncoding("utf8");socket.on("data",chunk=>{input+=chunk;const end=input.indexOf("\n");if(end<0)return;requests.push(JSON.parse(input.slice(0,end)));socket.end(`${JSON.stringify(reply)}\n`);});});await new Promise<void>((resolve,reject)=>server.listen(path,resolve).once("error",reject));cleanup.push(()=>{server.close();rmSync(dir,{recursive:true,force:true});});return{path,requests};}
describe("familiar-services request client",()=>{
 test("sends NDJSON and returns the result",async()=>{const fake=await fakeService({ok:true,result:{ready:true}});expect(await serviceCall("schedule.list",{},fake.path)).toEqual({ready:true});expect(fake.requests).toEqual([{op:"schedule.list",args:{}}]);});
 test("preserves remote errors",async()=>{const fake=await fakeService({ok:false,error:{code:"not_found",message:"missing"}});try{await serviceCall("schedule.cancel",{id:"gone"},fake.path);throw new Error("expected rejection");}catch(error){expect((error as {code?:string}).code).toBe("not_found");}});
});
