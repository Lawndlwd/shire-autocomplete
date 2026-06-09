import type { Config } from "../config";
import type { NeighborFile } from "../fim";
import { embed } from "./embeddings";
import type { Store } from "./store";

const STOP_WORDS = new Set([
  "const", "let", "var", "function", "return", "import", "export", "from", "this",
  "true", "false", "null", "undefined", "async", "await", "class", "new", "for",
  "while", "if", "else", "the", "and", "def", "self", "public", "private", "static",
]);

// Pull meaningful identifiers from a blob of code/edits for a BM25 query.
function identifiers(text: string, limit = 14): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const matches = text.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? [];
  // Walk backwards so tokens nearest the cursor / most recent edits win.
  for (let i = matches.length - 1; i >= 0 && out.length < limit; i--) {
    const t = matches[i];
    const lower = t.toLowerCase();
    if (STOP_WORDS.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    out.push(t);
  }
  return out.join(" ");
}

export interface RetrieveInput {
  cfg: Config;
  store: Store;
  currentFile: string;
  cursorContext: string; // tail of prefix (the line(s) being typed)
  recentEditsText: string;
  semantic: boolean;
  signal?: AbortSignal; // aborted when the caller's time-box fires
}

// Returns neighbor snippets to inject as <|file_sep|> context. Lexical by
// default (no network); semantic adds a query-embedding round-trip and is
// gated by config. Caller time-boxes this so it never delays the completion.
export async function retrieve(input: RetrieveInput): Promise<NeighborFile[]> {
  const { cfg, store, currentFile, cursorContext, recentEditsText, semantic, signal } = input;
  if (!store.ready) return [];

  const k = cfg.maxNeighborFiles;
  const query = identifiers(cursorContext + "\n" + recentEditsText);

  const lexical = await store.lexical(query, k, currentFile);

  let merged = lexical;
  if (semantic && store.hasVectors()) {
    const qtext = (recentEditsText + "\n" + cursorContext).slice(-600);
    const vecs = await embed(cfg, [qtext], signal);
    if (vecs && vecs[0]) {
      const vhits = await store.vector(vecs[0], k, currentFile);
      // Merge, dedupe by file#line, keep best score order (vector first).
      const byKey = new Map<string, (typeof lexical)[number]>();
      for (const h of [...vhits, ...lexical]) {
        const key = `${h.file}#${h.startLine}`;
        if (!byKey.has(key)) byKey.set(key, h);
      }
      merged = [...byKey.values()].slice(0, k);
    }
  }

  return merged.map((h) => ({
    path: `${h.file}:${h.startLine}`,
    content: h.text.slice(0, 800),
  }));
}
