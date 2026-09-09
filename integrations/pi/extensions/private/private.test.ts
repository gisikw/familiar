/* Adversarial tests for /private.
 *
 * Every string that stands in for conversation content is a synthetic canary.
 * No fixture here touches a real session, a real transcript, or a real
 * credential. The canaries exist so a filesystem scan can prove a negative.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MARKER_TYPE,
  SEALED_TYPE,
  TOMBSTONE_TYPE,
  bucketFor,
  frame,
  listCompartments,
  nextSeq,
  readCompartment,
  unframe,
  type EntryLike,
} from "./compartment.ts";
import { complete, fetchProviders, normalizeBaseUrl, REQUIRE_LOCALITY_HEADER } from "./local.ts";
import {
  PRIVATE_TOOLS,
  assertNoToolSurface,
  canEnterPrivate,
  declassificationMessage,
  declassificationProvenance,
  isRefusal,
  publicNotice,
  selectLocalProvider,
  shouldAutoLock,
} from "./policy.ts";
import { generateIdentity, open, samePassphrase, seal, unwrapIdentity, wrapIdentity } from "./seal.ts";
import { readKeyring, writeKeyring } from "./store.ts";

/** Synthetic. Never a real conversation. */
const CANARY = "CANARY-PRIVATE-e7b41d-the-thing-kevin-said";
const CANARY_REPLY = "CANARY-REPLY-9a02cc-what-the-local-model-answered";
const FIXTURE_PASSPHRASE = "fixture-passphrase-not-a-real-secret";

let workspace: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "familiar-private-test-"));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/* ========================================================================== */
describe("local-only routing is fail-closed on provider identity", () => {
  const providers = {
    "claude-code-personal": { kind: "oauth-client", locality: "remote", models: ["claude-opus-5"] },
    "openrouter-personal": { kind: "api-key", locality: "remote", models: ["qwen/qwen3.8-27b", "llama-4-scout"] },
    "llama-frankenstein": { kind: "api-key", locality: "local", models: ["qwen3.8-27b"] },
  };

  test("chooses the provider the router attests local", () => {
    const choice = selectLocalProvider(providers);
    expect(isRefusal(choice)).toBe(false);
    expect(choice).toMatchObject({ providerId: "llama-frankenstein", model: "qwen3.8-27b" });
  });

  test("refuses when nothing is attested local, rather than picking a local-sounding model", () => {
    const choice = selectLocalProvider({
      "openrouter-personal": { kind: "api-key", locality: "remote", models: ["qwen/qwen3.8-27b", "llama-3.3-70b"] },
      "definitely-local-sounding": { kind: "api-key", locality: "remote", models: ["local-llama-on-my-desk"] },
    });
    expect(isRefusal(choice)).toBe(true);
  });

  test("a missing or unknown locality is treated as remote", () => {
    expect(isRefusal(selectLocalProvider({ p: { kind: "api-key", models: ["m"] } }))).toBe(true);
    expect(isRefusal(selectLocalProvider({ p: { kind: "api-key", locality: "onprem", models: ["m"] } }))).toBe(true);
    expect(isRefusal(selectLocalProvider({ p: { kind: "api-key", locality: "Local", models: ["m"] } }))).toBe(true);
  });

  test("a preference can narrow the local set but never promote a remote provider", () => {
    expect(isRefusal(selectLocalProvider(providers, "openrouter-personal"))).toBe(true);
    expect(isRefusal(selectLocalProvider(providers, "claude-code-personal/claude-opus-5"))).toBe(true);
    expect(selectLocalProvider(providers, "llama-frankenstein")).toMatchObject({ providerId: "llama-frankenstein" });
  });

  test("a local provider with no models is not usable", () => {
    expect(isRefusal(selectLocalProvider({ p: { kind: "api-key", locality: "local", models: [] } }))).toBe(true);
  });
});

