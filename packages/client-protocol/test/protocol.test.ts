import { describe, expect, test } from "bun:test";
import { negotiateVersion, parseMessage, validateLegacySubmit, validateMessage } from "../src/index.ts";

describe("client protocol", () => {
  test("validates handshake and negotiates v1", () => {
    const hello = { version: 1, type: "hello", protocol: "familiar-client", supportedVersions: [2, 1], client: { id: "desktop-1" }, resume: [{ stream: "interaction", sequence: 42 }] };
    const result = validateMessage(hello);
    expect(result.ok).toBeTrue();
    if (result.ok) expect(JSON.stringify(result.value)).toBe(JSON.stringify(hello));
    expect(negotiateVersion(hello.supportedVersions)).toBe(1);
    expect(negotiateVersion([2])).toBeNull();
  });
  test("rejects malformed and unknown messages", () => {
    expect(parseMessage("{").ok).toBeFalse();
    const result = validateMessage({ version: 1, type: "terminal.resize", stream: "terminal", sequence: -1, cols: "80", rows: 24 });
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(1);
    expect(validateMessage({ type: "pi.internal" }).ok).toBeFalse();
  });
  test("covers representative server messages", () => {
    expect(validateMessage({ version:1,type:"presence.status",stream:"presence",sequence:3,sessionId:"epoch",state:"ready" }).ok).toBeTrue();
    expect(validateMessage({ version:1,type:"worklist.notification",stream:"worklist",sequence:4,id:"wl-1",priority:1,kind:"notify",summary:"done",attention:"available",createdAt:"2026-08-21T00:00:00Z" }).ok).toBeTrue();
    expect(validateMessage({ version:1,type:"voice.tts.segment",stream:"voice",sequence:5,messageId:"7",segment:0,status:"ready",audioUrl:"/segments/7/0/audio" }).ok).toBeTrue();
  });
  test("accepts current gateway submit shapes for additive migration", () => {
    expect(validateLegacySubmit({ type:"text", content:"hello", id:7 }).ok).toBeTrue();
    expect(validateLegacySubmit({ type:"audio", id:1, seq:0, data:"AA==", segments:1 }).ok).toBeTrue();
    expect(validateLegacySubmit({ type:"audio", id:1, data:"AA==" }).ok).toBeFalse();
  });
});
