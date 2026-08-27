import { TOML } from "bun";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const CANONICAL_TABLES = ["pi","familiar","herdr","server","plugins","model","llama","stt","tts","anthropic","openai","tiamat","searxng","brave","fetch","subagent","zip","theme"] as const;
export type Scalar = string | number | boolean;
export interface FamiliarConfig {
  pi?: { telemetry?: number; offline?: number; skip_version_check?: number; coding_agent_dir?: string };
  familiar?: { identity_path?: string; age_key?: string; handoff_path?: string; handoff_prompt_path?: string; worklist_dir?: string; inbox_dir?: string; log_path?: string; model_dir?: string; default_provider?: string; default_model?: string; artifact_dir?: string; subscriber_port?: number; tz?: string; debug_level?: string; use_stuff?: boolean };
  herdr?: { session?: string; config_path?: string };
  server?: { config?: string; listen?: string };
  plugins?: { golem?: { path?: string; git?: string; rev?: string; env?: Record<string,string> } };
  model?: { file?: string; url?: string };
  llama?: { base_url?: string };
  stt?: { url?: string; model_file?: string; model_url?: string };
  tts?: { url?: string; voice?: string; model_file?: string; model_url?: string };
  anthropic?: { base_url?: string; api_key?: string; auth_token?: string; claude_credentials_json?: string; claude_oauth_token?: string };
  openai?: { base_url?: string; api_key?: string };
  tiamat?: { url?: string; token_file?: string; poll_seconds?: number };
  searxng?: { url?: string };
  brave?: { api_key?: string; url?: string };
  fetch?: { allow_private?: boolean };
  subagent?: { mode?: string; model?: string; timeout?: number; dir?: string; session_dir?: string };
  zip?: { model?: string };
  theme?: ThemeConfig;
}
export interface ThemeConfig { name?: string; background?: string; surface?: string; surface_dim?: string; overlay?: string; text?: string; muted?: string; accent?: string; success?: string; warning?: string; error?: string; border?: string; border_muted?: string; selection_bg?: string; cursor?: string; cursor_text?: string; ansi?: Record<"black"|"red"|"green"|"yellow"|"blue"|"magenta"|"cyan"|"white"|"bright_black"|"bright_red"|"bright_green"|"bright_yellow"|"bright_blue"|"bright_magenta"|"bright_cyan"|"bright_white", string> }

export const DEFAULT_CONFIG: FamiliarConfig = {
  pi: { telemetry: 0, offline: 1, skip_version_check: 1 },
  familiar: { subscriber_port: 1692, default_provider: "llama.cpp", tz: "America/Chicago", debug_level: "debug" },
  fetch: { allow_private: false },
  theme: { name: "familiar-monokai-pro-spectrum" },
};

type Expected = "string"|"number"|"number|string"|"boolean"|"table";
const schema: Record<string, Record<string, Expected>> = {
  pi:{telemetry:"number|string",offline:"number|string",skip_version_check:"number|string",coding_agent_dir:"string"}, familiar:{identity_path:"string",age_key:"string",handoff_path:"string",handoff_prompt_path:"string",worklist_dir:"string",inbox_dir:"string",log_path:"string",model_dir:"string",default_provider:"string",default_model:"string",artifact_dir:"string",subscriber_port:"number",tz:"string",debug_level:"string",use_stuff:"boolean"}, herdr:{session:"string",config_path:"string"}, server:{config:"string",listen:"string"}, plugins:{golem:"table"}, model:{file:"string",url:"string"}, llama:{base_url:"string"}, stt:{url:"string",model_file:"string",model_url:"string"}, tts:{url:"string",voice:"string",model_file:"string",model_url:"string"}, anthropic:{base_url:"string",api_key:"string",auth_token:"string",claude_credentials_json:"string",claude_oauth_token:"string"}, openai:{base_url:"string",api_key:"string"}, tiamat:{url:"string",token_file:"string",poll_seconds:"number"}, searxng:{url:"string"}, brave:{api_key:"string",url:"string"}, fetch:{allow_private:"boolean"}, subagent:{mode:"string",model:"string",timeout:"number",dir:"string",session_dir:"string"}, zip:{model:"string"},
  theme:{name:"string",background:"string",surface:"string",surface_dim:"string",overlay:"string",text:"string",muted:"string",accent:"string",success:"string",warning:"string",error:"string",border:"string",border_muted:"string",selection_bg:"string",cursor:"string",cursor_text:"string",ansi:"table"},
};
const ansiKeys = ["black","red","green","yellow","blue","magenta","cyan","white","bright_black","bright_red","bright_green","bright_yellow","bright_blue","bright_magenta","bright_cyan","bright_white"];
const isObj=(v:unknown):v is Record<string,unknown>=>typeof v==="object"&&v!==null&&!Array.isArray(v);
export class ConfigError extends Error { constructor(message:string, public readonly issues:string[]=[message]) { super(message); this.name="ConfigError"; } }

