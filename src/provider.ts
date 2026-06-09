import * as vscode from "vscode";
import { getConfig } from "./config";
import { getWindow } from "./context/window";
import { RecentEdits } from "./context/recentEdits";
import { buildFimPrompt, type NeighborFile } from "./fim";
import { complete } from "./client";
import { LruCache, hash } from "./cache";
import type { Indexer } from "./index/indexer";
import { retrieve } from "./index/retrieve";
import type { Status } from "./status";

// Comment token per language so the recent-edits preamble reads naturally.
function commentToken(languageId: string): string {
  const set = new Set(["python", "ruby", "shellscript", "yaml", "toml", "perl", "r"]);
  return set.has(languageId) ? "#" : "//";
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
    if (!cfg.enabled) {
      return;
    }

    // Tier-1 context: prefix/suffix around the cursor.
    const { prefix, suffix } = getWindow(
      document,
      position,
      cfg.maxPrefixChars,
      cfg.maxSuffixChars
    );
    if (prefix.trim().length === 0) {
      return;
    }

    // Recent-edit context: feed the model the before→after diffs I just made,
    // so it can propagate an analogous change to where I'm typing now.
    const recentEdits = cfg.enableRecentEdits
      ? this.recentEdits.format(commentToken(document.languageId))
      : "";

    // Cache key = local context + everything else that changes the result:
    // prompt-affecting config and the index version (so a finished/updated
    // index never serves a completion computed against the old one). Neighbors
    // derive from index version + context, so we needn't compute them first.
    const indexVersion = this.indexer?.version ?? 0;
    const sig = `${cfg.model}|${cfg.temperature}|${cfg.maxTokens}|${cfg.multiline}|v${indexVersion}`;
    const key = hash(`${prefix}${suffix}${recentEdits}${sig}`);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached ? [this.item(cached, position)] : undefined;
    }

    // Debounce: wait out the idle window; bail if a newer keystroke cancels us.
    const idle = await this.debounce(cfg.debounceMs, token);
    if (!idle) {
      return;
    }

    // Tier-2 repo retrieval, time-boxed so it can never delay the completion.
    // Lexical is sub-millisecond; semantic (if on) issues a query-embedding
    // request that we abort the instant the time-box fires, so a slow embedding
    // endpoint can't pile up orphaned requests under fast typing.
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

    const prompt = buildFimPrompt(prefix, suffix, {
      recentEdits,
      neighbors,
      currentPath: currentFile,
      repoName: vscode.workspace.name ?? "workspace",
    });

    // Cancel any prior in-flight request, start a fresh one.
    this.inFlight?.abort();
    const ctl = new AbortController();
    this.inFlight = ctl;
    token.onCancellationRequested(() => ctl.abort());

    const result = await complete(cfg, prompt, ctl.signal, (m) => this.log.appendLine(m));
    if (!result || token.isCancellationRequested) {
      return; // don't cache results for a context the user already moved past
    }

    const text = this.postProcess(result.text, suffix, cfg.multiline);
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

    if (!text) {
      return;
    }
    return [this.item(text, position)];
  }

  private item(text: string, position: vscode.Position): vscode.InlineCompletionItem {
    return new vscode.InlineCompletionItem(text, new vscode.Range(position, position));
  }

  // Clean the raw model output.
  private postProcess(raw: string, suffix: string, multiline: boolean): string {
    // Special tokens mark structural boundaries — anything from the first one on
    // is never wanted content. Truncate (a server ignoring `stop` would else
    // leak "<|file_sep|>...the next file..."). Case-insensitive for safety.
    let text = raw;
    const tok = text.search(/<\|[a-z0-9_]+\|>/i);
    if (tok !== -1) {
      text = text.slice(0, tok);
    }

    if (!multiline) {
      const nl = text.indexOf("\n");
      if (nl !== -1) {
        text = text.slice(0, nl);
      }
    }

    // The model sometimes re-types the code that already follows the cursor.
    // Only strip it when it appears as a TRAILING repeat (everything after the
    // match is whitespace) — never cut a legitimate mid-completion occurrence.
    const firstSuffixLine = suffix.split("\n")[0]?.trim();
    if (firstSuffixLine && firstSuffixLine.length > 3) {
      const idx = text.lastIndexOf(firstSuffixLine);
      if (idx > 0 && text.slice(idx + firstSuffixLine.length).trim() === "") {
        text = text.slice(0, idx);
      }
    }

    return text.replace(/\s+$/, "");
  }

  // Race a promise against a timeout; on timeout run onTimeout (to abort the
  // underlying work) and return the fallback.
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
