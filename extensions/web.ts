import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Web tools: search + fetch, ported from muse (~/Projects/muse/web.go).
//
// Progressive enhancement per the familiar convention (env var set = someone
// provides this; unset = repo provides a floor):
//
//   FAMILIAR_SEARXNG_URL     → SearXNG instance (self-hosted, deliberate — wins)
//   FAMILIAR_BRAVE_API_KEY   → Brave LLM-context API
//     FAMILIAR_BRAVE_URL       (optional base override)
//   neither                  → DuckDuckGo HTML endpoint (keyless floor;
//                              scraped, so quality/stability are best-effort)
//
// Fetch is always local: URL → HTML → markdown, converted in-process. No
// third-party proxy, no npm deps (pi loads extensions with its own loader;
// the converter is a trust-boundary-appropriate hand-roll, not a readability
// engine — JS-rendered SPAs yield only server-rendered markup).

const SEARCH_DEFAULT_COUNT = 5;
const SEARCH_MAX_COUNT = 20;
const SNIPPET_MAX_CHARS = 1000;
const FETCH_MAX_CHARS = 50 * 1024;
const TIMEOUT_MS = 20_000;

type SearchResult = { url: string; title: string; snippet?: string; content?: string };
type SearchOutput = {
  results: SearchResult[];
  count: number;
  provider: string;
  requested_count?: number;
  count_clamped?: boolean;
  truncated?: boolean;
};

/* --- shared -------------------------------------------------------------- */

const withTimeout = (signal?: AbortSignal): AbortSignal =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);

const truncateChars = (s: string, max: number): [string, boolean] =>
  s.length > max ? [s.slice(0, max) + "…", true] : [s, false];

const decodeEntities = (s: string): string =>
  s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");

const stripTags = (s: string): string => decodeEntities(s.replace(/<[^>]*>/g, "")).trim();

/* --- search providers ----------------------------------------------------- */

async function braveSearch(query: string, count: number, signal?: AbortSignal): Promise<SearchOutput> {
  const base = (process.env.FAMILIAR_BRAVE_URL || "https://api.search.brave.com").replace(/\/+$/, "");
  const url = `${base}/res/v1/llm/context?${new URLSearchParams({ q: query, count: String(count) })}`;
  const resp = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": process.env.FAMILIAR_BRAVE_API_KEY!,
    },
    signal: withTimeout(signal),
  });
  if (!resp.ok) throw new Error(`brave returned ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const body = (await resp.json()) as {
    grounding?: { generic?: { url: string; title: string; snippets?: string[] }[] };
  };
  const results: SearchResult[] = (body.grounding?.generic ?? []).map((r) => ({
    url: r.url,
    title: r.title,
    snippet: r.snippets?.[0],
    content: (r.snippets?.length ?? 0) > 1 ? r.snippets!.join("\n\n") : undefined,
  }));
  return { results, count: results.length, provider: "brave" };
}

async function searxngSearch(query: string, count: number, signal?: AbortSignal): Promise<SearchOutput> {
  const base = process.env.FAMILIAR_SEARXNG_URL!.replace(/\/+$/, "");
  const url = `${base}/search?${new URLSearchParams({ q: query, format: "json" })}`;
  const resp = await fetch(url, { headers: { Accept: "application/json" }, signal: withTimeout(signal) });
  if (!resp.ok) throw new Error(`searxng returned ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const body = (await resp.json()) as { results?: { url: string; title: string; content?: string }[] };
  const results: SearchResult[] = (body.results ?? []).slice(0, count).map((r) => ({
    url: r.url,
    title: r.title,
    snippet: r.content,
  }));
  return { results, count: results.length, provider: "searxng" };
}

// Keyless floor. html.duckduckgo.com wraps result hrefs in a /l/?uddg=<enc>
// redirect; decode it back to the target URL. Scrape, not API: selectors may
// rot, rate limits apply — good enough for a floor, not a foundation.
async function ddgSearch(query: string, count: number, signal?: AbortSignal): Promise<SearchOutput> {
  const url = `https://html.duckduckgo.com/html/?${new URLSearchParams({ q: query })}`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64)",
      Accept: "text/html",
    },
    signal: withTimeout(signal),
  });
  if (!resp.ok) throw new Error(`duckduckgo returned ${resp.status}`);
  const html = await resp.text();

  const links = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];

  const results: SearchResult[] = [];
  for (let i = 0; i < links.length && results.length < count; i++) {
    let href = decodeEntities(links[i][1]);
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith("//")) href = "https:" + href;
    // DDG interleaves ad rows; their hrefs route through ad domains, skip them.
    if (/duckduckgo\.com\/y\.js|ad_domain=/.test(href)) continue;
    results.push({
      url: href,
      title: stripTags(links[i][2]),
      snippet: snippets[i] ? stripTags(snippets[i][1]) : undefined,
    });
  }
  if (!results.length && /anomaly|captcha/i.test(html)) {
    throw new Error("duckduckgo rate-limited the request (captcha page); retry later or configure a search provider");
  }
  return { results, count: results.length, provider: "duckduckgo" };
}

