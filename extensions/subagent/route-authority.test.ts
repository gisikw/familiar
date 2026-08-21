import { afterEach, describe, expect, test } from "bun:test";

// Real loader/lifecycle test for the child subagent's anthropic route authority.
//
// Pi itself is a compiled binary (not an importable module), so we cannot boot
// the real ExtensionRunner here. Instead we boot the REAL extension factories
// (anthropic-gateway + claude-driver) against a faithful reproduction of pi's
// provider store: pi core/model-runtime.ts registerProvider applies same-id
// registrations LAST-WRITER-WINS with a defined-value merge, and provider
// registrations happen in extension load order (pi extensions/loader.ts loads
// `-e` paths sequentially, awaiting each async factory). This is exactly the
// ordering nativeAgentArgs encodes; here we prove the CONSEQUENCE end to end:
// with canonical creds, claude-driver's in-process loopback takes authority
// over tiamat's gateway; without them it is a hard no-op and tiamat stands.
//
// This drives the real double-loopback bind (127.0.0.1 ephemeral ports) but
// never spawns `claude` — the provider is registered at factory load, before
// any turn. The winning baseUrl is therefore route-distinguishing: a loopback
// 127.0.0.1 URL is PROVABLY not the tiamat ANTHROPIC_BASE_URL.

const TIAMAT_BASE = "https://tiamat.invalid/anthropic";
const LOOPBACK_RE = /^http:\/\/127\.0\.0\.1:\d+\/anthropic$/;

// Faithful reproduction of pi's provider store registration semantics.
function makeProviderStore() {
  const providers = new Map<string, Record<string, unknown>>();
  return {
    providers,
    // pi core/model-runtime.ts registerProvider: merge DEFINED values over the
    // previous registration for the same id (undefined preserved); the last
    // registration for an id therefore wins its defined keys.
    registerProvider(name: string, config: Record<string, unknown>) {
      const previous = providers.get(name) ?? {};
      const effective = { ...previous };
      for (const [k, v] of Object.entries(config)) if (v !== undefined) effective[k] = v;
      providers.set(name, effective);
    },
    unregisterProvider(name: string) {
      providers.delete(name);
    },
  };
}

// Minimal ExtensionAPI stub: exactly the surface these two extensions touch.
function makeApi(store: ReturnType<typeof makeProviderStore>) {
  const shutdownHandlers: Array<() => unknown | Promise<unknown>> = [];
  const api: any = {
    registerProvider: (name: string, config: Record<string, unknown>) => store.registerProvider(name, config),
    unregisterProvider: (name: string) => store.unregisterProvider(name),
    on: (event: string, handler: () => unknown) => {
      if (event === "session_shutdown") shutdownHandlers.push(handler);
    },
    // Surfaces claude-driver references but does not exercise at load time.
    registerTool: () => {},
    registerCommand: () => {},
    sendMessage: () => {},
  };
  return { api, shutdownHandlers };
}

