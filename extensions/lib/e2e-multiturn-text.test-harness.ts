// e2e-multiturn-text.test-harness.ts — verify multi-turn TEXT resume (no tools)
// through the real driver: turn 2 must reflect memory of turn 1 established via
// the projected transcript. Run:
//   nix develop .#stt -c bun run extensions/lib/e2e-multiturn-text.test-harness.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";

process.env.FAMILIAR_ANTHROPIC_OAUTH = fs.readFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8");
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_BASE_URL;
delete process.env.ANTHROPIC_AUTH_TOKEN;

let baseUrl = "";
const fakePi: any = {
  _shutdown: null as null | (() => Promise<void>),
  on(e: string, cb: any) { if (e === "session_shutdown") this._shutdown = cb; },
  registerProvider(_n: string, cfg: any) { baseUrl = cfg.baseUrl; },
  unregisterProvider() {},
};
const driver = (await import("/home/dev/.herdr/worktrees/familiar/sub-retire-tiamat-driver-jmrp/extensions/claude-driver.ts")).default;
await driver(fakePi);

async function post(body: unknown): Promise<{ event: string; data: any }[]> {
  const url = new URL(baseUrl + "/v1/messages");
  const events: { event: string; data: any }[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/json" } }, (resp) => {
      let buf = "";
      resp.on("data", (c) => { buf += c.toString(); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /event: (.*)/.exec(b)?.[1]; const da = /data: (.*)/s.exec(b)?.[1]; if (ev && da) events.push({ event: ev, data: JSON.parse(da) }); } });
      resp.on("end", resolve); resp.on("error", reject);
    });
    req.on("error", reject); req.write(JSON.stringify(body)); req.end();
  });
  return events;
}
const text = (e: { event: string; data: any }[]) => e.filter((x) => x.event === "content_block_delta" && x.data?.delta?.type === "text_delta").map((x) => x.data.delta.text).join("");

async function main() {
  let pass = true; const fail = (m: string) => { console.log("FAIL: " + m); pass = false; };
  const sys = "You are concise.";
  // Turn 1: establish a fact.
  const t1 = await post({ model: "claude-opus-4-8", max_tokens: 128, stream: true, system: sys,
    messages: [{ role: "user", content: "Remember this secret codeword: BANANA_7. Reply with just 'ok'." }] });
  console.log("TURN1 msg_starts:", t1.filter((e) => e.event === "message_start").length, "text:", JSON.stringify(text(t1).slice(0, 80)));
  if (t1.filter((e) => e.event === "message_start").length !== 1) fail("turn1 not one message");

  // Turn 2: same conversation (first user message identical → same session seed),
  // carrying the assistant reply, asks to recall.
  const t2 = await post({ model: "claude-opus-4-8", max_tokens: 128, stream: true, system: sys,
    messages: [
      { role: "user", content: "Remember this secret codeword: BANANA_7. Reply with just 'ok'." },
      { role: "assistant", content: [{ type: "text", text: text(t1) || "ok" }] },
      { role: "user", content: "What was the secret codeword? Reply with just the codeword." },
    ] });
  const t2text = text(t2);
  console.log("TURN2 msg_starts:", t2.filter((e) => e.event === "message_start").length, "text:", JSON.stringify(t2text.slice(0, 120)));
  if (!/BANANA_7/.test(t2text)) fail("turn2 did not recall the codeword from the projected transcript");
  if (t2.filter((e) => e.event === "message_start").length !== 1) fail("turn2 not one message");

  await fakePi._shutdown?.();
  console.log(pass ? "\nE2E MULTITURN TEXT PASS ✅" : "\nE2E MULTITURN TEXT FAIL ❌");
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
