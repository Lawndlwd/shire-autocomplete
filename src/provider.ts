import * as vscode from "vscode";
import { getConfig } from "./config";
import { getWindow } from "./context/window";
import { RecentEdits } from "./context/recentEdits";
import { getFimSpec, buildPrompt } from "./fim";
import { complete } from "./client";
import { LruCache, hash } from "./cache";
import type { Indexer } from "./index/indexer";
import { retrieve, type NeighborFile } from "./index/retrieve";
import type { Status } from "./status";

// Comment token per language so injected context reads as natural comments.
function commentToken(languageId: string): string {
  const hashSet = new Set(["python", "ruby", "shellscript", "yaml", "toml", "perl", "r", "elixir"]);
  return hashSet.has(languageId) ? "#" : "//";
}

export class QwenInlineProvider implements vscode.InlineCompletionItemProvider {
  private cache = new LruCache<string>(200);
  private recentEdits: RecentEdits;
  private inFlight?: AbortController;

  constructor(
    private log: vscode.OutputChannel,
    private indexer?: Indexer,
    private status?: Status
  ) {
    this.recentEdits = new RecentEdits();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const cfg = getConfig();
    if (!cfg.enabled) return;
    if (cfg.disabledLanguages.includes(document.languageId)) return;

    const { prefix, suffix } = getWindow(document, position, cfg.maxPrefixChars, cfg.maxSuffixChars);
    if (prefix.trim().length === 0) return;

    const commentTok = commentToken(document.languageId);
    const recentEdits = cfg.enableRecentEdits ? this.recentEdits.format(commentTok) : "";
    const spec = getFimSpec(cfg.fimTemplate, cfg.customFimTemplate, cfg.customStop);

    // Cache key includes everything that changes the result without changing the
    // local context: prompt-affecting config + the index version.
    const indexVersion = this.indexer?.version ?? 0;
    const sig = `${cfg.model}|${cfg.apiMode}|${cfg.fimTemplate}|${cfg.temperature}|${cfg.maxTokens}|${cfg.multiline}|v${indexVersion}`;
    const key = hash(`${prefix}${suffix}${recentEdits}${sig}`);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached ? [this.item(cached, position)] : undefined;
    }

    const idle = await this.debounce(cfg.debounceMs, token);
    if (!idle) return;

    // Tier-2 repo retrieval, time-boxed; the embedding request is aborted the
    // instant the time-box fires so slow embeds can't pile up.
    let neighbors: NeighborFile[] = [];
    const currentFile = vscode.workspace.asRelativePath(document.uri, false);
    if (cfg.enableRepoContext && this.indexer?.store.ready) {
      const retCtl = new AbortController();
      neighbors = await this.timeBox(
        retrieve({
          cfg,
          store: this.indexer.store,
          currentFile,
          cursorContext: prefix.slice(-400),
          recentEditsText: recentEdits,
          semantic: this.indexer.isSemantic,
          signal: retCtl.signal,
        }),
        cfg.retrievalTimeoutMs,
        [],
        () => retCtl.abort()
      );
    }

    const neighborBlock = neighbors.length
      ? neighbors.map((n) => this.commentSnippet(commentTok, n)).join("\n") + "\n"
      : "";
    const preamble = recentEdits + neighborBlock;
    const fimPrompt = buildPrompt(spec, prefix, suffix, preamble);

    this.inFlight?.abort();
    const ctl = new AbortController();
    this.inFlight = ctl;
    token.onCancellationRequested(() => ctl.abort());

    const result = await complete({
      cfg,
      fimPrompt,
      stop: spec.stop,
      prefix,
      suffix,
      preamble,
      signal: ctl.signal,
      log: (m) => this.log.appendLine(m),
      onError: (err) => this.status?.update({ lastError: err }),
    });
    if (!result || token.isCancellationRequested) return;
    this.status?.update({ lastError: "" });

    const text = this.postProcess(result.text, suffix, cfg.multiline, spec.tokens);
    this.cache.set(key, text);

    this.log.appendLine(
      `first-token ${result.firstTokenMs}ms · total ${result.totalMs}ms · ` +
        `${text.length} chars · ${neighbors.length} neighbors`
    );
    this.status?.update({
      lastFirstTokenMs: result.firstTokenMs,
      lastTotalMs: result.totalMs,
      lastNeighbors: neighbors.length,
    });

    if (!text) return;
    return [this.item(text, position)];
  }

  private item(text: string, position: vscode.Position): vscode.InlineCompletionItem {
    return new vscode.InlineCompletionItem(text, new vscode.Range(position, position));
  }

  // A neighbor snippet rendered as a safe comment block (every line commented so
  // the model never tries to "continue" it as live code).
  private commentSnippet(tok: string, n: NeighborFile): string {
    const lines = n.content.split("\n").map((l) => `${tok} ${l}`).join("\n");
    return `${tok} --- ${n.path} ---\n${lines}`;
  }

  private postProcess(raw: string, suffix: string, multiline: boolean, tokens: string[]): string {
    let text = raw;

    // Chat mode sometimes wraps output in a code fence — strip it.
    text = text.replace(/^\s*```[a-zA-Z0-9]*\n?/, "").replace(/```\s*$/, "");

    // Truncate at the earliest special token (a server ignoring `stop` may leak
    // sentinels or the next "file"). Covers all model families' tokens.
    let cut = -1;
    for (const t of tokens) {
      const i = text.indexOf(t);
      if (i !== -1 && (cut === -1 || i < cut)) cut = i;
    }
    if (cut !== -1) text = text.slice(0, cut);

    if (!multiline) {
      const nl = text.indexOf("\n");
      if (nl !== -1) text = text.slice(0, nl);
    }

    // Strip a trailing repeat of the code that already follows the cursor.
    const firstSuffixLine = suffix.split("\n")[0]?.trim();
    if (firstSuffixLine && firstSuffixLine.length > 3) {
      const idx = text.lastIndexOf(firstSuffixLine);
      if (idx > 0 && text.slice(idx + firstSuffixLine.length).trim() === "") {
        text = text.slice(0, idx);
      }
    }

    return text.replace(/\s+$/, "");
  }

  private timeBox<T>(p: Promise<T>, ms: number, fallback: T, onTimeout?: () => void): Promise<T> {
    return Promise.race([
      p.catch(() => fallback),
      new Promise<T>((resolve) =>
        setTimeout(() => {
          onTimeout?.();
          resolve(fallback);
        }, ms)
      ),
    ]);
  }

  private debounce(ms: number, token: vscode.CancellationToken): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(!token.isCancellationRequested), ms);
      token.onCancellationRequested(() => {
        clearTimeout(t);
        resolve(false);
      });
    });
  }

  dispose() {
    this.inFlight?.abort();
    this.recentEdits.dispose();
  }
}
