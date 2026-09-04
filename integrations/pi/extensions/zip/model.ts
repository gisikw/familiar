/*
 * Summarizer model resolution.
 *
 * The zip summarizer must run on a model that actually has auth in *this*
 * instance. Hardcoding `anthropic/claude-haiku-4-5` fails whenever Anthropic
 * arrives through a router provider instead of the bare vendor provider, so
 * resolve against the live registry: an explicit env override first, then a
 * small/cheap sibling of the session's current model, then the current model
 * itself, and only then the legacy default.
 */

const SMALL_HINTS = ["haiku", "flash", "mini", "small"];
const LEGACY_MODEL = "anthropic/claude-haiku-4-5";

export type ModelRef = { provider: string; id: string };

export const refLabel = (ref: ModelRef): string => `${ref.provider}/${ref.id}`;

const parseRef = (spec: string): ModelRef | undefined => {
  const [provider, ...rest] = spec.split("/");
  const id = rest.join("/");
  return provider && id ? { provider, id } : undefined;
};

/* Ordered preference list; deduplicated, never filtered by auth here so the
 * caller can report exactly what was tried. */
export const summarizerCandidates = (registry: any, current: any, envModel?: string): ModelRef[] => {
  const refs: ModelRef[] = [];
  const push = (ref?: ModelRef) => {
    if (!ref) return;
    if (refs.some((known) => known.provider === ref.provider && known.id === ref.id)) return;
    refs.push(ref);
  };

  if (envModel?.trim()) push(parseRef(envModel.trim()));

  if (current?.provider) {
    const siblings = (registry.getAll?.() ?? []).filter((model: any) => model?.provider === current.provider);
    for (const hint of SMALL_HINTS) {
      for (const model of siblings) {
        if (String(model.id).toLowerCase().includes(hint)) push({ provider: model.provider, id: model.id });
      }
    }
    if (current.id) push({ provider: current.provider, id: current.id });
  }

  push(parseRef(LEGACY_MODEL));
  return refs;
};

export const resolveSummarizerModel = (
  registry: any,
  current: any,
  envModel?: string,
): { model: any; ref: string } | { error: string; tried: string[] } => {
  const candidates = summarizerCandidates(registry, current, envModel);
  for (const ref of candidates) {
    const model = registry.find(ref.provider, ref.id);
    if (!model) continue;
    if (!registry.hasConfiguredAuth(model)) continue;
    return { model, ref: refLabel(ref) };
  }
  const tried = candidates.map(refLabel);
  return { error: `no summarizer model with configured auth (tried: ${tried.join(", ") || "none"})`, tried };
};
