import type { Config } from "./config";
import { getFimSpec, buildPrompt } from "./fim";

export interface CompletionResult {
  text: string;
  firstTokenMs: number;
  totalMs: number;
}

type Outcome =
  | { ok: true; result: CompletionResult }
  | { ok: false; aborted?: boolean; status?: number; error: string };

export interface CompleteParams {
  cfg: Config;
  fimPrompt: string; // for completions mode
  stop: string[];
  prefix: string; // for chat mode
  suffix: string;
  preamble: string;
  signal: AbortSignal;
  log: (m: string) => void;
  onError?: (m: string) => void;
}

// HTTP statuses where /completions might be unsupported and chat is worth a try.
const FALLBACKABLE = new Set([400, 404, 405, 415, 422, 501]);

// Top-level entry: picks completions/chat/auto, applies timeout, surfaces a
// friendly error. Returns null on failure or abort (provider treats both as
// "no suggestion"); onError carries the human-readable reason for the panel.
export async function complete(p: CompleteParams): Promise<CompletionResult | null> {
  const mode = p.cfg.apiMode;
  const report = (o: Extract<Outcome, { ok: false }>) => {
    if (o.aborted) return null;
    p.log(o.error);
    p.onError?.(o.error);
    return null;
  };

  if (!p.cfg.baseUrl) return report({ ok: false, error: "No Base URL set — open the Shire panel." });
  if (!p.cfg.model) return report({ ok: false, error: "No model name set — set it in the Shire panel." });

  if (mode === "chat") {
    const o = await chatRequest(p);
    return o.ok ? o.result : report(o);
  }

  const o = await completionsRequest(p);
  if (o.ok) return o.result;
  if (mode === "auto" && !o.aborted && o.status && FALLBACKABLE.has(o.status)) {
    p.log(`/completions returned ${o.status} — falling back to /chat/completions.`);
    const c = await chatRequest(p);
    return c.ok ? c.result : report(c);
  }
  return report(o);
}

function authHeaders(cfg: Config): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) h["Authorization"] = `Bearer ${cfg.apiKey}`;
  return h;
}

async function completionsRequest(p: CompleteParams): Promise<Outcome> {
  const body = JSON.stringify({
    model: p.cfg.model,
    prompt: p.fimPrompt,
    max_tokens: p.cfg.maxTokens,
    temperature: p.cfg.temperature,
    stop: p.stop,
    stream: true,
  });
  return streamRequest(p, `${p.cfg.baseUrl}/completions`, body, (j) => j.choices?.[0]?.text ?? "");
}

async function chatRequest(p: CompleteParams): Promise<Outcome> {
  // FIM-via-chat: instruct the model to emit only the insertion at <CURSOR>.
  const messages = [
    {
      role: "system",
      content:
        "You are a code autocomplete engine. Continue the code at the <CURSOR> marker. " +
        "Output ONLY the raw code that replaces <CURSOR> — no explanation, no markdown, no code fences.",
    },
    { role: "user", content: `${p.preamble}${p.prefix}<CURSOR>${p.suffix}` },
  ];
  const body = JSON.stringify({
    model: p.cfg.model,
    messages,
    max_tokens: p.cfg.maxTokens,
    temperature: p.cfg.temperature,
    stream: true,
  });
  return streamRequest(
    p,
    `${p.cfg.baseUrl}/chat/completions`,
    body,
    (j) => j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? ""
  );
}