export function validateConfig(value: unknown): FamiliarConfig {
  const issues:string[]=[];
  if(!isObj(value)) throw new ConfigError("configuration root must be a table");
  for(const [table,val] of Object.entries(value)) {
    if(!schema[table]) { issues.push(`${table}: top-level key must be a canonical table`); continue; }
    if(!isObj(val)){issues.push(`${table} must be a table`);continue;}
    for(const [key,leaf] of Object.entries(val)) {
      const expected=schema[table][key];
      if(!expected){issues.push(`${table}.${key}: unknown setting`);continue;}
      if(expected==="table") {
        if(table==="plugins"&&key==="golem"&&isObj(leaf)) {
          for(const [pk,pv] of Object.entries(leaf)) {
            if(pk==="env"&&isObj(pv)){for(const [ek,ev] of Object.entries(pv)){if(!/^[A-Z_][A-Z0-9_]*$/.test(ek))issues.push(`plugins.golem.env.${ek}: invalid environment name`);else if(typeof ev!=="string")issues.push(`plugins.golem.env.${ek} must be a string`);}continue;}
            if(!["path","git","rev"].includes(pk))issues.push(`plugins.golem.${pk}: unknown setting`);else if(typeof pv!=="string")issues.push(`plugins.golem.${pk} must be a string`);
          }
          const p=leaf as Record<string,unknown>; if(p.path!==undefined&&(p.git!==undefined||p.rev!==undefined))issues.push("plugins.golem: path and git/rev are mutually exclusive"); if(p.path===undefined&&p.git===undefined)issues.push("plugins.golem: path or git/rev is required"); if((p.git===undefined)!==(p.rev===undefined))issues.push("plugins.golem: git and rev must be supplied together"); if(typeof p.rev==="string"&&!/^[0-9a-fA-F]{40}$/.test(p.rev))issues.push("plugins.golem.rev must be an exact 40-character SHA");
          continue;
        }
        if(table!=="theme"||key!=="ansi"||!isObj(leaf)){issues.push(`${table}.${key} must be a table`);continue;}
        for(const [ak,av] of Object.entries(leaf)){if(!ansiKeys.includes(ak))issues.push(`theme.ansi.${ak}: unknown setting`);else if(typeof av!=="string")issues.push(`theme.ansi.${ak} must be a string`);}
      } else if((expected==="number|string" ? (typeof leaf!=="number" && typeof leaf!=="string") : typeof leaf!==expected) || ((expected==="number"||expected==="number|string")&&typeof leaf==="number"&&!Number.isFinite(leaf))) issues.push(`${table}.${key} must be a ${expected}`);
    }
  }
  if(issues.length) throw new ConfigError(`invalid Familiar configuration (${issues.length} ${issues.length===1?"issue":"issues"})`,issues);
  return value as FamiliarConfig;
}

