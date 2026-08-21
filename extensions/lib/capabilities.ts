/* ============================================================================
 * capabilities — a tiny, neutral, typed, versioned, process-local registry
 * ============================================================================
 *
 * The problem this solves: two extensions (worklist and subagent) want to
 * cooperate WITHOUT importing each other and without a mandatory co-install.
 * Subagent settlements should be able to route through worklist's durable
 * attention policy when it is present, and fall back to a direct relay when it
 * is not. Neither extension may depend on the other's module, and neither may
 * rely on pi's `events.emit` for a request/response handshake — pi's EventBus
 * `emit` returns `void` and guarantees no synchronous claim/ack semantics.
 *
 * So both extensions depend only on THIS module: a plain in-process map keyed
 * by a capability name + major version. One side `register`s a typed value;
 * the other `resolve`s it at the moment of use. Registration returns a
 * disposer; a second registration for the same key replaces the first and the
 * stale disposer becomes a no-op. Everything is synchronous and side-effect
 * free beyond the map itself, which makes it trivially restart- and test-safe:
 * a fresh process starts empty, and `dispose()` (or `resetRegistry()` in tests)
 * clears it.
 *
 * This is deliberately NOT a pi extension and NOT a magical global. It is a
 * module singleton: `import { registry } from "../lib/capabilities.ts"`. Two
 * extensions in the same pi process share the same module instance, which is
 * exactly the coupling surface we want — narrow, typed, and versioned.
 *
 * Versioning: a capability is identified by `${name}@${version}` where version
 * is a MAJOR integer. A resolver asks for the exact major it was compiled
 * against; a provider that only offers a different major is invisible to it.
 * This lets the contract evolve (v2) while a lagging consumer keeps working
 * against v1 if both are registered, and — more importantly — prevents a
 * consumer from silently binding to an incompatible shape.
 */

/** A registered capability entry. Opaque to the registry; typed at the seam. */
interface Entry {
  value: unknown;
  /** Monotonic token so a stale disposer cannot evict a newer registration. */
  token: number;
}

const key = (name: string, version: number): string => `${name}@${version}`;

export interface Disposer {
  (): void;
}

export interface CapabilityRegistry {
  /**
   * Register `value` under `name` at major `version`. Returns a disposer that
   * removes exactly this registration (and is a no-op if a later registration
   * has already replaced it). Registering the same (name, version) again
   * replaces the previous value.
   */
  register<T>(name: string, version: number, value: T): Disposer;
  /**
   * Resolve the value registered under (name, version), or undefined if none.
   * The caller supplies the type it expects; the registry does not validate
   * shape (the version is the contract) — keep the interface small and stable.
   */
  resolve<T>(name: string, version: number): T | undefined;
  /** True iff a value is registered under (name, version). */
  has(name: string, version: number): boolean;
  /**
   * Remove any registration under (name, version) regardless of token. Rarely
   * needed directly — prefer the disposer returned by register().
   */
  unregister(name: string, version: number): void;
  /** Drop every registration. For process/test teardown. */
  dispose(): void;
}

function createRegistry(): CapabilityRegistry {
  const entries = new Map<string, Entry>();
  let nextToken = 1;

  return {
    register<T>(name: string, version: number, value: T): Disposer {
      const k = key(name, version);
      const token = nextToken++;
      entries.set(k, { value, token });
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        const cur = entries.get(k);
        // Only evict if we are still the current registration. A newer
        // register() for the same key owns a higher token and survives.
        if (cur && cur.token === token) entries.delete(k);
      };
    },
    resolve<T>(name: string, version: number): T | undefined {
      const e = entries.get(key(name, version));
      return e ? (e.value as T) : undefined;
    },
    has(name: string, version: number): boolean {
      return entries.has(key(name, version));
    },
    unregister(name: string, version: number): void {
      entries.delete(key(name, version));
    },
    dispose(): void {
      entries.clear();
    },
  };
}

/**
 * The process-local singleton. Two extensions loaded into the same pi process
 * import this same module and therefore share this exact registry instance.
 */
export const registry: CapabilityRegistry = createRegistry();

/** Test seam: build an isolated registry so unit tests don't touch the singleton. */
export const createCapabilityRegistry = createRegistry;

/* ============================================================================
 * The worklist durable-enqueue capability contract (v1)
 * ============================================================================
 *
 * This is the ONE capability the worklist⇄subagent seam uses. It lives here,
 * next to the registry, so neither extension owns the shared type and neither
 * imports the other. Worklist registers an implementation; subagent resolves
 * it at courtesy-delivery time.
 *
 * The sink is ASYNC and returns an explicit acceptance verdict. The caller
 * (subagent) MUST await it and only suppress its own direct relay when the
 * verdict is `{ accepted: true }`. Any other outcome — a `false`, a throw, a
 * rejected promise, or the capability being absent — means the caller falls
 * back to its direct `pi.sendMessage` relay. This is the load-bearing
 * exactly-once contract: acceptance is a positive, durable handshake, never an
 * assumption.
 */
export const WORKLIST_SINK = "worklist.durable-sink";
export const WORKLIST_SINK_VERSION = 1;

/** Priority scale shared at the seam (lower = more urgent), matching worklist. */
export type SinkPriority = 0 | 1 | 2 | 3;

/** The envelope a durable sink accepts. Intentionally a subset of worklist's
 *  richer EnqueueEnvelope so subagent needs no worklist types. */
export interface DurableEnqueueEnvelope {
  /** Stable id for idempotent enqueue. The sink MUST dedupe on this. */
  id?: string;
  priority?: SinkPriority;
  /** Worklist item type; free-form at the seam. */
  type?: string;
  summary: string;
  body?: string;
  source?: string;
  suggested_deadline?: number;
}

export interface DurableAcceptance {
  /** True only when the item is durably enqueued and owned by the sink. */
  accepted: boolean;
  /** The durable item id (echoes envelope.id when supplied). */
  id?: string;
  /** Optional human-readable reason when accepted is false. */
  reason?: string;
  /**
   * Set when NOT accepted because the item was already withdrawn/claimed by
   * another delivery channel (e.g. an in-flight enqueue lost the race to a
   * concurrent `subagent_await`). The caller MUST NOT fall back to a direct
   * relay in this case — delivery is already owned elsewhere. Distinguishes
   * "the sink refuses/absent, do your own relay" from "someone else already
   * has this; do nothing". See the exactly-once dedup invariant.
   */
  superseded?: boolean;
}

/**
 * The registered value. A single async function plus a way to withdraw an item
 * that the caller has since claimed elsewhere (the await-race dedup path).
 */
export interface DurableSink {
  /** Durably enqueue the envelope. Resolves with an explicit acceptance. */
  enqueue(env: DurableEnqueueEnvelope): Promise<DurableAcceptance>;
  /**
   * Withdraw a previously-enqueued item by id if it has not yet been delivered.
   * Used to cancel a queued settlement that a later `subagent_await` claimed,
   * so it cannot surface twice. Idempotent; resolves true iff an undelivered
   * item was removed (or was already gone). Resolves false only if the item
   * exists AND has already been delivered (too late to withdraw).
   */
  withdraw(id: string): Promise<boolean>;
}