// Shared streaming POST with a hard timeout, abort wiring, and SSE parsing.
// `extract` pulls the text delta out of each JSON frame (differs chat vs text).
async function streamRequest(
  p: CompleteParams,
  url: string,
  body: string,
  extract: (json: any) => string
): Promise<Outcome> {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  p.signal.addEventListener("abort", onAbort);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, Math.max(1000, p.cfg.requestTimeoutMs));

  const started = Date.now();
  let firstTokenMs = -1;
  let text = "";

  try {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: authHeaders(p.cfg), body, signal: ctl.signal });
    } catch (e: any) {
      if (p.signal.aborted) return { ok: false, aborted: true, error: "aborted" };
      if (timedOut)
        return { ok: false, error: `Request timed out after ${p.cfg.requestTimeoutMs}ms — endpoint slow or unreachable.` };
      return {
        ok: false,
        error: `Cannot reach ${url} (${e?.cause?.code ?? e?.message ?? e}). Check the Base URL and that the server is running.`,
      };
    }

    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      return { ok: false, status: res.status, error: httpHint(res.status, url) + (detail ? ` — ${detail}` : "") };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const piece = parseLine(raw, extract);
        if (piece) {
          if (firstTokenMs < 0) firstTokenMs = Date.now() - started;
          text += piece;
        }
      }
    }
    const tail = parseLine(buffer, extract);
    if (tail) {
      if (firstTokenMs < 0) firstTokenMs = Date.now() - started;
      text += tail;
    }
  } catch (e: any) {
    if (p.signal.aborted && !timedOut) return { ok: false, aborted: true, error: "aborted" };
    if (timedOut)
      return { ok: false, error: `Request timed out after ${p.cfg.requestTimeoutMs}ms while streaming.` };
    return { ok: false, error: `Stream error: ${e?.message ?? e}` };
  } finally {
    clearTimeout(timer);
    p.signal.removeEventListener("abort", onAbort);
  }

  return {
    ok: true,
    result: {
      text,
      firstTokenMs: firstTokenMs < 0 ? Date.now() - started : firstTokenMs,
      totalMs: Date.now() - started,
    },
  };
}

export interface TestResult {
  ok: boolean;
  fim: boolean;
  message: string;
}

// Probe the configured endpoint/model and judge whether the result looks like
// FIM/code (vs chat prose). Mirrors the real path: same mode + FIM template.
export async function testConnection(cfg: Config, log: (m: string) => void): Promise<TestResult> {
  const spec = getFimSpec(cfg.fimTemplate, cfg.customFimTemplate, cfg.customStop);
  const prefix = "def add(a, b):\n    return ";
  const suffix = "\n";
  const fimPrompt = buildPrompt(spec, prefix, suffix, "");
  let captured = "";
  const res = await complete({
    cfg,
    fimPrompt,
    stop: spec.stop,
    prefix,
    suffix,
    preamble: "",
    signal: new AbortController().signal,
    log,
    onError: (m) => (captured = m),
  });
  if (!res) return { ok: false, fim: false, message: captured || "Connection failed — see the output." };
  const out = res.text.trim();
  const codeLike =
    out.length > 0 &&
    out.length < 80 &&
    /[A-Za-z_)\]]\s*[-+*/]\s*[A-Za-z_(\[]|a\s*\+\s*b|return\s/.test(out) &&
    !/```|\bhere\b|\bsure\b|\bthe function\b|\bi'?ll\b|\blet'?s\b/i.test(out);
  const verdict = codeLike
    ? "✓ Looks like FIM/code — good for autocomplete."
    : "⚠ Output doesn't look like FIM infill. Check the FIM Template matches your model (Qwen/Codestral/DeepSeek/StarCoder), or try API Mode = chat.";
  return {
    ok: true,
    fim: codeLike,
    message: `Connected in ${res.firstTokenMs}ms. Sample: ${JSON.stringify(out.slice(0, 40))}. ${verdict}`,
  };
}

function httpHint(status: number, url: string): string {
  switch (status) {
    case 401:
    case 403:
      return `HTTP ${status}: authentication failed — check your API key and its permissions.`;
    case 404:
      return `HTTP 404 at ${url}: endpoint or model not found. The server may only expose /chat/completions — try API Mode = chat (or auto). Also verify the model name.`;
    case 400:
      return `HTTP 400: bad request — usually a wrong model name or unsupported parameter.`;
    case 429:
      return `HTTP 429: rate limited by the endpoint — slow down or raise your quota.`;
    case 422:
      return `HTTP 422: request rejected — the model may not support raw /completions; try API Mode = chat.`;
    default:
      return status >= 500 ? `HTTP ${status}: the model server errored. Check its logs.` : `HTTP ${status} from ${url}.`;
  }
}

function parseLine(raw: string, extract: (json: any) => string): string {
  const line = raw.trim();
  if (!line.startsWith("data:")) return "";
  const payload = line.slice(5).trim();
  if (payload === "" || payload === "[DONE]") return "";
  try {
    return extract(JSON.parse(payload)) ?? "";
  } catch {
    return "";
  }
}
