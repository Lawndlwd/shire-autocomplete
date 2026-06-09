import * as vscode from "vscode";
import { getConfig } from "../config";
import { chunkFile, type Chunk } from "./chunker";
import { embed } from "./embeddings";
import { Store } from "./store";
import { buildIgnore } from "./ignores";
import type { Status } from "../status";

const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "c", "h",
  "cpp", "hpp", "cc", "cs", "rb", "php", "swift", "scala", "sh", "lua", "vue", "svelte",
  "sql", "json", "yaml", "yml", "toml", "md",
]);
const EXCLUDE =
  "**/{node_modules,.git,dist,out,build,.next,.nuxt,vendor,__pycache__,.venv,target,coverage}/**";
const MAX_FILE_BYTES = 120_000;
const EMBED_BATCH = 32;
const PERSIST_VERSION = 3;

interface FileMeta {
  mtimeMs: number;
  size: number;
}

// Result of reading+embedding a file (the parallelizable part), ready to be
// committed to the store under the serialized write queue.
interface Prepared {
  rel: string;
  remove: boolean; // true = just drop it (too big / empty / unreadable)
  reason?: "big" | "empty" | "unreadable"; // why it was dropped, for diagnostics
  chunks?: Chunk[];
  embeddings?: number[][];
  meta?: FileMeta;
}

