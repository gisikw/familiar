import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path"; import { tmpdir } from "node:os";
import { ContinuityValidationError, FileContinuityStore } from "../src/index.ts";
let dirs:string[]=[];const root=()=>{const d=mkdtempSync(join(tmpdir(),"continuity-"));dirs.push(d);return d};afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
const stamp="2026-08-21T20:00:00.000Z";

describe("file continuity store",()=>{
 test("round trips canon, append, handoffs, and client preferences",async()=>{const s=new FileContinuityStore(root(),{now:()=>new Date("2026-08-22T00:00:00Z")});await s.writeCanon({id:"10-continuity",title:"Continuity",body:"First",createdAt:stamp,updatedAt:stamp,tags:["identity"],enabled:true});const c=await s.appendCanon("10-continuity","Second");expect(c.body).toContain("First\n\nSecond");expect((await s.listCanon()).length).toBe(1);const h=await s.appendHandoff({body:"What remains",sessionId:"session-1",reason:"compaction"});expect((await s.readHandoff(h.id))?.body).toBe("What remains");await s.writePreferences({deviceId:"phone",clientId:"ios",updatedAt:stamp,voiceOutput:true,terminal:{cols:80}});expect((await s.readPreferences("phone","ios"))?.voiceOutput).toBe(true)});
 test("rejects malformed models and traversal ids",async()=>{const s=new FileContinuityStore(root());expect(s.writeCanon({id:"../escape"} as any)).rejects.toBeInstanceOf(ContinuityValidationError);expect(s.appendHandoff({body:""})).rejects.toThrow("body")});
 test("isolates externally malformed files while direct reads report corruption",async()=>{const r=root(),s=new FileContinuityStore(r);writeFileSync(join(r,"canon","bad.json"),"{");expect(await s.listCanon()).toEqual([]);expect(s.readCanon("bad")).rejects.toThrow()});
 test("atomic crash before rename leaves prior state intact and no temp state",async()=>{const r=root();const initial=new FileContinuityStore(r);const old={id:"anchor",title:"Anchor",body:"old",createdAt:stamp,updatedAt:stamp,tags:[],enabled:true};await initial.writeCanon(old);const crashing=new FileContinuityStore(r,{hooks:{beforeRename(){throw new Error("simulated crash")}}});await expect(crashing.writeCanon({...old,body:"partial"})).rejects.toThrow("simulated crash");expect(JSON.parse(readFileSync(join(r,"canon","anchor.json"),"utf8")).body).toBe("old");expect(readdirSync(join(r,"canon")).filter(n=>n.endsWith(".tmp"))).toEqual([])});
});
