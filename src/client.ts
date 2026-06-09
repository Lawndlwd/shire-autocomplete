import type { Config } from "./config";
import { STOP_TOKENS, buildFimPrompt } from "./fim";

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
  log: (m: string) => void,
  onError?: (msg: string) => void
): Promise<CompletionResult | null> {
  const fail = (msg: string) => {
    log(msg);
    onError?.(msg);
    return null;
  };

  if (!cfg.baseUrl) {
    return fail("No Base URL set — open the Shire panel and set your endpoint.");
  }
  if (!cfg.model) {
    return fail("No model name set — set it in the Shire panel.");
  }

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
    // Network-level failure: server down, wrong host, DNS, TLS.
    return fail(
      `Cannot reach ${url} (${e?.cause?.code ?? e?.message ?? e}). ` +
        `Check the Base URL and that the server is running.`
    );
  }

  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    return fail(httpHint(res.status, url) + (detail ? ` — ${detail}` : ""));
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

export interface TestResult {
  ok: boolean;
  fim: boolean;
  message: string;
}

// Sends a known FIM probe ("def add(a, b): return ___") and judges the result:
// did we connect, and does the output look like fill-in-the-middle code rather
// than chat prose? Lets the user verify their model is actually FIM-capable.
export async function testConnection(cfg: Config, log: (m: string) => void): Promise<TestResult> {
  const prompt = buildFimPrompt("def add(a, b):\n    return ", "\n");
  const ctl = new AbortController();
  let captured = "";
  const res = await complete(cfg, prompt, ctl.signal, log, (m) => (captured = m));
  if (!res) {
    return { ok: false, fim: false, message: captured || "Connection failed — see the output." };
  }
  const out = res.text.trim();
  // FIM models emit a short code fragment like "a + b". Chat models emit prose,
  // markdown fences, or restate the task.
  const codeLike =
    out.length > 0 &&
    out.length < 60 &&
    /[A-Za-z_)\]]\s*[-+*/]\s*[A-Za-z_(\[]|a\s*\+\s*b|return\s/.test(out) &&
    !/```|\bhere\b|\bsure\b|\bthe function\b|\bi'?ll\b|\blet'?s\b/i.test(out);
  const verdict = codeLike
    ? "✓ Looks like FIM/code — good for autocomplete."
    : "⚠ Output doesn't look like FIM infill — this model may not be FIM-trained. Use a Coder model (Qwen2.5-Coder, Codestral, DeepSeek-Coder).";
  return {
    ok: true,
    fim: codeLike,
    message: `Connected in ${res.firstTokenMs}ms. Sample: ${JSON.stringify(out.slice(0, 40))}. ${verdict}`,
  };
}

// Turn an HTTP status into an actionable hint.
function httpHint(status: number, url: string): string {
  switch (status) {
    case 401:
    case 403:
      return `HTTP ${status}: authentication failed — check your API key.`;
    case 404:
      return `HTTP 404 at ${url}: endpoint or model not found. Your server must expose /v1/completions (not only /chat/completions), and the model name must match.`;
    case 400:
      return `HTTP 400: bad request — usually a wrong model name or an unsupported parameter.`;
    case 429:
      return `HTTP 429: rate limited by the endpoint — slow down or raise your quota.`;
    case 422:
      return `HTTP 422: the endpoint rejected the request shape (model may not support raw /completions).`;
    default:
      return status >= 500
        ? `HTTP ${status}: the model server errored. Check its logs.`
        : `HTTP ${status} from ${url}.`;
  }
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
