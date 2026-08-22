import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Real-runtime regression for the subagent extension's `nativeAgentArgs` binding.
//
// WHY THIS EXISTS (not only the helper test):
// index.ts previously used `export { nativeAgentArgs } from "./native-agent-args.ts"`
// AND called `nativeAgentArgs(...)` in dispatch.execute. A bare re-export-from
// does NOT create a module-LOCAL binding, so:
//   - the module still LOADS without error, and
//   - even the namespace re-export `mod.nativeAgentArgs` is callable,
// but the INTERNAL call site throws `ReferenceError: nativeAgentArgs is not
// defined` at dispatch time. A load-only or namespace test cannot catch this;
// only exercising the internal call path does. This test loads index.ts through
// the REAL pi loader (which resolves the bundled `typebox` via jiti aliases,
// unlike a bare `bun import`) and drives dispatch.execute far enough to compute
// agent_args — proving the local binding resolves.
//
// Requires Familiar's stt/pi dev shell (PI_PACKAGE_DIR + a fake `herdr` on PATH).

const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function realLoader() {
  const packageDir = process.env.PI_PACKAGE_DIR;
  if (!packageDir) throw new Error("PI_PACKAGE_DIR is required (run in Familiar's pi or stt dev shell)");
  return import(join(packageDir, "dist/core/extensions/loader.js"));
}

// A fake `herdr` that returns just enough JSON for topology placement and the
// harvest/cancel path, so dispatch.execute reaches the nativeAgentArgs call.
function installFakeHerdr(): { bin: string; path: string } {
  const bin = mkdtempSync(join(tmpdir(), "subagent-fakebin-"));
  roots.push(bin);
  const herdr = join(bin, "herdr");
  writeFileSync(
    herdr,
    `#!/usr/bin/env bash
case "$1 $2" in
  "workspace create") echo '{"result":{"workspace":{"workspace_id":"ws-1"}}}';;
  "workspace get")    echo '{"result":{"workspace":{"workspace_id":"ws-1"}}}';;
  "tab create")       echo '{"result":{"root_pane":{"pane_id":"pane-1"},"tab":{"tab_id":"tab-1"}}}';;
  "tab close")        echo '{"result":{}}';;
  "agent get")        echo '{"result":{"agent":{"agent_status":"idle"}}}';;
  "agent start")      echo '{"result":{}}';;
  "agent prompt")     echo '{"result":{"agent":{"agent_status":"idle"}}}';;
  "agent wait")       echo '{"result":{"agent":{"agent_status":"idle"}}}';;
  "agent send-keys")  echo '{"result":{}}';;
  "agent read")       echo '{"result":{"content":""}}';;
  *)                  echo '{"result":{}}';;
esac
`,
    { mode: 0o755 },
  );
  chmodSync(herdr, 0o755);
  return { bin, path: herdr };
}

describe("subagent index.ts — real-runtime nativeAgentArgs binding", () => {
  test("loads under the real pi loader without error", async () => {
    const { loadExtensions } = await realLoader();
    const repo = resolve(import.meta.dir, "..", "..");
    const indexPath = join(repo, "extensions", "subagent", "index.ts");
    const res = await loadExtensions([indexPath], repo);
    // A parse/import failure (e.g. an unresolved import) would surface here.
    expect(res.errors).toEqual([]);
    expect(res.extensions.map((e: { resolvedPath: string }) => e.resolvedPath)).toContain(indexPath);
  });

  test("dispatch.execute reaches the nativeAgentArgs call site (local binding resolves)", async () => {
    const { loadExtensions } = await realLoader();
    const repo = resolve(import.meta.dir, "..", "..");
    const indexPath = join(repo, "extensions", "subagent", "index.ts");

    const work = mkdtempSync(join(tmpdir(), "subagent-dispatch-"));
    roots.push(work);
    const spool = join(work, "spool");
    const sessions = join(work, "sessions");
    const artifacts = join(work, "artifacts");
    mkdirSync(spool, { recursive: true });

    const { bin } = installFakeHerdr();
    // Module reads SPOOL/SESSION/ARTIFACT roots at load; set before loading.
    setEnv("FAMILIAR_SUBAGENT_MODE", "herdr");
    setEnv("FAMILIAR_SUBAGENT_DIR", spool);
    setEnv("FAMILIAR_SUBAGENT_SESSION_DIR", sessions);
    setEnv("FAMILIAR_ARTIFACT_DIR", artifacts);
    setEnv("FAMILIAR_SUBAGENT_MODEL", undefined); // no --model
    setEnv("HERDR_WORKSPACE_ID", "ws-test"); // requireHerdr gate
    setEnv("PATH", `${bin}:${process.env.PATH ?? ""}`); // fake herdr

    const res = await loadExtensions([indexPath], work);
    expect(res.errors).toEqual([]);
    const ext = res.extensions[0];
    const dispatch = ext.tools.get("dispatch");
    const cancel = ext.tools.get("subagent_cancel");
    expect(dispatch).toBeDefined();
    expect(cancel).toBeDefined();

    // worktree:false in a non-git temp dir → shared-workspace placement via the
    // fake herdr, then the native (pi) branch computes agent_args by calling the
    // module-local nativeAgentArgs. Under the broken re-export this line threw
    // `ReferenceError: nativeAgentArgs is not defined` before writing command.json.
    const out: any = await dispatch!.definition.execute("tc-1", {
      prompt: "regression probe",
      dir: work,
      worktree: false,
    });

    try {
      expect(out.details?.ok).toBe(true);
      const id = out.details.id as string;
      // command.json is written AFTER the agent_args literal is built, so its
      // presence + correct contents proves the local binding resolved and ran.
      const command = JSON.parse(readFileSync(join(spool, id, "command.json"), "utf8"));
      const loaded: string[] = [];
      for (let i = 0; i < command.agent_args.length; i++) {
        if (command.agent_args[i] === "-e") loaded.push(command.agent_args[i + 1]);
      }
      expect(loaded).toEqual([
        join(repo, "extensions", "anthropic-gateway", "index.ts"),
        join(repo, "extensions", "web", "index.ts"),
      ]);
      // Stop the background poller started by monitor(id) so bun can exit.
      await cancel!.definition.execute("tc-2", { id });
    } finally {
      // Best-effort: nothing else to tear down; temp dirs removed in afterEach.
    }
  });
});