function merge<T extends Record<string,any>>(base:T, overlay:T):T { const out:Record<string,any>={...base}; for(const [k,v] of Object.entries(overlay)) out[k]=isObj(v)&&isObj(out[k])?merge(out[k],v):v; return out as T; }
export function envName(pathParts: readonly string[]): string { const effective=pathParts[0]==="familiar"?pathParts.slice(1):pathParts; const flat=effective.join("_").toUpperCase().replace(/[^A-Z0-9_]/g,"_"); return flat.startsWith("FAMILIAR_")?flat:`FAMILIAR_${flat}`; }
export function flattenEnvironment(config:FamiliarConfig):Record<string,string>{ const out:Record<string,string>={}; const walk=(v:unknown,p:string[])=>{if(isObj(v)){for(const [k,x] of Object.entries(v))walk(x,[...p,k]);return;} out[envName(p)]=typeof v==="string"?v:JSON.stringify(v);}; walk(config,[]); return out; }
function parseEnv(raw:string, expected:string, setting:string):unknown { if(expected==="string")return raw; if(expected==="boolean"){if(raw==="true")return true;if(raw==="false")return false;throw new ConfigError(`${setting}: environment override must be true or false`);} const n=Number(raw);if(!Number.isFinite(n))throw new ConfigError(`${setting}: environment override must be a number`);return n; }
export function applyEnvironment(config:FamiliarConfig, env:Record<string,string|undefined>):FamiliarConfig {
  const copy=merge({} as FamiliarConfig,config);
  for(const [table,keys] of Object.entries(schema)) for(const [key,expected] of Object.entries(keys)) {
    if(expected==="table") { for(const ak of ansiKeys){const name=envName([table,key,ak]);if(env[name]!==undefined){const t=((copy as any)[table]??={});const a=(t[key]??={});a[ak]=env[name];}} continue; }
    const name=envName([table,key]); if(env[name]!==undefined){const t=((copy as any)[table]??={});t[key]=parseEnv(env[name]!,expected=== "number|string" ? "string" : expected,`${table}.${key}`);}
  }
  return validateConfig(copy);
}
export interface LoadOptions { env?:Record<string,string|undefined>; defaults?:FamiliarConfig; requirePrivateMode?:boolean; optional?:boolean }
export interface LoadedConfig { path:string; config:FamiliarConfig; environment:Record<string,string>; source:"file"|"defaults" }
export async function loadConfig(filePath="familiar.toml", options:LoadOptions={}):Promise<LoadedConfig>{
  const absolute=path.resolve(filePath); let parsed:FamiliarConfig={}; let source:"file"|"defaults"="file";
  try { const info=await stat(absolute); if(options.requirePrivateMode!==false && (info.mode&0o777)!==0o600) throw new ConfigError(`${absolute} must have mode 0600`); const text=await readFile(absolute,"utf8"); try{parsed=validateConfig(TOML.parse(text));}catch(e){if(e instanceof ConfigError)throw e;throw new ConfigError(`${absolute}: malformed TOML (contents suppressed)`);} }
  catch(e:any){if(e?.code==="ENOENT"&&options.optional!==false){source="defaults";}else throw e;}
  const withDefaults=merge((options.defaults??DEFAULT_CONFIG) as any,parsed as any) as FamiliarConfig;
  const config=applyEnvironment(withDefaults,options.env??process.env);
  return {path:absolute,config,environment:flattenEnvironment(config),source};
}

const SECRET=/(_?(api_?key|auth_?token|oauth_?token|credentials|secret|token))$/i;
export function isSecretPath(pathParts:readonly string[]):boolean{return SECRET.test(pathParts.join("_"));}
export function redactConfig<T>(value:T,replacement="[REDACTED]"):T { const walk=(v:unknown,p:string[]):unknown=>{if(isSecretPath(p)&&v!==undefined)return replacement;if(Array.isArray(v))return v.map((x,i)=>walk(x,[...p,String(i)]));if(isObj(v))return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x,[...p,k])]));return v;};return walk(value,[]) as T; }
