import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface CanonEntry { id:string; title:string; body:string; createdAt:string; updatedAt:string; tags:string[]; enabled:boolean; source?:string }
export interface HandoffDocument { id:string; body:string; createdAt:string; sessionId?:string; previousSessionId?:string; reason?:"manual"|"compaction"|"shutdown"|"recovery"; metadata?:Record<string,string|number|boolean|null> }
export interface DeviceClientPreferences { deviceId:string; clientId:string; updatedAt:string; displayName?:string; voiceOutput?:boolean; voice?:string; theme?:string; locale?:string; terminal?:{cols?:number;rows?:number;fontSize?:number}; values?:Record<string,string|number|boolean|null> }
export interface ContinuityStore {
  listCanon():Promise<CanonEntry[]>; readCanon(id:string):Promise<CanonEntry|null>; writeCanon(entry:CanonEntry):Promise<void>; appendCanon(id:string,markdown:string):Promise<CanonEntry>;
  listHandoffs():Promise<HandoffDocument[]>; readHandoff(id:string):Promise<HandoffDocument|null>; writeHandoff(doc:HandoffDocument):Promise<void>; appendHandoff(doc:Omit<HandoffDocument,"id"|"createdAt">&Partial<Pick<HandoffDocument,"id"|"createdAt">>):Promise<HandoffDocument>;
  listPreferences():Promise<DeviceClientPreferences[]>; readPreferences(deviceId:string,clientId:string):Promise<DeviceClientPreferences|null>; writePreferences(prefs:DeviceClientPreferences):Promise<void>;
}
export interface AtomicWriteHooks { beforeRename?:(temp:string,destination:string)=>void; afterRename?:(destination:string)=>void }
export interface FileStoreOptions { hooks?:AtomicWriteHooks; now?:()=>Date }
export class ContinuityValidationError extends Error { constructor(message:string){super(`continuity: ${message}`);this.name="ContinuityValidationError"} }

const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
function validId(id:unknown,label="id"):asserts id is string {if(typeof id!=="string"||!ID.test(id)||id==="."||id==="..")throw new ContinuityValidationError(`${label} is invalid`)}
function object(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==="object"&&!Array.isArray(v)}
function iso(v:unknown,label:string){if(typeof v!=="string"||Number.isNaN(Date.parse(v)))throw new ContinuityValidationError(`${label} must be an ISO timestamp`)}
export function validateCanon(v:unknown):CanonEntry {if(!object(v))throw new ContinuityValidationError("canon entry must be an object");validId(v.id);if(typeof v.title!=="string"||!v.title.trim())throw new ContinuityValidationError("canon title is required");if(typeof v.body!=="string")throw new ContinuityValidationError("canon body must be a string");iso(v.createdAt,"createdAt");iso(v.updatedAt,"updatedAt");if(!Array.isArray(v.tags)||v.tags.some(x=>typeof x!=="string"))throw new ContinuityValidationError("canon tags must be strings");if(typeof v.enabled!=="boolean")throw new ContinuityValidationError("canon enabled must be boolean");if(v.source!==undefined&&typeof v.source!=="string")throw new ContinuityValidationError("canon source must be a string");return v as unknown as CanonEntry}
export function validateHandoff(v:unknown):HandoffDocument {if(!object(v))throw new ContinuityValidationError("handoff must be an object");validId(v.id);if(typeof v.body!=="string"||!v.body.trim())throw new ContinuityValidationError("handoff body is required");iso(v.createdAt,"createdAt");for(const k of ["sessionId","previousSessionId"] as const)if(v[k]!==undefined&&typeof v[k]!=="string")throw new ContinuityValidationError(`${k} must be a string`);if(v.reason!==undefined&&!(["manual","compaction","shutdown","recovery"] as unknown[]).includes(v.reason))throw new ContinuityValidationError("handoff reason is invalid");if(v.metadata!==undefined&&!object(v.metadata))throw new ContinuityValidationError("handoff metadata must be an object");return v as unknown as HandoffDocument}
export function validatePreferences(v:unknown):DeviceClientPreferences {if(!object(v))throw new ContinuityValidationError("preferences must be an object");validId(v.deviceId,"deviceId");validId(v.clientId,"clientId");iso(v.updatedAt,"updatedAt");if(v.displayName!==undefined&&typeof v.displayName!=="string")throw new ContinuityValidationError("displayName must be a string");for(const k of ["voiceOutput"] as const)if(v[k]!==undefined&&typeof v[k]!=="boolean")throw new ContinuityValidationError(`${k} must be boolean`);for(const k of ["voice","theme","locale"] as const)if(v[k]!==undefined&&typeof v[k]!=="string")throw new ContinuityValidationError(`${k} must be a string`);if(v.terminal!==undefined&&!object(v.terminal))throw new ContinuityValidationError("terminal must be an object");if(v.values!==undefined&&!object(v.values))throw new ContinuityValidationError("values must be an object");return v as unknown as DeviceClientPreferences}

