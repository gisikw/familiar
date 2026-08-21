import { expect, test } from "bun:test";
import * as zlib from "node:zlib";
import { claudeImageCacheStats, preprocessProjectionImages } from "./claude-image-preprocess.ts";

function crc32(buf:Buffer){let c=~0;for(const x of buf){c^=x;for(let k=0;k<8;k++)c=(c>>>1)^(0xedb88320&-(c&1));}return(~c)>>>0;}
function chunk(t:string,d:Buffer){const tb=Buffer.from(t),n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(d.length);c.writeUInt32BE(crc32(Buffer.concat([tb,d])));return Buffer.concat([n,tb,d,c]);}
function png(w:number,h:number){const ih=Buffer.alloc(13);ih.writeUInt32BE(w);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ih),chunk("IDAT",zlib.deflateSync(Buffer.alloc((w*3+1)*h))),chunk("IEND",Buffer.alloc(0))]);}

test("driver session shutdown wipes retained transformed image material", async()=>{
  const credentialKeys = [
    "FAMILIAR_ANTHROPIC_OAUTH",
    "FAMILIAR_ANTHROPIC_CLAUDE_CREDENTIALS_JSON",
    "FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "_FAMILIAR_CONFIG_EXPLICIT_ENV",
  ] as const;
  const saved = Object.fromEntries(credentialKeys.map((key) => [key, process.env[key]]));
  for (const key of credentialKeys) delete process.env[key];
  process.env.FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN="lifecycle-test-token";
  try {
    let shutdown:(()=>Promise<void>)|undefined;
    const pi:any={on:(e:string,cb:any)=>{if(e==="session_shutdown")shutdown=cb;},registerProvider(){},unregisterProvider(){}};
    const driver=(await import("../claude-driver/index.ts?cache-lifecycle-test")).default;
    await driver(pi);
    const source=png(2001,1), output=png(1,1);
    preprocessProjectionImages([{id:"u",role:"user",content:[{type:"image",imageData:source.toString("base64"),imageMediaType:"image/png"}]}],{run:(_b,args)=>args.includes("image2pipe")?output:Buffer.alloc(0)});
    expect(claudeImageCacheStats().entries).toBeGreaterThan(0);
    await shutdown!();
    expect(claudeImageCacheStats()).toEqual({entries:0,retainedBytes:0});
  } finally {
    for (const key of credentialKeys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