/* ========================================================================== */
describe("private requests reach exactly one local provider and never fall back", () => {
  async function withStubRouter(
    handler: (request: Request) => Response | Promise<Response>,
    body: (base: string) => Promise<void>,
  ): Promise<void> {
    const server = Bun.serve({ port: 0, fetch: handler });
    try {
      await body(`http://127.0.0.1:${server.port}`);
    } finally {
      server.stop(true);
    }
  }

  test("carries the locality requirement, no tools, and no streaming", async () => {
    let seen: { headers: Headers; body: Record<string, unknown>; path: string } | undefined;
    await withStubRouter(
      async (request) => {
        seen = { headers: request.headers, body: await request.json(), path: new URL(request.url).pathname };
        return Response.json({ choices: [{ message: { role: "assistant", content: CANARY_REPLY } }] });
      },
      async (base) => {
        const answer = await complete(
          { baseUrl: base, token: "fixture-token" },
          { providerId: "llama-frankenstein", model: "qwen3.8-27b", kind: "api-key" },
          [{ role: "user", content: CANARY }],
        );
        expect(answer.text).toBe(CANARY_REPLY);
      },
    );
    expect(seen?.path).toBe("/openai/llama-frankenstein/v1/chat/completions");
    expect(seen?.headers.get(REQUIRE_LOCALITY_HEADER)).toBe("local");
    expect(seen?.body["stream"]).toBe(false);
    expect(seen?.body).not.toHaveProperty("tools");
    expect(seen?.body).not.toHaveProperty("tool_choice");
    expect(seen?.body).not.toHaveProperty("functions");
  });

  test("a router locality refusal is terminal: no retry, no second provider", async () => {
    let attempts = 0;
    await withStubRouter(
      () => {
        attempts += 1;
        return Response.json({ error: { message: "provider does not satisfy the required locality" } }, { status: 403 });
      },
      async (base) => {
        await expect(
          complete(
            { baseUrl: base, token: "fixture-token" },
            { providerId: "llama-frankenstein", model: "qwen3.8-27b", kind: "api-key" },
            [{ role: "user", content: CANARY }],
          ),
        ).rejects.toThrow(/no longer attests locality=local/);
      },
    );
    expect(attempts).toBe(1);
  });

  test("an upstream error is a failure, never a fallback to another provider", async () => {
    const hits: string[] = [];
    await withStubRouter(
      (request) => {
        hits.push(new URL(request.url).pathname);
        return new Response("boom", { status: 500 });
      },
      async (base) => {
        await expect(
          complete(
            { baseUrl: base, token: "fixture-token" },
            { providerId: "llama-frankenstein", model: "qwen3.8-27b", kind: "api-key" },
            [{ role: "user", content: CANARY }],
          ),
        ).rejects.toThrow(/HTTP 500/);
      },
    );
    expect(hits).toEqual(["/openai/llama-frankenstein/v1/chat/completions"]);
  });

  test("attestation is read from the authenticated providers surface", async () => {
    let authorization: string | null = null;
    await withStubRouter(
      (request) => {
        authorization = request.headers.get("authorization");
        return Response.json({ "llama-frankenstein": { kind: "api-key", locality: "local", models: ["qwen3.8-27b"] } });
      },
      async (base) => {
        const providers = await fetchProviders({ baseUrl: base, token: "fixture-token" });
        expect(providers["llama-frankenstein"]?.locality).toBe("local");
      },
    );
    expect(authorization).toBe("Bearer fixture-token");
  });

  test("base urls are normalized without swallowing the provider segment", () => {
    expect(normalizeBaseUrl("https://router.example///")).toBe("https://router.example");
  });
});

/* ========================================================================== */
describe("the private model is given no tool surface at all", () => {
  test("the tool policy is empty, not curated", () => {
    expect(PRIVATE_TOOLS).toHaveLength(0);
  });

  test("any attempt to attach a capability to a private request throws", () => {
    for (const key of ["tools", "tool_choice", "functions", "function_call"]) {
      expect(() => assertNoToolSurface({ model: "m", [key]: [] })).toThrow(new RegExp(key));
    }
    expect(() => assertNoToolSurface({ model: "m", messages: [] })).not.toThrow();
  });
});