export function writeFileAtomic(destination:string,bytes:string,hooks:AtomicWriteHooks={}):void {
  mkdirSync(dirname(destination),{recursive:true,mode:0o700}); const temp=`${destination}.${process.pid}.${randomUUID()}.tmp`; let fd:number|undefined;
  try {fd=openSync(temp,"wx",0o600);writeFileSync(fd,bytes,"utf8");fsyncSync(fd);closeSync(fd);fd=undefined;hooks.beforeRename?.(temp,destination);renameSync(temp,destination);const dfd=openSync(dirname(destination),"r");try{fsyncSync(dfd)}finally{closeSync(dfd)}hooks.afterRename?.(destination)}
  catch(error){if(fd!==undefined)try{closeSync(fd)}catch{};try{unlinkSync(temp)}catch{};throw error}
}
function readValidated<T>(file:string,validate:(v:unknown)=>T):T|null {try{return validate(JSON.parse(readFileSync(file,"utf8")))}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e}}
function stable(value:unknown){return `${JSON.stringify(value,null,2)}\n`}

export class FileContinuityStore implements ContinuityStore {
  readonly canonDir:string;readonly handoffsDir:string;readonly preferencesDir:string;
  constructor(readonly root:string,private options:FileStoreOptions={}){this.canonDir=join(root,"canon");this.handoffsDir=join(root,"handoffs");this.preferencesDir=join(root,"preferences");for(const d of [root,this.canonDir,this.handoffsDir,this.preferencesDir])mkdirSync(d,{recursive:true,mode:0o700})}
  private now(){return (this.options.now?.()??new Date()).toISOString()}
  private file(dir:string,id:string){validId(id);return join(dir,`${id}.json`)}
  private write(file:string,value:unknown){writeFileAtomic(file,stable(value),this.options.hooks)}
  private list<T>(dir:string,validate:(v:unknown)=>T,sort:(a:T,b:T)=>number):T[]{const values:T[]=[];for(const name of readdirSync(dir).sort()){if(!name.endsWith(".json"))continue;try{const v=readValidated(join(dir,name),validate);if(v)values.push(v)}catch{/* isolate malformed/torn external files */}}return values.sort(sort)}
  async listCanon(){return this.list(this.canonDir,validateCanon,(a,b)=>a.id.localeCompare(b.id))}
  async readCanon(id:string){return readValidated(this.file(this.canonDir,id),validateCanon)}
  async writeCanon(entry:CanonEntry){this.write(this.file(this.canonDir,entry.id),validateCanon(entry))}
  async appendCanon(id:string,markdown:string){if(typeof markdown!=="string"||!markdown)throw new ContinuityValidationError("appended canon markdown is required");const old=await this.readCanon(id);if(!old)throw new ContinuityValidationError(`canon entry ${id} does not exist`);const entry={...old,body:old.body?`${old.body.replace(/\s+$/," ").trimEnd()}\n\n${markdown}`:markdown,updatedAt:this.now()};await this.writeCanon(entry);return entry}
  async listHandoffs(){return this.list(this.handoffsDir,validateHandoff,(a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))}
  async readHandoff(id:string){return readValidated(this.file(this.handoffsDir,id),validateHandoff)}
  async writeHandoff(doc:HandoffDocument){this.write(this.file(this.handoffsDir,doc.id),validateHandoff(doc))}
  async appendHandoff(input:Omit<HandoffDocument,"id"|"createdAt">&Partial<Pick<HandoffDocument,"id"|"createdAt">>){const createdAt=input.createdAt??this.now();const id=input.id??`handoff-${createdAt.replace(/[:.]/g,"-")}-${randomUUID().slice(0,8)}`;const doc=validateHandoff({...input,id,createdAt});await this.writeHandoff(doc);return doc}
  private preferenceId(deviceId:string,clientId:string){validId(deviceId,"deviceId");validId(clientId,"clientId");return `${deviceId}--${clientId}`}
  async listPreferences(){return this.list(this.preferencesDir,validatePreferences,(a,b)=>a.deviceId.localeCompare(b.deviceId)||a.clientId.localeCompare(b.clientId))}
  async readPreferences(deviceId:string,clientId:string){return readValidated(this.file(this.preferencesDir,this.preferenceId(deviceId,clientId)),validatePreferences)}
  async writePreferences(prefs:DeviceClientPreferences){validatePreferences(prefs);this.write(this.file(this.preferencesDir,this.preferenceId(prefs.deviceId,prefs.clientId)),prefs)}
}