// Boot the child's `-e` set in argv order, awaiting each factory exactly as pi
// does. Returns the provider store + all captured shutdown handlers.
async function bootChildExtensions(opts: { credentialled: boolean; tiamat: boolean }) {
  const store = makeProviderStore();
  const allShutdown: Array<() => unknown | Promise<unknown>> = [];

  const gateway = (await import("../anthropic-gateway/index.ts")).default;
  const driver = (await import("../claude-driver/index.ts")).default;
  // web registers no provider; omitted here — its route-neutrality is asserted
  // structurally in native-agent-args.test.ts.

  // Env setup mirrors familiar.sh: gateway reads ANTHROPIC_BASE_URL; the driver
  // resolves a canonical Claude credential from the environment.
  const saved = {
    base: process.env.ANTHROPIC_BASE_URL,
    tok: process.env.FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN,
    upstream: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    prov: process.env._FAMILIAR_CONFIG_EXPLICIT_ENV,
  };
  delete process.env._FAMILIAR_CONFIG_EXPLICIT_ENV; // ambient: no provenance filter
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (opts.tiamat) process.env.ANTHROPIC_BASE_URL = TIAMAT_BASE;
  else delete process.env.ANTHROPIC_BASE_URL;
  if (opts.credentialled) process.env.FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN = "sk-ant-oat-test-token";
  else delete process.env.FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN;

  try {
    // ORDER IS LOAD-BEARING: gateway first (fallback), claude-driver second
    // (authority) — the exact order nativeAgentArgs emits.
    for (const factory of [gateway, driver]) {
      const g = makeApi(store);
      const ready = factory(g.api);
      if (ready && typeof (ready as any).then === "function") await ready; // driver's async bind
      allShutdown.push(...g.shutdownHandlers);
    }
  } finally {
    if (saved.base === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = saved.base;
    if (saved.tok === undefined) delete process.env.FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN; else process.env.FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN = saved.tok;
    if (saved.upstream === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.upstream;
    if (saved.prov === undefined) delete process.env._FAMILIAR_CONFIG_EXPLICIT_ENV; else process.env._FAMILIAR_CONFIG_EXPLICIT_ENV = saved.prov;
  }
  return { store, allShutdown };
}

const teardowns: Array<Array<() => unknown | Promise<unknown>>> = [];
afterEach(async () => {
  // Close loopback servers / rm temp roots the driver bound during boot.
  for (const handlers of teardowns.splice(0)) for (const h of handlers) { try { await h(); } catch {} }
});

describe("child anthropic route authority (real factory lifecycle)", () => {
  test("credentialled: claude-driver loopback takes authority over tiamat gateway", async () => {
    const { store, allShutdown } = await bootChildExtensions({ credentialled: true, tiamat: true });
    teardowns.push(allShutdown);
    const anthropic = store.providers.get("anthropic");
    expect(anthropic).toBeDefined();
    const baseUrl = String(anthropic!.baseUrl);
    // Route evidence that DISTINGUISHES loopback from tiamat: the winning route
    // is an in-process 127.0.0.1 loopback, provably not the tiamat base.
    expect(baseUrl).toMatch(LOOPBACK_RE);
    expect(baseUrl).not.toBe(TIAMAT_BASE);
    // The driver bound a real teardown handler (loopback servers to close).
    expect(allShutdown.length).toBeGreaterThan(0);
  });

  test("no credential: claude-driver is a no-op; tiamat gateway route stands", async () => {
    const { store, allShutdown } = await bootChildExtensions({ credentialled: false, tiamat: true });
    teardowns.push(allShutdown);
    const anthropic = store.providers.get("anthropic");
    expect(anthropic).toBeDefined();
    expect(String(anthropic!.baseUrl)).toBe(TIAMAT_BASE);
    // Hard no-op: the gated factory returned before registering any shutdown.
    expect(allShutdown.length).toBe(0);
  });

  test("credentialled but no tiamat base: loopback is the sole anthropic route", async () => {
    const { store, allShutdown } = await bootChildExtensions({ credentialled: true, tiamat: false });
    teardowns.push(allShutdown);
    const anthropic = store.providers.get("anthropic");
    expect(anthropic).toBeDefined();
    expect(String(anthropic!.baseUrl)).toMatch(LOOPBACK_RE);
  });

  test("teardown unregisters the driver's anthropic route", async () => {
    const { store, allShutdown } = await bootChildExtensions({ credentialled: true, tiamat: true });
    expect(String(store.providers.get("anthropic")!.baseUrl)).toMatch(LOOPBACK_RE);
    for (const h of allShutdown) await h();
    // The driver unregisters `anthropic` on shutdown (CLAUDE-DRIVER.md: restore
    // pre-driver behavior). In a real session pi tears the whole session down;
    // here we assert the driver relinquished its authority.
    expect(store.providers.has("anthropic")).toBe(false);
  });
});