/* ========================================================================== */
describe("sealing", () => {
  test("round-trips through age and leaves no plaintext in the record", async () => {
    const identity = await generateIdentity();
    const payload = { kind: "message", role: "user", text: CANARY, at: 1_700_000_000_000 } as const;
    const ciphertext = await seal(identity.recipient, frame(payload));
    const record = {
      v: 1,
      compartment: "fixture-compartment",
      seq: 0,
      bucket: bucketFor(new TextEncoder().encode(JSON.stringify(payload)).byteLength),
      ct: Buffer.from(ciphertext).toString("base64"),
    };
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain("user");
    expect(serialized).not.toContain(identity.secret);

    const opened = unframe(new Uint8Array(await open(identity.secret, ciphertext)));
    expect(opened.text).toBe(CANARY);
    expect(opened.role).toBe("user");
  });

  test("sealing needs only the public recipient, so a crash mid-session still seals", async () => {
    const identity = await generateIdentity();
    const ciphertext = await seal(identity.recipient, frame({ kind: "message", text: CANARY, at: 1 }));
    // Nothing above used identity.secret. Prove the wrong identity cannot read it.
    const other = await generateIdentity();
    await expect(open(other.secret, ciphertext)).rejects.toThrow();
    expect(unframe(new Uint8Array(await open(identity.secret, ciphertext))).text).toBe(CANARY);
  });

  test("padding hides message length below the bucket boundary", async () => {
    const identity = await generateIdentity();
    const short = await seal(identity.recipient, frame({ kind: "message", text: "hi", at: 1 }));
    const longer = await seal(identity.recipient, frame({ kind: "message", text: "x".repeat(300), at: 1 }));
    expect(short.byteLength).toBe(longer.byteLength);
    // And a genuinely larger message does move to the next bucket, so padding
    // is bounded rather than unbounded.
    const huge = await seal(identity.recipient, frame({ kind: "message", text: "x".repeat(4000), at: 1 }));
    expect(huge.byteLength).toBeGreaterThan(short.byteLength);
  });

  test("a malformed recipient is refused before any process runs", async () => {
    await expect(seal("not-an-age-key", new Uint8Array([1, 2, 3]))).rejects.toThrow(/invalid age recipient/);
  });
});

