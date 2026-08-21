import { describe, expect, test } from "bun:test";
import * as zlib from "node:zlib";
import {
  preprocessProjectionImages,
  CLAUDE_INGEST_FINAL_BYTES,
  CLAUDE_INGEST_MAX_DIMENSION,
  ClaudeImagePreprocessError,
} from "./claude-image-preprocess.ts";
import { imageDimensions } from "./image-policy.ts";
import type { Message } from "./claude-projection.ts";

function crc32(buf: Buffer): number { let c=~0; for(const x of buf){c^=x;for(let k=0;k<8;k++)c=(c>>>1)^(0xedb88320&-(c&1));} return (~c)>>>0; }
function chunk(type:string,data:Buffer):Buffer { const t=Buffer.from(type),n=Buffer.alloc(4),crc=Buffer.alloc(4);n.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([n,t,data,crc]); }
function png(w:number,h:number,entropy=false):Buffer { const sig=Buffer.from([137,80,78,71,13,10,26,10]),ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;let x=0x12345678;const rows=[];for(let y=0;y<h;y++){const r=Buffer.allocUnsafe(1+w*3);r[0]=0;for(let i=1;i<r.length;i++){if(entropy){x^=x<<13;x^=x>>>17;x^=x<<5;r[i]=x&255;}else r[i]=(i+y)%16<8?40:180;}rows.push(r);}return Buffer.concat([sig,chunk("IHDR",ihdr),chunk("IDAT",zlib.deflateSync(Buffer.concat(rows),{level:6})),chunk("IEND",Buffer.alloc(0))]); }
const direct=(buf:Buffer):Message=>({id:"u",role:"user",content:[{type:"image",imageData:buf.toString("base64"),imageMediaType:"image/png"}]});

function projectedImage(m: Message): { data: Buffer; mediaType: string } {
  const c=m.content[0];
  if(c.type!=="image")throw Error("expected image");
  return {data:Buffer.from(c.imageData!,"base64"),mediaType:c.imageMediaType!};
}

describe("Claude synthetic-history image preprocessing",()=>{
  test("small in-bounds image is byte-identical",()=>{
    const b=png(100,80); const msgs=[direct(b)]; const out=preprocessProjectionImages(msgs);
    expect(out).toBe(msgs);
    expect(projectedImage(out[0]).data.equals(b)).toBe(true);
  });

  test("Retina-like PNG is resized within 2000px and 500 KiB",()=>{
    const b=png(2400,1400); const out=preprocessProjectionImages([direct(b)]);
    const im=projectedImage(out[0]),dims=imageDimensions(im.data)!;
    expect(Math.max(dims.w,dims.h)).toBeLessThanOrEqual(CLAUDE_INGEST_MAX_DIMENSION);
    expect(im.data.length).toBeLessThanOrEqual(CLAUDE_INGEST_FINAL_BYTES);
    expect(im.data.equals(b)).toBe(false);
    expect(im.mediaType).toBe("image/png");
  });

  test("high-entropy image is bounded and may convert to JPEG",()=>{
    const b=png(900,700,true); expect(b.length).toBeGreaterThan(CLAUDE_INGEST_FINAL_BYTES);
    const out=preprocessProjectionImages([direct(b)]),im=projectedImage(out[0]);
    expect(im.data.length).toBeLessThanOrEqual(CLAUDE_INGEST_FINAL_BYTES);
    expect(im.mediaType).toBe("image/jpeg");
    expect(imageDimensions(im.data)).toEqual({w:900,h:700});
  });

  test("direct and tool-result history transform deterministically without mutating input",()=>{
    const b=png(2100,1200),before=b.toString("base64");
    const messages:Message[]=[direct(b),{id:"t",role:"tool",content:[{type:"tool_result",toolResultFor:"x",toolOutput:"shot",toolResultImages:[{data:before,mediaType:"image/png"}]}]}];
    const a=preprocessProjectionImages(messages),c=preprocessProjectionImages(messages);
    expect(JSON.stringify(a)).toBe(JSON.stringify(c));
    expect(messages[0].content[0].imageData).toBe(before);
    expect(messages[1].content[0].toolResultImages?.[0].data).toBe(before);
    expect(a[0].content[0].imageData).not.toBe(before);
    expect(a[1].content[0].toolResultImages?.[0].data).not.toBe(before);
  });

  test("malformed historical image remains an explicit error",()=>{
    const bad:Message={id:"u",role:"user",content:[{type:"image",imageData:"@@@",imageMediaType:"image/png"}]};
    expect(()=>preprocessProjectionImages([bad])).toThrow(/valid base64/);
  });
});