export class Indexer {
  readonly store = new Store();
  private building = false;
  private semantic = false;
  private dim: number | undefined;
  private embedModel = "";
  private persistTimer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];
  private fileMeta = new Map<string, FileMeta>();
  private _version = 0;
  // Bumped whenever a full build starts; a background reconcile captures it and
  // aborts the moment it changes, so reconcile and build can't fight over the
  // store.
  private gen = 0;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private storageUri: vscode.Uri,
    private log: vscode.OutputChannel,
    private status: Status
  ) {}

  get isSemantic(): boolean {
    return this.semantic;
  }
  get version(): number {
    return this._version;
  }
  private bump() {
    this._version++;
  }

  async start() {
    const cfg = getConfig();
    if (!cfg.enableRepoContext) {
      this.log.appendLine("repo context disabled — skipping index.");
      this.status.update({ indexState: "disabled" });
      return;
    }
    this.semantic = cfg.enableSemanticRetrieval;
    this.embedModel = cfg.embedModel;

    const restored = await this.tryRestore(cfg);
    if (!restored) {
      await this.build(cfg);
    } else {
      this.reconcile(cfg).catch((e) =>
        this.log.appendLine(`reconcile failed: ${e?.message ?? e}`)
      );
    }

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => this.reindexFile(doc)),
      vscode.workspace.onDidDeleteFiles((e) => {
        for (const uri of e.files) {
          const rel = this.rel(uri);
          this.enqueue(async () => {
            await this.store.removeByFile(rel);
            this.fileMeta.delete(rel);
            this.bump();
          });
        }
        this.schedulePersist();
      })
    );
  }

  async rebuild() {
    const cfg = getConfig();
    if (!cfg.enableRepoContext) {
      this.status.update({ indexState: "disabled" });
      return;
    }
    this.semantic = cfg.enableSemanticRetrieval;
    this.embedModel = cfg.embedModel;
    this.log.appendLine("rebuild requested.");
    await this.build(cfg);
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.writeQueue = this.writeQueue.then(fn, fn);
    return this.writeQueue;
  }

  private async build(cfg: ReturnType<typeof getConfig>) {
    if (this.building) {
      this.log.appendLine("build already in progress — ignoring this request.");
      return;
    }
    this.building = true;
    this.gen++; // invalidate any in-flight reconcile
    this.status.update({ indexState: "building", processed: 0, total: 0, progress: 0 });
    const t0 = Date.now();
    this.log.appendLine("building index…");
    try {
      let dim: number | undefined;
      if (this.semantic) {
        const probe = await embed(cfg, ["dimension probe"]);
        if (probe && probe[0]) {
          dim = probe[0].length;
          this.dim = dim;
          this.log.appendLine(`semantic on — embedding dim = ${dim}`);
        } else {
          this.semantic = false;
          this.dim = undefined;
          this.log.appendLine("embedding probe failed — falling back to lexical only.");
        }
      } else {
        this.dim = undefined;
      }
      await this.store.init(dim);
      this.fileMeta.clear();

      const files = await this.scanFiles();
      const total = files.length;
      this.status.update({ processed: 0, total, progress: total ? 0 : 1 });

      const step = Math.max(1, Math.floor(total / 100));
      const conc = this.semantic ? Math.max(1, cfg.embedConcurrency) : 4;
      let indexed = 0;
      let processed = 0;
      const skips = { big: 0, empty: 0, unreadable: 0 };

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Shire: indexing repo" },
        async (prog) => {
          await this.pool(files, conc, async (uri) => {
            const prep = await this.prepareFile(uri, cfg); // network (embeddings) — parallel
            await this.commitFile(prep); // store mutation — serialized
            if (prep.chunks && prep.chunks.length) indexed++;
            else if (prep.reason) skips[prep.reason]++;
            processed++;
            const pct = total ? Math.round((processed / total) * 100) : 100;
            prog.report({ message: `${processed}/${total} (${pct}%)` });
            if (this.semantic || processed % step === 0) {
              this.status.update({ processed, total, progress: total ? processed / total : 1 });
            }
          });
        }
      );

      this.bump();
      const chunks = await this.store.size();
      this.log.appendLine(
        `index built: ${indexed}/${total} files indexed, ${chunks} chunks, ${Date.now() - t0}ms ` +
          `(semantic=${this.semantic}, concurrency=${conc})`
      );
      this.log.appendLine(
        `  skipped: ${skips.big} too-big(>${MAX_FILE_BYTES / 1000}KB), ` +
          `${skips.empty} empty/too-small, ${skips.unreadable} unreadable/binary`
      );
      this.status.update({
        indexState: "ready",
        files: indexed,
        chunks,
        semanticDim: this.dim ?? 0,
        progress: 1,
        processed: indexed,
        total: indexed,
      });
      this.schedulePersist();
    } catch (e: any) {
      this.log.appendLine(`index build error: ${e?.message ?? e}`);
      this.status.update({ indexState: "error", lastError: String(e?.message ?? e) });
    } finally {
      this.building = false;
    }
  }

  // Read + chunk + embed a file. No store mutation here, so it is safe to run
  // many of these concurrently — that's what parallelizes the embedding calls.
  private async prepareFile(uri: vscode.Uri, cfg: ReturnType<typeof getConfig>): Promise<Prepared> {
    const rel = this.rel(uri);
    let stat: vscode.FileStat;
    let bytes: Uint8Array;
    try {
      stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_BYTES) return { rel, remove: true, reason: "big" };
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      return { rel, remove: true, reason: "unreadable" };
    }
    const content = Buffer.from(bytes).toString("utf8");
    const chunks = chunkFile(rel, content);
    if (chunks.length === 0) return { rel, remove: true, reason: "empty" };

    let embeddings: number[][] | undefined;
    if (this.semantic && this.store.hasVectors()) {
      embeddings = [];
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH).map((c) => c.text);
        const vecs = await embed(cfg, batch);
        if (!vecs) {
          embeddings = undefined; // degrade this file to lexical
          break;
        }
        embeddings.push(...vecs);
      }
    }
    return { rel, remove: false, chunks, embeddings, meta: { mtimeMs: stat.mtime, size: stat.size } };
  }

  // Apply a prepared file to the store on the serialized write queue. Always
  // removes prior chunks first (upsert) so re-indexing never duplicates.
  private commitFile(p: Prepared): Promise<void> {
    return this.enqueue(async () => {
      await this.store.removeByFile(p.rel);
      if (p.remove || !p.chunks || p.chunks.length === 0) {
        this.fileMeta.delete(p.rel);
        return;
      }
      await this.store.insert(p.chunks, p.embeddings);
      if (p.meta) this.fileMeta.set(p.rel, p.meta);
    });
  }

  private async reindexFile(doc: vscode.TextDocument) {
    if (!this.store.ready || doc.uri.scheme !== "file" || !this.isCode(doc.uri)) return;
    const cfg = getConfig();
    const prep = await this.prepareFile(doc.uri, cfg);
    await this.commitFile(prep);
    this.bump();
    this.schedulePersist();
  }

  private async reconcile(cfg: ReturnType<typeof getConfig>) {
    const myGen = this.gen;
    if (this.building) return; // a full build is authoritative; don't interfere
    const files = await this.scanFiles();
    const present = new Set<string>();
    const changed: vscode.Uri[] = [];

    for (const uri of files) {
      const rel = this.rel(uri);
      present.add(rel);
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch {
        continue;
      }
      const meta = this.fileMeta.get(rel);
      if (!meta || meta.mtimeMs !== stat.mtime || meta.size !== stat.size) {
        changed.push(uri);
      }
    }

    const conc = this.semantic ? Math.max(1, cfg.embedConcurrency) : 4;
    await this.pool(changed, conc, async (uri) => {
      if (this.gen !== myGen || this.building) return; // a build superseded us
      const prep = await this.prepareFile(uri, cfg);
      await this.commitFile(prep);
    });
    if (this.gen !== myGen || this.building) {
      this.log.appendLine("reconcile aborted — superseded by a full build.");
      return;
    }

    let removed = 0;
    for (const rel of [...this.fileMeta.keys()]) {
      if (!present.has(rel)) {
        removed++;
        await this.enqueue(async () => {
          await this.store.removeByFile(rel);
          this.fileMeta.delete(rel);
        });
      }
    }

    if (changed.length + removed > 0) {
      this.bump();
      const chunks = await this.store.size();
      this.log.appendLine(
        `reconcile: ${changed.length} changed, ${removed} removed, ${chunks} chunks.`
      );
      this.status.update({ indexState: "ready", chunks, files: this.fileMeta.size });
      this.schedulePersist();
    }
  }

  // Scan workspace files deterministically: fetch ALL matches (no arbitrary
  // result cap — that would return a different random subset each run and make
  // the index count jump around), filter, sort by path, then apply our own cap.
  // Same inputs → same file set every rebuild.
  private async scanFiles(): Promise<vscode.Uri[]> {
    const cfg = getConfig();
    // Semantic embeds every indexed file (expensive) → tighter cap. Lexical is
    // cheap → can cover the whole repo.
    const cap = Math.max(1, this.semantic ? cfg.maxSemanticFiles : cfg.maxIndexFiles);
    const which = this.semantic ? "maxSemanticFiles" : "maxIndexFiles";
    const isIgnored = await buildIgnore(EXCLUDE);
    const all = await vscode.workspace.findFiles("**/*", EXCLUDE); // no maxResults → all
    const code = all
      .filter((u) => this.isCode(u) && !isIgnored(this.rel(u)))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (code.length > cap) {
      this.log.appendLine(
        `NOTE: ${code.length} code files found, capping at ${cap} (raise shire.${which}). ` +
          `Capped set is deterministic (sorted by path).`
      );
      return code.slice(0, cap);
    }
    return code;
  }

  // Bounded-concurrency worker pool.
  private async pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
    let next = 0;
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) break;
        try {
          await fn(items[i]);
        } catch (e: any) {
          this.log.appendLine(`index task failed: ${e?.message ?? e}`);
        }
      }
    };
    const n = Math.max(1, Math.min(concurrency, items.length));
    await Promise.all(Array.from({ length: n }, worker));
  }

  private isCode(uri: vscode.Uri): boolean {
    const ext = uri.path.split(".").pop()?.toLowerCase() ?? "";
    return CODE_EXT.has(ext);
  }

  private rel(uri: vscode.Uri): string {
    return vscode.workspace.asRelativePath(uri, false);
  }

  // ---- persistence ----

  // Metadata (small) and the index blob (potentially hundreds of MB of vectors)
  // live in SEPARATE files. The blob is written as raw bytes — wrapping it in a
  // JSON string would escape+concatenate it past V8's ~536MB string cap and
  // throw "Invalid string length", which is exactly what broke persistence.
  private metaFileUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, "repo-index.meta.json");
  }
  private dataFileUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, "repo-index.data");
  }

  private schedulePersist() {
    // Longer debounce: on a big semantic repo the blob is large, so coalesce
    // rapid saves into one write rather than re-dumping on every keystroke-save.
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persist(), 8000);
  }

  private async persist() {
    try {
      const data = await this.store.dump();
      if (!data) return;
      await vscode.workspace.fs.createDirectory(this.storageUri);
      const meta = JSON.stringify({
        version: PERSIST_VERSION,
        dim: this.dim ?? 0,
        semantic: this.semantic,
        embedModel: this.embedModel,
        fileMeta: Object.fromEntries(this.fileMeta),
        fileIds: this.store.exportFileIds(),
      });
      // Blob first, then meta — meta acts as the commit marker; if the blob
      // write fails, a stale meta won't point at a half-written blob.
      await vscode.workspace.fs.writeFile(this.dataFileUri(), Buffer.from(data, "utf8"));
      await vscode.workspace.fs.writeFile(this.metaFileUri(), Buffer.from(meta, "utf8"));
    } catch (e: any) {
      this.log.appendLine(`persist failed: ${e?.message ?? e}`);
    }
  }

  private async tryRestore(cfg: ReturnType<typeof getConfig>): Promise<boolean> {
    try {
      const metaRaw = await vscode.workspace.fs.readFile(this.metaFileUri());
      const parsed = JSON.parse(Buffer.from(metaRaw).toString("utf8"));
      if (parsed.version !== PERSIST_VERSION) {
        this.log.appendLine("index format changed — rebuilding.");
        return false;
      }
      const dim = Number(parsed.dim) || undefined;
      const persistedSemantic = !!parsed.semantic;

      if (persistedSemantic !== cfg.enableSemanticRetrieval) {
        this.log.appendLine("semantic setting changed since last index — rebuilding.");
        return false;
      }
      if (persistedSemantic && parsed.embedModel !== cfg.embedModel) {
        this.log.appendLine("embedding model changed since last index — rebuilding.");
        return false;
      }

      this.dim = dim;
      this.semantic = persistedSemantic;
      this.embedModel = parsed.embedModel ?? cfg.embedModel;

      const dataRaw = await vscode.workspace.fs.readFile(this.dataFileUri());
      const data = Buffer.from(dataRaw).toString("utf8");
      await this.store.load(data, dim);
      this.store.importFileIds(parsed.fileIds ?? {});
      this.fileMeta = new Map(Object.entries(parsed.fileMeta ?? {}) as [string, FileMeta][]);

      const chunks = await this.store.size();
      this.log.appendLine(`index restored from disk: ${chunks} chunks, ${this.fileMeta.size} files.`);
      if (chunks > 0) {
        this.status.update({
          indexState: "restored",
          chunks,
          files: this.fileMeta.size,
          semanticDim: dim ?? 0,
          progress: 1,
        });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  dispose() {
    clearTimeout(this.persistTimer);
    for (const d of this.disposables) d.dispose();
  }
}
