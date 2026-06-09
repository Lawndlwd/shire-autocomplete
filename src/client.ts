import type { Config } from "./config";
import { STOP_TOKENS } from "./fim";

export interface CompletionResult {
  text: string;
  firstTokenMs: number;
  totalMs: number;
}

// Calls an OpenAI-compatible /v1/completions (legacy text completion, NOT chat).
// Streaming is on so we can measure and surface first-token latency, which is
// the number that actually decides whether autocomplete feels alive.
//
// `signal` is wired to an AbortController the provider trips on every keystroke;
// a stale request is cancelled the instant the user types again.
export async function complete(
  cfg: Config,
  prompt: string,
  signal: AbortSignal,
  log: (m: string) => void
): Promise<CompletionResult | null> {
  const url = `${cfg.baseUrl}/completions`;
  const started = Date.now();
  let firstTokenMs = -1;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) {
    headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  }

  const body = JSON.stringify({
    model: cfg.model,
    prompt,
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
    stop: STOP_TOKENS,
    stream: true,
  });

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body, signal });
  } catch (e: any) {
    if (e?.name === "AbortError") {
      return null;
    }
    log(`request failed: ${e?.message ?? e}`);
    return null;
  }

  if (!res.ok || !res.body) {
    log(`HTTP ${res.status} ${res.statusText} from ${url}`);
    return null;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by newlines; each data line is JSON. Keep the
      // last (possibly partial) line in the buffer for the next chunk.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const piece = parseLine(raw);
        if (piece) {
          if (firstTokenMs < 0) {
            firstTokenMs = Date.now() - started;
          }
          text += piece;
        }
      }
    }

    // Flush any trailing data line that arrived without a final newline, so we
    // never drop the last token of a completion.
    const tail = parseLine(buffer);
    if (tail) {
      if (firstTokenMs < 0) {
        firstTokenMs = Date.now() - started;
      }
      text += tail;
    }
  } catch (e: any) {
    if (e?.name === "AbortError") {
      return null;
    }
    log(`stream error: ${e?.message ?? e}`);
    return null;
  }

  return {
    text,
    firstTokenMs: firstTokenMs < 0 ? Date.now() - started : firstTokenMs,
    totalMs: Date.now() - started,
  };
}

// Parse one SSE line; returns the text delta or "" if it's not a data token.
function parseLine(raw: string): string {
  const line = raw.trim();
  if (!line.startsWith("data:")) {
    return "";
  }
  const payload = line.slice(5).trim();
  if (payload === "" || payload === "[DONE]") {
    return "";
  }
  try {
    const json = JSON.parse(payload);
    return (json.choices?.[0]?.text ?? "") as string;
  } catch {
    return ""; // partial JSON across a chunk boundary — it'll re-arrive
  }
}