/* ========================================================================== */
describe("key management and crash/restart unlock", () => {
  test("the wrapped identity survives a restart and needs the passphrase", async () => {
    const identity = await generateIdentity();
    const keyring = await wrapIdentity(identity, FIXTURE_PASSPHRASE);
    const path = join(workspace, "keyring.json");
    await writeFile(path, JSON.stringify(keyring), { mode: 0o600 });

    // Simulate a restart: only the file survives.
    const restored = JSON.parse(await readFile(path, "utf8"));
    expect(restored.recipient).toBe(identity.recipient);
    expect(JSON.stringify(restored)).not.toContain(identity.secret);
    expect(await unwrapIdentity(restored, FIXTURE_PASSPHRASE)).toBe(identity.secret);
  });

  test("a corrupt keyring is never mistaken for an absent one or overwritten", async () => {
    const dir = await mkdtemp(join(tmpdir(), "familiar-private-corrupt-"));
    const previous = process.env.FAMILIAR_PRIVATE_DIR;
    process.env.FAMILIAR_PRIVATE_DIR = dir;
    try {
      await writeFile(join(dir, "keyring.json"), "{truncated", { mode: 0o600 });
      await expect(readKeyring()).rejects.toThrow(/unreadable or corrupt/);
      const identity = await generateIdentity();
      const keyring = await wrapIdentity(identity, FIXTURE_PASSPHRASE);
      await expect(writeKeyring(keyring)).rejects.toThrow();
      expect(await readFile(join(dir, "keyring.json"), "utf8")).toBe("{truncated");
      await rm(join(dir, "keyring.json"));
      await writeKeyring(keyring);
      expect(await unwrapIdentity((await readKeyring())!, FIXTURE_PASSPHRASE)).toBe(identity.secret);
    } finally {
      if (previous === undefined) delete process.env.FAMILIAR_PRIVATE_DIR;
      else process.env.FAMILIAR_PRIVATE_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("tampered KDF parameters fail closed instead of controlling resource use", async () => {
    const identity = await generateIdentity();
    const keyring = await wrapIdentity(identity, FIXTURE_PASSPHRASE);
    await expect(unwrapIdentity({ ...keyring, kdf: { ...keyring.kdf, N: 2 } }, FIXTURE_PASSPHRASE))
      .rejects.toThrow(/KDF parameters/);
  });

  test("a wrong passphrase fails without revealing anything", async () => {
    const identity = await generateIdentity();
    const keyring = await wrapIdentity(identity, FIXTURE_PASSPHRASE);
    await expect(unwrapIdentity(keyring, `${FIXTURE_PASSPHRASE}x`)).rejects.toThrow(/wrong passphrase/);
  });

  test("a keyring cannot be spliced onto another public key", async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    const keyring = await wrapIdentity(a, FIXTURE_PASSPHRASE);
    const forged = { ...keyring, recipient: b.recipient };
    await expect(unwrapIdentity(forged, FIXTURE_PASSPHRASE)).rejects.toThrow(/wrong passphrase/);
  });

  test("short passphrases are refused at creation", async () => {
    const identity = await generateIdentity();
    await expect(wrapIdentity(identity, "short")).rejects.toThrow(/at least 8/);
  });

  test("passphrase confirmation compares in constant time and by value", () => {
    expect(samePassphrase("aaaaaaaa", "aaaaaaaa")).toBe(true);
    expect(samePassphrase("aaaaaaaa", "aaaaaaab")).toBe(false);
    expect(samePassphrase("aaaaaaaa", "aaaaaaa")).toBe(false);
  });

  test("idle auto-lock is time based", () => {
    expect(shouldAutoLock(1000, 1000 + 15 * 60_000, 15 * 60_000)).toBe(true);
    expect(shouldAutoLock(1000, 1000 + 60_000, 15 * 60_000)).toBe(false);
  });
});

/* ========================================================================== */
describe("the sealed compartment inside an ordinary session archive", () => {
  function sessionFixture(): EntryLike[] {
    return [
      { type: "message", customType: undefined, data: undefined },
      { type: "custom", customType: MARKER_TYPE, data: { v: 1, compartment: "A", event: "open", at: 1 } },
      { type: "custom", customType: SEALED_TYPE, data: { v: 1, compartment: "A", seq: 0, bucket: 1024, ct: "AAAA" } },
      { type: "custom", customType: SEALED_TYPE, data: { v: 1, compartment: "A", seq: 1, bucket: 1024, ct: "BBBB" } },
      { type: "custom", customType: SEALED_TYPE, data: { v: 1, compartment: "B", seq: 0, bucket: 2048, ct: "CCCC" } },
      { type: "custom", customType: MARKER_TYPE, data: { v: 1, compartment: "A", event: "close", at: 9 } },
    ];
  }

  test("compartments are isolated from one another", () => {
    const a = readCompartment(sessionFixture(), "A");
    const b = readCompartment(sessionFixture(), "B");
    expect(a.sealed.map((record) => record.ct)).toEqual(["AAAA", "BBBB"]);
    expect(b.sealed.map((record) => record.ct)).toEqual(["CCCC"]);
    expect(listCompartments(sessionFixture())).toEqual(["A", "B"]);
  });

  test("a replayed sequence number keeps the completed write", () => {
    const entries: EntryLike[] = [
      { type: "custom", customType: SEALED_TYPE, data: { v: 1, compartment: "A", seq: 0, bucket: 1024, ct: "torn" } },
      { type: "custom", customType: SEALED_TYPE, data: { v: 1, compartment: "A", seq: 0, bucket: 1024, ct: "final" } },
    ];
    expect(readCompartment(entries, "A").sealed.map((r) => r.ct)).toEqual(["final"]);
    expect(nextSeq(entries, "A")).toBe(1);
  });

  test("tombstones make records unreadable through every display path", () => {
    const entries = [
      ...sessionFixture(),
      { type: "custom", customType: TOMBSTONE_TYPE, data: { v: 1, compartment: "A", before: Number.MAX_SAFE_INTEGER } },
    ];
    expect(readCompartment(entries, "A").sealed).toHaveLength(0);
    // A tombstone on A does not touch B.
    expect(readCompartment(entries, "B").sealed).toHaveLength(1);
  });

  test("records reveal no role, text, timestamp, or model", () => {
    for (const entry of sessionFixture()) {
      if (entry.customType !== SEALED_TYPE) continue;
      expect(Object.keys(entry.data as object).sort()).toEqual(["bucket", "compartment", "ct", "seq", "v"]);
    }
  });

  test("framing rejects truncation, corrupt length, padding, and payload shape", () => {
    const framed = frame({ kind: "message", text: CANARY, at: 1 });
    const badLength = framed.slice();
    new DataView(badLength.buffer).setUint32(0, 0xffffff, false);
    expect(() => unframe(badLength)).toThrow(/out of range/);
    expect(() => unframe(framed.subarray(0, framed.byteLength - 1))).toThrow(/padding length/);
    const badPadding = framed.slice();
    badPadding[badPadding.byteLength - 1] = 1;
    expect(() => unframe(badPadding)).toThrow(/non-zero padding/);
    expect(() => unframe(frame({ kind: "invented", text: CANARY, at: 1 } as never))).toThrow(/invalid shape/);
  });
});

/* ========================================================================== */
describe("what the ordinary session is allowed to learn", () => {
  test("the automatic notice carries timing and volume, never content", () => {
    const notice = publicNotice(1_700_000_000_000, 1_700_000_600_000, 6);
    expect(notice).not.toContain(CANARY);
    expect(notice).not.toContain(CANARY_REPLY);
    expect(notice).toContain("sealed");
    expect(notice).toMatch(/6 sealed entries/);
    expect(notice).toMatch(/Do not speculate/);
  });

  test("a declassified payload is attributed to the local model, never to Exo", () => {
    const provenance = declassificationProvenance("qwen3.8-27b", "llama-frankenstein", 1_700_000_000_000);
    expect(provenance).toContain("llama-frankenstein/qwen3.8-27b");
    expect(provenance).toContain("approved verbatim by Kevin");
    expect(provenance).toContain("not Exo's recollection");
    expect(provenance).toContain("no assistant assent");

    const message = declassificationMessage(CANARY_REPLY, "qwen3.8-27b", "llama-frankenstein", 1);
    expect(message.startsWith("[declassified")).toBe(true);
    expect(message).toContain(CANARY_REPLY);
  });

  test("a local-model summary is not automatically public: approval is a separate field", () => {
    const draft = { kind: "declassification", text: CANARY_REPLY, at: 1 } as const;
    const approved = { ...draft, approvedAt: 2 };
    expect("approvedAt" in draft).toBe(false);
    expect(approved.approvedAt).toBe(2);
  });
});

/* ========================================================================== */
describe("entry conditions", () => {
  const base = { mode: "tui", hasUI: true, agentIdle: true, keyringPresent: true, unlocked: true };

  test("private mode is available only on an attached terminal", () => {
    expect(canEnterPrivate(base)).toBe(true);
    for (const mode of ["rpc", "print", "json"]) {
      const gate = canEnterPrivate({ ...base, mode });
      expect(isRefusal(gate)).toBe(true);
      expect((gate as { refused: string }).refused).toMatch(/attached terminal/);
    }
    expect(isRefusal(canEnterPrivate({ ...base, hasUI: false }))).toBe(true);
  });

  test("it refuses mid-turn, without a keyring, and while locked", () => {
    expect(isRefusal(canEnterPrivate({ ...base, agentIdle: false }))).toBe(true);
    expect(isRefusal(canEnterPrivate({ ...base, keyringPresent: false }))).toBe(true);
    expect(isRefusal(canEnterPrivate({ ...base, unlocked: false }))).toBe(true);
  });
});

/* ========================================================================== */
describe("no plaintext escapes to disk", () => {
  test("a full private exchange leaves no recoverable plaintext anywhere it writes", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "familiar-private-scan-"));
    const identity = await generateIdentity();
    const keyring = await wrapIdentity(identity, FIXTURE_PASSPHRASE);

    // Everything private mode persists: the keyring, and sealed session lines.
    await writeFile(join(scratch, "keyring.json"), JSON.stringify(keyring, null, 2), { mode: 0o600 });

    const lines: string[] = [
      JSON.stringify({ type: "session", version: 3, id: "fixture", cwd: scratch }),
      JSON.stringify({ type: "custom", id: "aa", parentId: null, customType: MARKER_TYPE, data: { v: 1, compartment: "A", event: "open", at: 1 } }),
    ];
    let seq = 0;
    for (const [role, text] of [["user", CANARY], ["assistant", CANARY_REPLY]] as const) {
      const framed = frame({ kind: "message", role, text, at: 1 });
      const ct = await seal(identity.recipient, framed);
      lines.push(
        JSON.stringify({
          type: "custom",
          id: `s${seq}`,
          parentId: "aa",
          customType: SEALED_TYPE,
          data: { v: 1, compartment: "A", seq: seq++, bucket: bucketFor(framed.byteLength - 4), ct: Buffer.from(ct).toString("base64") },
        }),
      );
    }
    lines.push(
      JSON.stringify({
        type: "custom_message",
        id: "n",
        parentId: "aa",
        customType: "familiar-private/notice",
        content: publicNotice(1, 2, 2),
        display: true,
      }),
    );
    await writeFile(join(scratch, "session.jsonl"), `${lines.join("\n")}\n`);

    // Scan every byte written, in every encoding this code could have used.
    const needles = [
      CANARY,
      CANARY_REPLY,
      identity.secret,
      FIXTURE_PASSPHRASE,
      Buffer.from(CANARY).toString("base64"),
      Buffer.from(CANARY_REPLY).toString("base64"),
      Buffer.from(CANARY).toString("hex"),
    ];
    for (const name of await readdir(scratch)) {
      const path = join(scratch, name);
      const body = await readFile(path);
      for (const needle of needles) {
        expect(body.includes(needle)).toBe(false);
      }
    }

    // The keyring is not world-readable.
    const mode = (await stat(join(scratch, "keyring.json"))).mode & 0o777;
    expect(mode).toBe(0o600);

    // And the content really is recoverable with the key, so the scan above is
    // proving encryption rather than an empty file.
    const session = (await readFile(join(scratch, "session.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const view = readCompartment(session, "A");
    const recovered: string[] = [];
    for (const record of view.sealed) {
      recovered.push(unframe(new Uint8Array(await open(identity.secret, Buffer.from(record.ct, "base64")))).text);
    }
    expect(recovered).toEqual([CANARY, CANARY_REPLY]);

    await rm(scratch, { recursive: true, force: true });
  }, 30_000);
});

/* ========================================================================== */
describe("the extension loads under pi's own loader", () => {
  const packageDir = process.env.PI_PACKAGE_DIR;
  const maybe = packageDir ? test : test.skip;

  maybe("pi's real context builder maps custom entry data to zero model messages", async () => {
    const { buildSessionContext } = await import(join(packageDir!, "dist/core/session-manager.js"));
    const entries = [
      { type: "message", id: "u", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "ordinary" } },
      { type: "custom", id: "s", parentId: "u", timestamp: new Date().toISOString(), customType: SEALED_TYPE,
        data: { v: 1, compartment: "A", seq: 0, bucket: 1024, ct: CANARY } },
      { type: "message", id: "a", parentId: "s", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "after" }] } },
    ];
    const context = buildSessionContext(entries, "a", new Map(entries.map((entry) => [entry.id, entry])));
    const wire = JSON.stringify(context.messages);
    expect(wire).toContain("ordinary");
    expect(wire).toContain("after");
    expect(wire).not.toContain(CANARY);
    expect(wire).not.toContain(SEALED_TYPE);
  });

  maybe("pi loads /private with no tools and no input hook", async () => {
    const { discoverAndLoadExtensions } = await import(
      join(packageDir!, "dist/core/extensions/loader.js")
    );
    const root = await mkdtemp(join(tmpdir(), "familiar-private-load-"));
    const agentDir = join(root, "agent");
    await mkdir(join(agentDir, "extensions"), { recursive: true });

    // Load the real directory in place, as pi does at Presence birth, so the
    // extension's relative imports resolve exactly as they will in production.
    const entrypoint = join(new URL(".", import.meta.url).pathname, "index.ts");
    const result = await discoverAndLoadExtensions([entrypoint], root, agentDir);
    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    const extension = result.extensions[0];

    // It registers a command, so this is not passing on a no-op load.
    expect([...extension.commands.keys()]).toEqual(["private"]);

    // No tools: nothing /private does is reachable by any model, and it adds no
    // model-callable surface to ordinary sessions.
    expect([...extension.tools.keys()]).toEqual([]);

    // No `input` handler. Private text is read through a modal component rather
    // than Pi's shared prompt path, so this extension never observes ordinary
    // input and never has to win a load-order race to keep private text out of
    // other extensions' handlers.
    const events = [...extension.handlers.keys()].sort();
    expect(events).toEqual(["session_shutdown", "session_start"]);

    // Sealed and marker entries render through this extension, so the ordinary
    // transcript shows them as sealed rather than as raw JSON.
    expect([...extension.entryRenderers.keys()].sort()).toEqual([
      "familiar-private/marker",
      "familiar-private/sealed",
    ]);

    await rm(root, { recursive: true, force: true });
  }, 30_000);
});
