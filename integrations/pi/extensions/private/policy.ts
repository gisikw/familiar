/* ============================================================================
 * Private-mode policy — pure decision logic (no I/O, no pi, no crypto)
 * ============================================================================
 *
 * Every rule that decides "may this happen in private mode?" lives here so it
 * can be attacked by tests without a running Pi, a router, or a key.
 */

/** Provider facts as published by /tiamat/v1/providers. */
export interface ProviderAttestation {
  readonly kind?: string;
  readonly locality?: string;
  readonly models?: readonly string[];
}

export type Providers = Readonly<Record<string, ProviderAttestation>>;

export interface LocalChoice {
  readonly providerId: string;
  readonly model: string;
  readonly kind: string;
}

export type Refusal = { readonly refused: string };

export function isRefusal(value: unknown): value is Refusal {
  return typeof value === "object" && value !== null && typeof (value as Refusal).refused === "string";
}

/**
 * Choose the provider a private turn may use.
 *
 * The only admissible evidence is the router's `locality` attestation. Model
 * names are never consulted: "qwen" served by OpenRouter is a third party, and
 * a vendor-named model served from the basement is not. A preference may name
 * a provider or a `provider/model`, but it can only narrow the local set — it
 * can never promote a remote provider.
 */
export function selectLocalProvider(providers: Providers, preference?: string): LocalChoice | Refusal {
  const local = Object.entries(providers).filter(
    ([, provider]) => provider.locality === "local" && (provider.models?.length ?? 0) > 0,
  );
  if (local.length === 0) {
    return { refused: "no provider on the router attests locality=local" };
  }
  const [wantProvider, wantModel] = splitPreference(preference);
  const candidates = wantProvider ? local.filter(([id]) => id === wantProvider) : local;
  if (candidates.length === 0) {
    return { refused: `provider "${wantProvider}" is not attested local` };
  }
  const [providerId, provider] = candidates[0]!;
  const models = provider.models ?? [];
  const model = wantModel && models.includes(wantModel) ? wantModel : models[0];
  if (!model) return { refused: `provider "${providerId}" attests no models` };
  if (wantModel && model !== wantModel) {
    return { refused: `model "${wantModel}" is not offered by local provider "${providerId}"` };
  }
  return { providerId, model, kind: provider.kind ?? "unknown" };
}

function splitPreference(preference?: string): [string | undefined, string | undefined] {
  const trimmed = preference?.trim();
  if (!trimmed) return [undefined, undefined];
  const slash = trimmed.indexOf("/");
  if (slash < 0) return [trimmed, undefined];
  return [trimmed.slice(0, slash), trimmed.slice(slash + 1)];
}

export interface EntryConditions {
  readonly mode: string;
  readonly hasUI: boolean;
  readonly agentIdle: boolean;
  readonly keyringPresent: boolean;
  readonly unlocked: boolean;
}

/**
 * Private mode requires a real terminal, an idle agent, and an unlocked key.
 *
 * The terminal requirement is load-bearing, not cosmetic. Private input is read
 * through a modal TUI dialog, which is the only input path in Pi that does not
 * pass through `submitPrompt` and therefore the only one that cannot fan the
 * text out to every other extension's `input` handler. In RPC or print mode
 * there is no such path, so there is no private mode.
 */
export function canEnterPrivate(conditions: EntryConditions): true | Refusal {
  if (conditions.mode !== "tui" || !conditions.hasUI) {
    return { refused: "private mode requires an attached terminal; it is not available to remote or headless clients" };
  }
  if (!conditions.agentIdle) {
    return { refused: "finish the current turn before entering private mode" };
  }
  if (!conditions.keyringPresent) {
    return { refused: "no private keyring; run /private setup first" };
  }
  if (!conditions.unlocked) {
    return { refused: "private compartment is locked; run /private unlock" };
  }
  return true;
}

/**
 * Tools available to the private model.
 *
 * This is the whole policy: there are none. A private turn is a conversation
 * with a local model and nothing else. Mediating a tool surface would mean
 * arguing about which of read/bash/web/golem/worklist/plate can be trusted with
 * sealed content; refusing to offer any of them removes the argument and the
 * exfiltration path together. The request carries no tool declarations, so
 * there is nothing for the model to call even if it tries.
 */
export const PRIVATE_TOOLS: readonly never[] = [];

/** Reject any request body that would hand the private model a capability. */
export function assertNoToolSurface(body: Record<string, unknown>): void {
  for (const key of ["tools", "tool_choice", "functions", "function_call"]) {
    if (key in body) throw new Error(`private request must not carry "${key}"`);
  }
}

/**
 * The single sentence an ordinary session is allowed to learn on its own.
 *
 * Fixed template, no model involvement, no content. Public Exo may know that a
 * private conversation happened and when. It may not know anything else unless
 * Kevin explicitly declassifies a specific payload.
 */
export function publicNotice(startedAt: number, endedAt: number, turns: number): string {
  const span = `${new Date(startedAt).toISOString()} to ${new Date(endedAt).toISOString()}`;
  return (
    `A private conversation took place (${span}, ${turns} sealed ${turns === 1 ? "entry" : "entries"}). ` +
    `Its contents are sealed and are not available in this session. ` +
    `Do not speculate about, infer, or ask about what was discussed; if it matters, Kevin will declassify it.`
  );
}

/**
 * Provenance header for an approved declassification.
 *
 * Two properties matter. First, the payload enters the ordinary session as a
 * custom message, never as an assistant message: Pi must not be made to appear
 * to have said something it did not say. Second, the header states who drafted
 * it and who approved it, so a later reader cannot mistake a local model's
 * summary for Exo's own recollection.
 */
export function declassificationProvenance(model: string, provider: string, approvedAt: number): string {
  return (
    `[declassified from a private conversation — drafted by ${provider}/${model} (local), ` +
    `reviewed and approved verbatim by Kevin at ${new Date(approvedAt).toISOString()}. ` +
    `This is not Exo's recollection and carries no assistant assent.]`
  );
}

export function declassificationMessage(payload: string, model: string, provider: string, approvedAt: number): string {
  return `${declassificationProvenance(model, provider, approvedAt)}\n\n${payload}`;
}

/**
 * Whether an idle deadline has passed. Locking is time-based rather than
 * activity-scored on purpose: an unlocked key is the whole secret.
 */
export function shouldAutoLock(lastActivityAt: number, now: number, idleMs: number): boolean {
  return now - lastActivityAt >= idleMs;
}
