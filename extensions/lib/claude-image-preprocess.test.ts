import { describe, expect, test } from "bun:test";
import * as zlib from "node:zlib";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  preprocessProjectionImages,
  CLAUDE_INGEST_FINAL_BYTES,
  CLAUDE_INGEST_MAX_DIMENSION,
  ClaudeImagePreprocessError,
  CLAUDE_DECODE_MAX_PIXELS,
  CLAUDE_INGEST_MAX_SOURCE_BYTES,
  CLAUDE_IMAGE_CACHE_BYTES,
  claudeImageCacheStats,
  clearClaudeImageCache,
} from "./claude-image-preprocess.ts";
import { imageDimensions } from "./image-policy.ts";
import type { Message } from "./claude-projection.ts";

function crc32(buf: Buffer): number { let c=~0; for(const x of buf){c^=x;for(let k=0;k<8;k++)c=(c>>>1)^(0xedb88320&-(c&1));} return (~c)>>>0; }
function chunk(type:string,data:Buffer):Buffer { const t=Buffer.from(type),n=Buffer.alloc(4),crc=Buffer.alloc(4);n.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([n,t,data,crc]); }
function png(w:number,h:number,entropy=false):Buffer { const sig=Buffer.from([137,80,78,71,13,10,26,10]),ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;let x=0x12345678;const rows=[];for(let y=0;y<h;y++){const r=Buffer.allocUnsafe(1+w*3);r[0]=0;for(let i=1;i<r.length;i++){if(entropy){x^=x<<13;x^=x>>>17;x^=x<<5;r[i]=x&255;}else r[i]=(i+y)%16<8?40:180;}rows.push(r);}return Buffer.concat([sig,chunk("IHDR",ihdr),chunk("IDAT",zlib.deflateSync(Buffer.concat(rows),{level:6})),chunk("IEND",Buffer.alloc(0))]); }
function alphaPng(w:number,h:number):Buffer { const sig=Buffer.from([137,80,78,71,13,10,26,10]),ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;let x=0x87654321;const raw=Buffer.alloc((1+w*4)*h);for(let y=0;y<h;y++){const o=y*(1+w*4);for(let i=1;i<=w*4;i++){x^=x<<13;x^=x>>>17;x^=x<<5;raw[o+i]=x&255;}}return Buffer.concat([sig,chunk("IHDR",ihdr),chunk("IDAT",zlib.deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]); }
function trnsPng(w:number,h:number,colorType:0|2|3,transparent:boolean):Buffer { const sig=Buffer.from([137,80,78,71,13,10,26,10]),ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=colorType;const bpp=colorType===2?3:1,raw=Buffer.alloc((1+w*bpp)*h);let x=0x13579bdf;for(let y=0;y<h;y++){const o=y*(1+w*bpp);for(let i=1;i<=w*bpp;i++){x^=x<<13;x^=x>>>17;x^=x<<5;raw[o+i]=x&255;}}const extra:Buffer[]=[];if(colorType===3){const pal=Buffer.alloc(768);for(let i=0;i<pal.length;i++)pal[i]=i&255;extra.push(chunk("PLTE",pal),chunk("tRNS",Buffer.from([transparent?0:255])));}else if(transparent)extra.push(chunk("tRNS",Buffer.alloc(colorType===0?2:6)));return Buffer.concat([sig,chunk("IHDR",ihdr),...extra,chunk("IDAT",zlib.deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]); }
function webpChunks(buf:Buffer):{kind:string,data:Buffer}[]{const out=[];for(let p=12;p+8<=buf.length;){const kind=buf.toString("ascii",p,p+4),n=buf.readUInt32LE(p+4);out.push({kind,data:buf.subarray(p+8,p+8+n)});p+=8+n+(n&1);}return out;}
function webpChunk(kind:string,data:Buffer,pad=0):Buffer {const h=Buffer.alloc(8);h.write(kind,0,"ascii");h.writeUInt32LE(data.length,4);return Buffer.concat([h,data,...(data.length&1?[Buffer.from([pad])]:[])]);}
function makeWebp(chunks:{kind:string,data:Buffer,pad?:number}[]):Buffer {const body=Buffer.concat([Buffer.from("WEBP"),...chunks.map(c=>webpChunk(c.kind,c.data,c.pad))]),h=Buffer.alloc(8);h.write("RIFF");h.writeUInt32LE(body.length,4);return Buffer.concat([h,body]);}
function vp8xData(alpha=false):Buffer {const d=Buffer.alloc(10);if(alpha)d[0]=0x10;d.writeUIntLE(15,4,3);d.writeUIntLE(15,7,3);return d;}
function losslessWebp(input:Buffer):Buffer { const p=spawnSync("ffmpeg",["-hide_banner","-loglevel","error","-i","pipe:0","-frames:v","1","-c:v","libwebp","-lossless","1","-compression_level","6","-f","webp","pipe:1"],{input,maxBuffer:20*1024*1024});if(p.status!==0)throw Error(String(p.stderr));return p.stdout; }
const direct=(buf:Buffer):Message=>({id:"u",role:"user",content:[{type:"image",imageData:buf.toString("base64"),imageMediaType:"image/png"}]});

function ffmpegConvert(input:Buffer,codec:string):Buffer { const p=spawnSync("ffmpeg",["-hide_banner","-loglevel","error","-i","pipe:0","-frames:v","1","-c:v",codec,"-f","image2pipe","pipe:1"],{input,maxBuffer:10*1024*1024});if(p.status!==0)throw Error(String(p.stderr));return p.stdout; }
function withOrientation(jpeg:Buffer,value=6):Buffer { const p=Buffer.alloc(32);p.write("Exif\0\0",0,"binary");p.write("MM",6);p.writeUInt16BE(42,8);p.writeUInt32BE(8,10);p.writeUInt16BE(1,14);p.writeUInt16BE(0x0112,16);p.writeUInt16BE(3,18);p.writeUInt32BE(1,20);p.writeUInt16BE(value,24);const seg=Buffer.alloc(4);seg[0]=0xff;seg[1]=0xe1;seg.writeUInt16BE(p.length+2,2);return Buffer.concat([jpeg.subarray(0,2),seg,p,jpeg.subarray(2)]); }

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

  test("small JPEG, WebP and single-frame GIF are decoded then preserved",()=>{
    for(const [codec,mediaType] of [["mjpeg","image/jpeg"],["libwebp","image/webp"],["gif","image/gif"]]){
      const b=ffmpegConvert(png(16,12),codec),m=direct(b);m.content[0].imageMediaType=mediaType;
      expect(projectedImage(preprocessProjectionImages([m])[0]).data.equals(b)).toBe(true);
    }
  });

  test("EXIF orientation is preserved on fast path and stripped after transform",()=>{
    const small=withOrientation(ffmpegConvert(png(20,10),"mjpeg"));
    const sm=direct(small);sm.content[0].imageMediaType="image/jpeg";
    expect(projectedImage(preprocessProjectionImages([sm])[0]).data.includes(Buffer.from("Exif"))).toBe(true);
    const large=withOrientation(ffmpegConvert(png(2101,10),"mjpeg"));
    const lm=direct(large);lm.content[0].imageMediaType="image/jpeg";
    const out=projectedImage(preprocessProjectionImages([lm])[0]).data;
    expect(out.includes(Buffer.from("Exif"))).toBe(false);
    expect(Math.max(...Object.values(imageDimensions(out)!))).toBeLessThanOrEqual(2000);
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

  test("small corrupt and magic/media-mismatched inputs never take the fast path",()=>{
    const corrupt=direct(Buffer.concat([png(10,10).subarray(0,35),Buffer.from("truncated")]));
    expect(()=>preprocessProjectionImages([corrupt])).toThrow(/decode\/encode failed/);
    const mislabeled=direct(png(10,10)); mislabeled.content[0].imageMediaType="image/jpeg";
    expect(()=>preprocessProjectionImages([mislabeled])).toThrow(/declared image\/jpeg.*image\/png/);
  });

  test("dimension and pixel bombs fail before decoder work",()=>{
    const b=png(1,1); b.writeUInt32BE(8001,16);
    let calls=0;
    expect(()=>preprocessProjectionImages([direct(b)],{run:()=>{calls++;return Buffer.alloc(0);}})).toThrow(/decode safety/);
    expect(calls).toBe(0);
    expect(CLAUDE_DECODE_MAX_PIXELS).toBe(16_000_000);
  });

  test("ffmpeg timeout, signal, nonzero exit and output cap are explicit",()=>{
    const dir=mkdtempSync(join(tmpdir(),"image-runner-test-"));
    const script=(name:string,body:string)=>{const p=join(dir,name);writeFileSync(p,"#!/bin/sh\n"+body,{mode:0o755});return p;};
    const b=png(2,2);
    expect(()=>preprocessProjectionImages([direct(b)],{ffmpegPath:script("slow","sleep 2\n"),ffmpegTimeoutMs:30})).toThrow(/timed out/);
    expect(()=>preprocessProjectionImages([direct(b)],{ffmpegPath:script("signal","kill -TERM $$\n")})).toThrow(/terminated by SIGTERM/);
    expect(()=>preprocessProjectionImages([direct(b)],{ffmpegPath:script("fail","echo decoder-broke >&2\nexit 7\n")})).toThrow(/decoder-broke/);
    expect(()=>preprocessProjectionImages([direct(b)],{ffmpegPath:script("flood","head -c 43000000 /dev/zero\n")})).toThrow(/cannot run image preprocessor/);
  });

  test("aggregate preprocessing deadline bounds many sequential decodes",()=>{
    const messages=[direct(png(2,2)),direct(png(3,3)),direct(png(4,4))];
    expect(()=>preprocessProjectionImages(messages,{totalTimeoutMs:15,run:()=>{const until=Date.now()+10;while(Date.now()<until){}return Buffer.alloc(0);}})).toThrow(/total work deadline/);
  });

  test("exact/over 512000-byte and 32-MiB source boundaries",()=>{
    const tiny=png(2,2);
    const atFinal=Buffer.concat([tiny,Buffer.alloc(CLAUDE_INGEST_FINAL_BYTES-tiny.length)]);
    expect(projectedImage(preprocessProjectionImages([direct(atFinal)])[0]).data.length).toBe(CLAUDE_INGEST_FINAL_BYTES);
    const overFinal=Buffer.concat([atFinal,Buffer.alloc(1)]);
    expect(projectedImage(preprocessProjectionImages([direct(overFinal)])[0]).data.length).toBeLessThanOrEqual(CLAUDE_INGEST_FINAL_BYTES);
    const atSource=Buffer.concat([tiny,Buffer.alloc(CLAUDE_INGEST_MAX_SOURCE_BYTES-tiny.length)]);
    const encodedTiny=png(1,1); let calls=0;
    preprocessProjectionImages([direct(atSource)],{run:(_b,args)=>{calls++;return args.includes("image2pipe")?encodedTiny:Buffer.alloc(0);}});
    expect(calls).toBeGreaterThan(0);
    const overSource=Buffer.concat([atSource,Buffer.alloc(1)]); calls=0;
    expect(()=>preprocessProjectionImages([direct(overSource)],{run:()=>{calls++;return Buffer.alloc(0);}})).toThrow(/32 MiB/);
    expect(calls).toBe(0);
  });

  test("exact 2000px is preserved; 2001px is resized",()=>{
    const exact=png(2000,1), over=png(2001,1);
    expect(projectedImage(preprocessProjectionImages([direct(exact)])[0]).data.equals(exact)).toBe(true);
    expect(imageDimensions(projectedImage(preprocessProjectionImages([direct(over)])[0]).data)?.w).toBe(2000);
  });

  test("alpha that cannot fit losslessly is rejected instead of JPEG-flattened",()=>{
    const b=alphaPng(500,500); expect(b.length).toBeGreaterThan(CLAUDE_INGEST_FINAL_BYTES);
    expect(()=>preprocessProjectionImages([direct(b)])).toThrow(/refusing silent JPEG alpha loss/);
  });

  test("over-budget PNG tRNS transparency never falls through to JPEG",()=>{
    for(const colorType of [3,0,2] as const){
      clearClaudeImageCache(); const b=trnsPng(900,700,colorType,true);
      expect(b.length).toBeGreaterThan(CLAUDE_INGEST_FINAL_BYTES);
      expect(()=>preprocessProjectionImages([direct(b)])).toThrow(/refusing silent JPEG alpha loss/);
    }
  });

  test("opaque indexed/grayscale/RGB PNG controls are not over-rejected",()=>{
    for(const colorType of [3,0,2] as const){
      clearClaudeImageCache(); const b=trnsPng(900,700,colorType,false);
      expect(b.length).toBeGreaterThan(CLAUDE_INGEST_FINAL_BYTES);
      const out=projectedImage(preprocessProjectionImages([direct(b)])[0]);
      expect(out.data.length).toBeLessThanOrEqual(CLAUDE_INGEST_FINAL_BYTES);
      expect(out.mediaType).toBe("image/jpeg");
    }
  });

  test("over-budget intrinsic-alpha VP8L rejects before JPEG; opaque VP8L may fall back",()=>{
    clearClaudeImageCache(); const alpha=losslessWebp(alphaPng(900,700));
    expect(alpha.toString("ascii",12,16)).toBe("VP8L");
    expect(alpha.includes(Buffer.from("ALPH"))).toBe(false);
    expect(alpha.includes(Buffer.from("VP8X"))).toBe(false);
    expect(alpha.length).toBeGreaterThan(CLAUDE_INGEST_FINAL_BYTES);
    const am=direct(alpha);am.content[0].imageMediaType="image/webp";
    expect(()=>preprocessProjectionImages([am])).toThrow(/refusing silent JPEG alpha loss/);

    clearClaudeImageCache(); const opaque=losslessWebp(png(900,700,true));
    expect(opaque.toString("ascii",12,16)).toBe("VP8L");
    expect(opaque.includes(Buffer.from("ALPH"))).toBe(false);
    expect(opaque.includes(Buffer.from("VP8X"))).toBe(false);
    expect(opaque.length).toBeGreaterThan(CLAUDE_INGEST_FINAL_BYTES);
    const om=direct(opaque);om.content[0].imageMediaType="image/webp";
    const out=projectedImage(preprocessProjectionImages([om])[0]);
    expect(out.data.length).toBeLessThanOrEqual(CLAUDE_INGEST_FINAL_BYTES);
  });

  test("malformed PNG transparency chunk bounds fail explicitly",()=>{
    const b=trnsPng(10,10,0,true); b.writeUInt32BE(0xffffffff,33);
    expect(()=>preprocessProjectionImages([direct(b)],{run:()=>Buffer.alloc(0)})).toThrow(/truncated or oversized chunk/);
  });

  test("strict WebP structure rejects padding, ordering, uniqueness and extent attacks",()=>{
    const opaque=ffmpegConvert(png(16,16),"libwebp"), oc=webpChunks(opaque), vp8=oc.find(c=>c.kind==="VP8 ")!.data;
    const lossless=losslessWebp(png(16,16)), vp8l=webpChunks(lossless).find(c=>c.kind==="VP8L")!.data;
    const alph=Buffer.from([0]);
    const bad=(b:Buffer,re:RegExp)=>{const m=direct(b);m.content[0].imageMediaType="image/webp";expect(()=>preprocessProjectionImages([m],{run:()=>Buffer.alloc(0)})).toThrow(re);};

    const odd=vp8l.length&1?vp8l:Buffer.concat([vp8l,Buffer.from([0])]);
    bad(makeWebp([{kind:"VP8L",data:odd,pad:7}]),/padding byte must be zero/);
    bad(makeWebp([{kind:"VP8X",data:vp8xData(true)},{kind:"VP8 ",data:vp8},{kind:"ALPH",data:alph}]),/ALPH must immediately precede/);
    bad(makeWebp([{kind:"VP8X",data:vp8xData(true)},{kind:"ALPH",data:alph},{kind:"ALPH",data:alph},{kind:"VP8 ",data:vp8}]),/duplicate ALPH/);
    bad(makeWebp([{kind:"VP8 ",data:vp8},{kind:"VP8 ",data:vp8}]),/exactly one VP8 or VP8L/);
    bad(makeWebp([{kind:"VP8 ",data:vp8},{kind:"VP8L",data:vp8l}]),/exactly one VP8 or VP8L/);
    bad(makeWebp([{kind:"VP8 ",data:vp8},{kind:"VP8X",data:vp8xData()}]),/VP8X chunk must be first/);
    bad(makeWebp([{kind:"VP8X",data:vp8xData()},{kind:"VP8X",data:vp8xData()},{kind:"VP8 ",data:vp8}]),/duplicate VP8X/);
    bad(Buffer.concat([opaque,Buffer.from([0])]),/RIFF extent must exactly match/);
    const truncated=Buffer.from(opaque);truncated.writeUInt32LE(truncated.readUInt32LE(4)+2,4);bad(truncated,/RIFF extent must exactly match/);
  });

  test("VP8X rejects every reserved flag and reserved-24-bit violation",()=>{
    const opaque=ffmpegConvert(png(16,16),"libwebp"), vp8=webpChunks(opaque).find(c=>c.kind==="VP8 ")!.data;
    const bad=(data:Buffer)=>{const m=direct(makeWebp([{kind:"VP8X",data},{kind:"VP8 ",data:vp8}]));m.content[0].imageMediaType="image/webp";expect(()=>preprocessProjectionImages([m],{run:()=>Buffer.alloc(0)})).toThrow(/malformed VP8X/);};
    for(const bit of [0x80,0x40,0x01]){const x=vp8xData();x[0]=bit;bad(x);}
    for(const byte of [1,2,3]){const x=vp8xData();x[byte]=1;bad(x);}
  });

  test("WebP accepts RFC-valid out-of-order EXIF/XMP and ignores ANIM text in payload",()=>{
    const opaque=ffmpegConvert(png(16,16),"libwebp"), vp8=webpChunks(opaque).find(c=>c.kind==="VP8 ")!.data;
    const exif=Buffer.from("Exif\0\0MM\0*\0\0\0\b\0\0\0\0\0\0","binary"), xmp=Buffer.from("<x:xmpmeta/>");
    const accepted=[
      makeWebp([{kind:"VP8X",data:Object.assign(vp8xData(),{[0]:0x08})},{kind:"EXIF",data:exif},{kind:"VP8 ",data:vp8}]),
      makeWebp([{kind:"VP8X",data:Object.assign(vp8xData(),{[0]:0x0c})},{kind:"VP8 ",data:vp8},{kind:"XMP ",data:xmp},{kind:"EXIF",data:exif}]),
      makeWebp([{kind:"VP8X",data:vp8xData()},{kind:"VP8 ",data:vp8},{kind:"ZZZZ",data:Buffer.from("ANIM")}]),
    ];
    for(const b of accepted){const m=direct(b);m.content[0].imageMediaType="image/webp";expect(projectedImage(preprocessProjectionImages([m],{run:()=>Buffer.alloc(0)})[0]).data.equals(b)).toBe(true);}
  });

  test("WebP retains metadata uniqueness/flags and detects only parsed animation controls",()=>{
    const opaque=ffmpegConvert(png(16,16),"libwebp"), vp8=webpChunks(opaque).find(c=>c.kind==="VP8 ")!.data, exif=Buffer.from("Exif");
    const bad=(b:Buffer,re:RegExp)=>{const m=direct(b);m.content[0].imageMediaType="image/webp";expect(()=>preprocessProjectionImages([m],{run:()=>Buffer.alloc(0)})).toThrow(re);};
    const exifX=vp8xData();exifX[0]=0x08;
    bad(makeWebp([{kind:"VP8X",data:exifX},{kind:"EXIF",data:exif},{kind:"VP8 ",data:vp8},{kind:"EXIF",data:exif}]),/duplicate EXIF/);
    bad(makeWebp([{kind:"VP8X",data:exifX},{kind:"VP8 ",data:vp8}]),/feature flags do not match/);
    bad(makeWebp([{kind:"VP8X",data:vp8xData()},{kind:"VP8 ",data:vp8},{kind:"EXIF",data:exif}]),/feature flags do not match/);
    for(const kind of ["ANIM","ANMF"]){bad(makeWebp([{kind:"VP8X",data:vp8xData()},{kind,data:Buffer.alloc(0)},{kind:"VP8 ",data:vp8}]),/animated image\/webp/);}
    const animX=vp8xData();animX[0]=0x02;
    bad(makeWebp([{kind:"VP8X",data:animX},{kind:"VP8 ",data:vp8}]),/animated image\/webp/);
    bad(makeWebp([{kind:"VP8X",data:vp8xData()},{kind:"ANIM",data:Buffer.alloc(0)},{kind:"ANIM",data:Buffer.alloc(0)},{kind:"VP8 ",data:vp8}]),/animated image\/webp/);
  });

  test("strict WebP parser retains valid opaque and external-alpha controls",()=>{
    const opaque=ffmpegConvert(png(16,16),"libwebp"), om=direct(opaque);om.content[0].imageMediaType="image/webp";
    expect(projectedImage(preprocessProjectionImages([om])[0]).data.equals(opaque)).toBe(true);
    const alpha=ffmpegConvert(alphaPng(16,16),"libwebp"), kinds=webpChunks(alpha).map(c=>c.kind);
    expect(kinds).toEqual(["VP8X","ALPH","VP8 "]);
    const am=direct(alpha);am.content[0].imageMediaType="image/webp";
    expect(projectedImage(preprocessProjectionImages([am])[0]).data.equals(alpha)).toBe(true);
  });

  test("animated GIF/WebP are rejected instead of silently losing frames",()=>{
    const gif=Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAEALAAAAAABAAEAAAICRAEAIfkEAQAAAQAsAAAAAAEAAQAAAgJEAQA7","base64");
    const gm=direct(gif); gm.content[0].imageMediaType="image/gif";
    expect(()=>preprocessProjectionImages([gm])).toThrow(/animated image\/gif/);
    const p=spawnSync("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc=size=16x16:rate=2","-frames:v","2","-loop","0","-c:v","libwebp_anim","-f","webp","pipe:1"],{maxBuffer:10*1024*1024});
    expect(p.status).toBe(0);
    const wm=direct(p.stdout);wm.content[0].imageMediaType="image/webp";
    expect(()=>preprocessProjectionImages([wm])).toThrow(/animated image\/webp/);
  });

  test("encoder and final-decoder failures remain explicit",()=>{
    clearClaudeImageCache(); const source=png(2001,1);let n=0;
    expect(()=>preprocessProjectionImages([direct(source)],{run:()=>{if(++n===1)return Buffer.alloc(0);throw new ClaudeImagePreprocessError("encoder failed");}})).toThrow(/encoder failed/);
    clearClaudeImageCache(); n=0;const output=png(1,1);
    expect(()=>preprocessProjectionImages([direct(source)],{run:(_b,args)=>{n++;if(n===1)return Buffer.alloc(0);if(args.includes("image2pipe"))return output;throw new ClaudeImagePreprocessError("final decode failed");}})).toThrow(/final decode failed/);
  });

  test("cold processes produce identical output (not cache-hit repetition)",()=>{
    const dir=mkdtempSync(join(tmpdir(),"image-cold-test-")), input=join(dir,"in.png");
    writeFileSync(input,png(2100,110));
    const code=`import {readFileSync} from "node:fs"; import {createHash} from "node:crypto"; import {preprocessProjectionImages} from "./extensions/lib/claude-image-preprocess.ts"; const b=readFileSync(process.argv[1]); const m=[{id:"u",role:"user",content:[{type:"image",imageData:b.toString("base64"),imageMediaType:"image/png"}]}]; const d=Buffer.from(preprocessProjectionImages(m)[0].content[0].imageData,"base64"); console.log(createHash("sha256").update(d).digest("hex"));`;
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const cold=()=>{const p=spawnSync("bun",["-e",code,input],{cwd:repoRoot,encoding:"utf8"});expect(p.status).toBe(0);return p.stdout.trim();};
    expect(cold()).toBe(cold());
  });

  test("cache has a real retained-byte bound and can be wiped",()=>{
    clearClaudeImageCache();
    for(let i=0;i<12;i++) preprocessProjectionImages([direct(png(2100,2+i))]);
    expect(claudeImageCacheStats().retainedBytes).toBeLessThanOrEqual(CLAUDE_IMAGE_CACHE_BYTES);
    expect(claudeImageCacheStats().entries).toBeGreaterThan(0);
    clearClaudeImageCache();
    expect(claudeImageCacheStats()).toEqual({entries:0,retainedBytes:0});
  });
});
