import {
  create,
  insertMultiple,
  removeMultiple,
  search,
  count,
  type AnyOrama,
} from "@orama/orama";
import { persist, restore } from "@orama/plugin-data-persistence";
import type { Chunk } from "./chunker";

export interface Hit {
  file: string;
  startLine: number;
  text: string;
  score: number;
}

// Thin wrapper over Orama. Holds repo chunks for two retrieval modes:
//  - lexical (BM25) over `text`  — instant, no network, the hot-path default
//  - vector over `embedding`     — opt-in semantic, needs a query embedding
// The vector field only exists when we know the embedding dimension.
export class Store {
  private db: AnyOrama | null = null;
  private dim: number | undefined;
  // Track inserted doc ids per file so a re-index of one file removes its old
  // chunks first — no duplicates accumulating on every save.
  private fileIds = new Map<string, string[]>();

  async init(dim?: number) {
    this.dim = dim;
    this.fileIds.clear();
    const schema: any = {
      file: "string",
      startLine: "number",
      text: "string",
    };
    if (dim && dim > 0) {
      schema.embedding = `vector[${dim}]`;
    }
    this.db = await create({ schema });
  }

  get ready(): boolean {
    return this.db !== null;
  }

  hasVectors(): boolean {
    return !!this.dim;
  }

  async insert(chunks: Chunk[], embeddings?: number[][]) {
    if (!this.db) return;
    const docs = chunks.map((c, i) => {
      const id = `${c.file}#${c.startLine}`;
      const d: any = { id, file: c.file, startLine: c.startLine, text: c.text };
      if (embeddings && embeddings[i]) {
        d.embedding = embeddings[i];
      }
      const ids = this.fileIds.get(c.file) ?? [];
      ids.push(id);
      this.fileIds.set(c.file, ids);
      return d;
    });
    await insertMultiple(this.db, docs);
  }

  // Serialize/restore the file→ids map so a disk-restored index can still
  // remove a file's prior chunks (otherwise re-index duplicates them).
  exportFileIds(): Record<string, string[]> {
    return Object.fromEntries(this.fileIds);
  }
  importFileIds(map: Record<string, string[]>) {
    this.fileIds = new Map(Object.entries(map));
  }

  // Drop all chunks for a file before re-inserting its fresh version.
  async removeByFile(file: string) {
    if (!this.db) return;
    const ids = this.fileIds.get(file);
    if (ids && ids.length) {
      try {
        await removeMultiple(this.db, ids);
      } catch {
        /* ignore */
      }
      this.fileIds.delete(file);
    }
  }

  async size(): Promise<number> {
    return this.db ? await count(this.db) : 0;
  }

  // BM25 keyword search. `term` is a space-joined bag of identifiers pulled
  // from the cursor line + recent edits.
  async lexical(term: string, limit: number, excludeFile?: string): Promise<Hit[]> {
    if (!this.db || !term.trim()) return [];
    const res = await search(this.db, { term, properties: ["text"], limit: limit + 4 });
    return this.toHits(res, limit, excludeFile);
  }

  async vector(queryVec: number[], limit: number, excludeFile?: string): Promise<Hit[]> {
    if (!this.db || !this.dim) return [];
    const res = await search(this.db, {
      mode: "vector",
      vector: { value: queryVec, property: "embedding" },
      similarity: 0.6,
      limit: limit + 10,
    } as any);
    return this.toHits(res, limit, excludeFile);
  }

  private toHits(res: any, limit: number, excludeFile?: string): Hit[] {
    const hits: Hit[] = [];
    for (const h of res.hits ?? []) {
      const doc = h.document;
      if (excludeFile && doc.file === excludeFile) continue;
      hits.push({ file: doc.file, startLine: doc.startLine, text: doc.text, score: h.score });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  // Serialize for disk persistence (the "memory" that survives restart).
  async dump(): Promise<string | null> {
    if (!this.db) return null;
    return (await persist(this.db, "json")) as string;
  }

  async load(data: string, dim?: number) {
    this.dim = dim;
    this.db = (await restore("json", data)) as AnyOrama;
  }
}
