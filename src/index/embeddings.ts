import type { Config } from "../config";

// Calls an OpenAI-compatible /v1/embeddings. Used at index-build time to embed
// repo chunks, and (only when semantic retrieval is enabled) to embed a query.
// Batched to keep round-trips down.
export async function embed(
  cfg: Config,
  inputs: string[],
  signal?: AbortSignal
): Promise<number[][] | null> {
  if (inputs.length === 0) {
    return [];
  }
  const url = `${cfg.baseUrl}/embeddings`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) {
    headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: cfg.embedModel, input: inputs }),
      signal,
    });
  } catch {
    return null;
  }
  if (!res.ok) {
    return null;
  }
  try {
    const json: any = await res.json();
    // OpenAI shape: { data: [{ embedding: [...] }, ...] } in input order.
    const out = (json.data ?? [])
      .sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0))
      .map((d: any) => d.embedding as number[]);
    return out.length === inputs.length ? out : null;
  } catch {
    return null;
  }
}