const searchProvider = (): ((q: string, n: number, s?: AbortSignal) => Promise<SearchOutput>) => {
  if (process.env.FAMILIAR_SEARXNG_URL) return searxngSearch;
  if (process.env.FAMILIAR_BRAVE_API_KEY) return braveSearch;
  return ddgSearch;
};

const boundSearchOutput = (out: SearchOutput, count: number, requested: number): SearchOutput => {
  if (out.results.length > count) {
    out.results = out.results.slice(0, count);
    out.truncated = true;
  }
  for (const r of out.results) {
    let t: boolean;
    if (r.snippet) { [r.snippet, t] = truncateChars(r.snippet, SNIPPET_MAX_CHARS); out.truncated ||= t; }
    if (r.content) { [r.content, t] = truncateChars(r.content, SNIPPET_MAX_CHARS); out.truncated ||= t; }
  }
  out.count = out.results.length;
  if (requested > SEARCH_MAX_COUNT) {
    out.requested_count = requested;
    out.count_clamped = true;
  }
  return out;
};

/* --- fetch: HTML → markdown ------------------------------------------------ */

// Minimal converter, not a readability engine. Handles the structural tags
// that matter for reading docs/articles; everything else is stripped.
function htmlToMarkdown(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|head|template)[\s\S]*?<\/\1>/gi, "");

  // Code blocks first, so inner tags survive as text.
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, body) => {
    const code = decodeEntities(body.replace(/<[^>]*>/g, ""));
    return `\n\`\`\`\n${code.replace(/^\n+|\n+$/g, "")}\n\`\`\`\n`;
  });

  s = s
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, body) => `\n${"#".repeat(Number(n))} ${stripTags(body)}\n`)
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
      const text = stripTags(body);
      const url = decodeEntities(href);
      return text && !url.startsWith("#") && !url.startsWith("javascript:") ? `[${text}](${url})` : text;
    })
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, "*$2*")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, body) => `\`${stripTags(body)}\``)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<blockquote[^>]*>/gi, "\n> ")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|tr|table|ul|ol|blockquote|li|figure|header|footer|main)>/gi, "\n")
    .replace(/<[^>]*>/g, "");

  return decodeEntities(s)
    .split("\n").map((l) => l.replace(/[ \t]+$/g, "").replace(/^[ \t]{0,3}(?=\S)/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function localFetch(rawURL: string, signal?: AbortSignal): Promise<{ url: string; content: string; truncated: boolean }> {
  const resp = await fetch(rawURL, {
    headers: {
      "User-Agent": "familiar/1.0",
      Accept: "text/html,application/xhtml+xml,text/plain,text/markdown,*/*",
    },
    signal: withTimeout(signal),
    redirect: "follow",
  });
  if (!resp.ok) throw new Error(`fetch returned ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const body = await resp.text();
  const type = resp.headers.get("content-type") ?? "";
  const content = /html/.test(type) || /^\s*</.test(body) ? htmlToMarkdown(body) : body.trim();
  const [bounded, truncated] = truncateChars(content, FETCH_MAX_CHARS);
  return { url: resp.url || rawURL, content: bounded, truncated };
}

/* --- registration ---------------------------------------------------------- */

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "search",
    label: "Web Search",
    description:
      "Search the web for relevant URLs and content. Use for current information, documentation, or resources beyond training data. " +
      `Default count ${SEARCH_DEFAULT_COUNT}, max ${SEARCH_MAX_COUNT} (clamped). Snippets are bounded — follow up with fetch on promising results.`,
    promptSnippet: "Search the web; returns urls, titles, and bounded snippets as JSON",
    parameters: Type.Object({
      query: Type.String({ description: "The search query" }),
      count: Type.Optional(Type.Integer({ description: `Maximum results (default ${SEARCH_DEFAULT_COUNT}, max ${SEARCH_MAX_COUNT})` })),
    }),
    async execute(_toolCallId, params: { query: string; count?: number }, signal) {
      const requested = params.count ?? SEARCH_DEFAULT_COUNT;
      const count = Math.min(Math.max(requested, 1), SEARCH_MAX_COUNT);
      const out = boundSearchOutput(await searchProvider()(params.query, count, signal), count, requested);
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    },
  });

  pi.registerTool({
    name: "fetch",
    label: "Web Fetch",
    description:
      "Fetch a web page and return its content as markdown. Direct request, HTML converted locally — " +
      "JavaScript-rendered content (SPAs) yields only server-rendered markup. Output capped at 50KB.",
    promptSnippet: "Fetch a URL and return page content converted to markdown",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch" }),
    }),
    async execute(_toolCallId, params: { url: string }, signal) {
      const { url, content, truncated } = await localFetch(params.url, signal);
      const header = url === params.url ? "" : `(resolved: ${url})\n\n`;
      const footer = truncated ? "\n\n[content truncated at 50KB]" : "";
      return { content: [{ type: "text", text: `${header}${content}${footer}` }] };
    },
  });
}
