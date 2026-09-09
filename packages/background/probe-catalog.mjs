// Manual probe only. Uses the existing Router catalog and stays on the job's
// provider/wire. Credentials remain in memory; only one credential-free model
// row may be written into the probe's temporary directory by the caller.
export async function discoverCatalogRow({ baseUrl, token, authorized, modelId, fetchImpl = fetch }) {
  if (!Array.isArray(authorized) || authorized.length !== 1)
    throw new Error("invalid authorized catalog snapshot");
  const source = authorized[0];
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/tiamat/v1/models`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("catalog request failed");
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 1024 * 1024) throw new Error("catalog size limit");
    chunks.push(Buffer.from(chunk));
  }
  const rows = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Array.isArray(rows)) throw new Error("invalid catalog");
  const candidates = rows.filter((row) => row &&
    row.provider === source.provider && row.api === source.api &&
    row.availability === "available" && row.model === (modelId ?? source.model));
  if (candidates.length !== 1) throw new Error("requested model not available on authorized provider/wire");
  // Do not persist arbitrary server metadata (in particular errors or headers).
  const result = {};
  for (const key of ["model", "provider", "api", "availability", "fidelity",
    "context_window", "max_output_tokens", "reasoning", "input",
    "thinking_level_map", "force_adaptive_thinking"])
    if (candidates[0][key] !== undefined) result[key] = candidates[0][key];
  return result;
}
