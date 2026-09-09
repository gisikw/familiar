import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const moduleUrl = new URL("./model-guard.ts", import.meta.url).href;
function run(source) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import guard from ${JSON.stringify(moduleUrl)};const handlers=new Map();const pi={on:(name,fn)=>handlers.set(name,fn)};guard(pi);${source}`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, FAMILIAR_AGENT_EXPECTED_MODEL: "provider/exact" },
    },
  );
}
test("fuzzy/alternate model selection fails before any request", () => {
  const result = run(
    `handlers.get('session_start')({}, {model:{provider:'provider',id:'different'}});console.log('UNSAFE');`,
  );
  assert.equal(result.status, 78);
  assert.match(result.stderr, /refusing fallback/);
  assert.doesNotMatch(result.stdout, /UNSAFE/);
});
test("model drift before first request is refused; later manual steering/reload is allowed", () => {
  const drift = run(
    `handlers.get('session_start')({}, {model:{provider:'provider',id:'exact'}});handlers.get('before_provider_headers')({}, {model:{provider:'other',id:'different'}});`,
  );
  assert.equal(drift.status, 78);
  const allowed = run(
    `const ctx={model:{provider:'provider',id:'exact'}};handlers.get('session_start')({},ctx);handlers.get('before_provider_headers')({},ctx);guard(pi);ctx.model.id='human-selected';handlers.get('session_start')({},ctx);handlers.get('before_provider_headers')({},ctx);console.log('manual steering allowed');`,
  );
  assert.equal(allowed.status, 0);
  assert.match(allowed.stdout, /manual steering allowed/);
});
