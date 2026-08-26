import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ConfigError, applyEnvironment, envName, loadConfig, redactConfig, validateConfig } from "../src/index.ts";
let dirs:string[]=[]; afterEach(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});dirs=[]});

describe("configuration",()=>{
  test("loads TOML, defaults, nested theme, and environment overrides",async()=>{
    const d=mkdtempSync(join(tmpdir(),"familiar-config-"));dirs.push(d);const p=join(d,"familiar.toml");
    writeFileSync(p,`[familiar]\ndebug_level="off"\n[fetch]\nallow_private=true\n[herdr]\nsession="familiar"\nconfig_path="./state/herdr/config.toml"\n[tiamat]\nurl="https://router.example"\ntoken_file="/run/secrets/tiamat"\npoll_seconds=300
[subagent]
mode="herdr"
model="anthropic/claude-haiku-4-5"
timeout=1800
dir="./state/subagents"
session_dir="./state/pi/subagent-sessions"
[anthropic]
claude_oauth_token="placeholder"\n[theme.ansi]\nbright_blue="#abcdef"\n`);chmodSync(p,0o600);
    const loaded=await loadConfig(p,{env:{FAMILIAR_SUBSCRIBER_PORT:"4321"}});
    expect(loaded.config.familiar?.subscriber_port).toBe(4321);expect(loaded.config.fetch?.allow_private).toBe(true);expect(loaded.config.theme?.ansi?.bright_blue).toBe("#abcdef");expect(loaded.config.herdr?.session).toBe("familiar");expect(loaded.config.subagent?.timeout).toBe(1800);expect(loaded.config.anthropic?.claude_oauth_token).toBe("placeholder");expect(loaded.environment.FAMILIAR_SUBSCRIBER_PORT).toBe("4321");expect(loaded.environment.FAMILIAR_TIAMAT_TOKEN_FILE).toBe("/run/secrets/tiamat");
  });
  test("loads the repository example with every canonical table",async()=>{
    const repo=join(dirname(fileURLToPath(import.meta.url)),"../../..");
    const loaded=await loadConfig(join(repo,"familiar.toml.example"),{env:{},defaults:{},requirePrivateMode:false});
    expect(loaded.source).toBe("file");
    expect(loaded.config.server).toEqual({});
    expect(loaded.config.plugins).toBeUndefined();
    const plugins={golem:{git:"https://example.invalid/golem",rev:"0123456789abcdef0123456789abcdef01234567",env:{GOLEM_DB:"/state/golem.db"}}};
    expect(validateConfig({server:{config:"server.toml",listen:"127.0.0.1:9940"},plugins})).toEqual({server:{config:"server.toml",listen:"127.0.0.1:9940"},plugins});
    expect(()=>validateConfig({plugins:{golem:{path:"/g",git:"x",rev:"0123456789abcdef0123456789abcdef01234567"}}})).toThrow(ConfigError);
  });
  test("canonical environment naming is deterministic",()=>expect(envName(["theme","ansi","bright-blue"])).toBe("FAMILIAR_THEME_ANSI_BRIGHT_BLUE"));
  test("rejects malformed, unknown, and invalid settings",()=>{
    expect(()=>validateConfig({flat:1})).toThrow(ConfigError);expect(()=>validateConfig({wat:{key:1}})).toThrow("invalid Familiar configuration");
    expect(()=>applyEnvironment({fetch:{}},{FAMILIAR_FETCH_ALLOW_PRIVATE:"maybe"})).toThrow("true or false");
  });
  test("requires private file mode and suppresses TOML contents",async()=>{
    const d=mkdtempSync(join(tmpdir(),"familiar-config-"));dirs.push(d);const p=join(d,"familiar.toml");writeFileSync(p,"[tts]\nvoice='af_exo'\n");chmodSync(p,0o644);expect(loadConfig(p,{env:{}})).rejects.toThrow("0600");chmodSync(p,0o600);expect((await loadConfig(p,{env:{}})).config.tts?.voice).toBe("af_exo");writeFileSync(p,"[anthropic]\napi_key='never-print-this\n");let message="";try{await loadConfig(p,{env:{}})}catch(e){message=String(e)}expect(message).not.toContain("never-print-this");expect(message).toContain("contents suppressed");
  });
  test("redacts credentials without mutating input",()=>{const c={brave:{api_key:"secret"},anthropic:{auth_token:"token"}};const r=redactConfig(c);expect(r.brave.api_key).toBe("[REDACTED]");expect(r.anthropic.auth_token).toBe("[REDACTED]");expect(c.brave.api_key).toBe("secret")});
});
