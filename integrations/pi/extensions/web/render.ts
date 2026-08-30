export type RenderSearchResult = { url: string; title: string; snippet?: string };

function markdownText(text: string): string {
  return text.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ").trim();
}

function markdownUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // Parentheses delimit Markdown destinations; percent-encode them while
    // preserving the actual HTTP target.
    return url.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
  } catch {
    return null;
  }
}

export function searchResultsMarkdown(results: RenderSearchResult[], expanded: boolean): string {
  if (results.length === 0) return "No results.";
  return results.map((result) => {
    const url = markdownUrl(result.url);
    const title = markdownText(result.title) || url || "Untitled result";
    const heading = url ? `- [${title}](${url})` : `- ${title}`;
    const snippet = expanded && result.snippet ? `\n  ${markdownText(result.snippet)}` : "";
    return heading + snippet;
  }).join("\n");
}
