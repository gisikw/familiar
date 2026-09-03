import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/*
 * Footer — familiar's replacement footer.
 *
 * The built-in footer spends its first line on cwd/branch, which is noise for
 * familiar (the working directory is always the familiar tract). This footer
 * replaces it entirely:
 *
 *   line 1:  (provider) model • thinking              right: attention mode
 *   line 2:  ↑↓ R W CH $ · ttft/tok/s · context%      right: provider usage
 *
 * Semantics that differ from the built-in totals:
 *   - Usage is summed over ctx.sessionManager.buildContextEntries() — the
 *     entries actually in the model's context on the active branch, with
 *     compaction applied. Summarized-away turns fall out of the totals
 *     naturally; preserved turns keep counting. No baseline bookkeeping.
 *   - TTFT and tok/s are napkin math from streaming events: turn_start
 *     timestamp to the first streamed token delta of any kind (prefill +
 *     queueing + hidden-thinking lead-in), and output tokens over the span of
 *     the deltas (gen throughput). Both are running means over the last
 *     SAMPLE_WINDOW completions, tracked separately per model (provider/id) so
 *     a slow model never inherits a fast model's forecast after a switch.
 *     In-memory only: switching back to a recent model restores its stats; a
 *     restart starts every model cold.
 *
 * Data sources:
 *   - "familiar:attention" events from the worklist extension (it stays the
 *     single source of truth for attention state).
 *   - "familiar:provider-usage" events from the tiamat extension (rate-limit
 *     windows; empty for routes that don't expose them).
 *   - /footer toggles back to pi's built-in footer.
 */

type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
};

type Sample = { ttftMs: number; tps: number };

const SAMPLE_WINDOW = 10;
/** Deltas spanning less than this are buffered flushes, not real generation. */
const MIN_GEN_SPAN_MS = 250;

function fmtTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export default function (pi: ExtensionAPI) {
  let ctxRef: ExtensionContext | undefined;
  let activeTui: { requestRender: (all?: boolean) => void } | undefined;
  let attentionText: string | undefined;
  let providerUsage: { text: string; tone: string } | undefined;
  // Speed samples keyed by provider/model id — per-model forecasts, not a
  // convo-wide average (a glm switch after gemini turns shouldn't look fast).
  const samplesByModel = new Map<string, Sample[]>();
  let turnStart = 0;
  let firstDelta = 0;
  let lastDelta = 0;
  let installed = false;

  const refresh = () => activeTui?.requestRender();

  const modelKey = (model: { provider: string; id: string } | undefined): string | undefined =>
    model ? `${model.provider}/${model.id}` : undefined;

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    if (ctx.hasUI) install(ctx);
  });
  pi.on("model_select", async (_event, ctx) => {
    ctxRef = ctx;
    refresh();
  });
  pi.on("session_compact", async () => refresh());

  pi.on("turn_start", async (event) => {
    turnStart = event.timestamp;
    firstDelta = 0;
    lastDelta = 0;
  });

  pi.on("message_update", async (event) => {
    if (event.message.role !== "assistant") return;
    const type = (event.assistantMessageEvent as { type?: string } | undefined)?.type;
    // "start" is local stream setup (request dispatch), not a token; "done"
    // is the terminal marker. Everything else is a token-shaped delta.
    if (type === "start" || type === "done") return;
    const now = Date.now();
    if (!firstDelta) firstDelta = now;
    lastDelta = now;
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const usage = (event.message as { usage?: UsageLike }).usage;
    if (turnStart && firstDelta && usage?.output) {
      const ttftMs = firstDelta - turnStart;
      // Junk-sample guard: short messages (tool-call preambles) often arrive
      // as a single buffered flush, making the delta span ~1ms and tok/s
      // absurd (tokens / 0.001s). Only record samples with a real span.
      const genMs = lastDelta - firstDelta;
      if (genMs >= MIN_GEN_SPAN_MS) {
        const key = modelKey(ctx?.model ?? ctxRef?.model);
        if (key) {
          const samples = samplesByModel.get(key) ?? [];
          samples.push({ ttftMs, tps: usage.output / (genMs / 1000) });
          if (samples.length > SAMPLE_WINDOW) samples.splice(0, samples.length - SAMPLE_WINDOW);
          samplesByModel.set(key, samples);
        }
      }
    }
    turnStart = 0;
    firstDelta = 0;
    lastDelta = 0;
    refresh();
  });

  pi.events.on("familiar:attention", (data: unknown) => {
    const ev = data as { text?: unknown };
    attentionText = typeof ev?.text === "string" && ev.text ? ev.text : undefined;
    refresh();
  });

  pi.events.on("familiar:provider-usage", (data: unknown) => {
    const ev = data as { text?: unknown; tone?: unknown };
    providerUsage =
      typeof ev?.text === "string" && ev.text
        ? { text: ev.text, tone: typeof ev.tone === "string" ? ev.tone : "dim" }
        : undefined;
    refresh();
  });

  function install(ctx: ExtensionContext) {
    if (installed) return;
    installed = true;
    ctx.ui.setFooter((tui, theme, footerData) => {
      activeTui = tui;
      return {
        invalidate() {},
        render(width: number): string[] {
          const ctx = ctxRef;
          const model = ctx?.model;
          const providerCount = footerData.getAvailableProviderCount();

          // --- line 1 left: model identifier --------------------------------
          let modelLeft = "no-model";
          if (model) {
            modelLeft = providerCount > 1 ? `(${model.provider}) ${model.id}` : model.id;
            if (model.reasoning) {
              const level = ctx?.thinkingLevel || "off";
              modelLeft += level === "off" ? " • thinking off" : ` • ${level}`;
            }
          }

          // --- line 2 left: usage attributable to the current context -------
          const usageParts: string[] = [];
          let input = 0;
          let output = 0;
          let cacheRead = 0;
          let cacheWrite = 0;
          let cost = 0;
          let latestCacheHitRate: number | undefined;
          if (ctx) {
            for (const entry of ctx.sessionManager.buildContextEntries()) {
              if (entry.type !== "message") continue;
              const message = entry.message as { role: string; usage?: UsageLike };
              const usage = message.usage;
              if (!usage) continue;
              if (message.role === "assistant") {
                input += usage.input ?? 0;
                output += usage.output ?? 0;
                cacheRead += usage.cacheRead ?? 0;
                cacheWrite += usage.cacheWrite ?? 0;
                cost += usage.cost?.total ?? 0;
                const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
                if (promptTokens > 0) {
                  latestCacheHitRate = ((usage.cacheRead ?? 0) / promptTokens) * 100;
                }
              } else if (message.role === "toolResult") {
                input += usage.input ?? 0;
                cacheRead += usage.cacheRead ?? 0;
                cost += usage.cost?.total ?? 0;
              }
            }
          }
          if (input) usageParts.push(theme.fg("dim", `↑${fmtTokens(input)}`));
          if (output) usageParts.push(theme.fg("dim", `↓${fmtTokens(output)}`));
          if (cacheRead) usageParts.push(theme.fg("dim", `R${fmtTokens(cacheRead)}`));
          if (cacheWrite) usageParts.push(theme.fg("dim", `W${fmtTokens(cacheWrite)}`));
          if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined) {
            usageParts.push(theme.fg("dim", `CH${latestCacheHitRate.toFixed(1)}%`));
          }
          if (cost) usageParts.push(theme.fg("dim", `$${cost.toFixed(3)}`));
          const currentSamples = samplesByModel.get(modelKey(model) ?? "") ?? [];
          if (currentSamples.length > 0) {
            const meanTtft = currentSamples.reduce((acc, s) => acc + s.ttftMs, 0) / currentSamples.length / 1000;
            const meanTps = currentSamples.reduce((acc, s) => acc + s.tps, 0) / currentSamples.length;
            usageParts.push(theme.fg("dim", `${meanTtft.toFixed(1)}s·${Math.round(meanTps)}t/s`));
          }
          const contextUsage = ctx?.getContextUsage();
          if (contextUsage && contextUsage.contextWindow > 0) {
            const pct = contextUsage.percent !== null ? contextUsage.percent.toFixed(1) : "?";
            const display = `${pct}%/${fmtTokens(contextUsage.contextWindow)}`;
            const tone = contextUsage.percent !== null && contextUsage.percent > 90
              ? "error"
              : contextUsage.percent !== null && contextUsage.percent > 70
                ? "warning"
                : "dim";
            usageParts.push(theme.fg(tone, display));
          }
          const usageLeft = usageParts.join(" ");

          // --- assembly ------------------------------------------------------
          const join = (left: string, right: string | undefined): string => {
            if (!right) return truncateToWidth(left, width);
            const availableForRight = width - visibleWidth(left) - 2;
            const truncatedRight = availableForRight > 0 ? truncateToWidth(right, availableForRight, "") : "";
            const padding = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(truncatedRight)));
            return truncateToWidth(left + padding + truncatedRight, width);
          };

          const modelLine = join(theme.fg("dim", modelLeft), attentionText ? theme.fg("accent", attentionText) : undefined);
          const usageLine = join(usageLeft, providerUsage ? theme.fg(providerUsage.tone, providerUsage.text) : undefined);
          return [modelLine, usageLine];
        },
      };
    });
  }

  pi.registerCommand("footer", {
    description: "Toggle between the familiar footer and pi's built-in footer",
    handler: async (_args, ctx) => {
      if (installed) {
        ctx.ui.setFooter(undefined);
        installed = false;
        ctx.ui.notify("Built-in footer restored", "info");
      } else {
        install(ctx);
        ctx.ui.notify("Familiar footer enabled", "info");
      }
    },
  });
}
