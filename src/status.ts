// Shared, observable runtime state surfaced in the UI panel. Indexer and
// provider write to it; the webview subscribes and re-renders on change.

export type IndexState = "idle" | "building" | "ready" | "restored" | "disabled" | "error";

export interface StatusSnapshot {
  indexState: IndexState;
  files: number;
  chunks: number;
  semanticDim: number; // 0 = lexical only
  progress: number; // 0..1 during a build, 1 when idle/done
  processed: number; // files processed so far in the current build
  total: number; // total files to process in the current build
  lastFirstTokenMs: number;
  lastTotalMs: number;
  lastNeighbors: number;
  lastError: string;
}

export class Status {
  private state: StatusSnapshot = {
    indexState: "idle",
    files: 0,
    chunks: 0,
    semanticDim: 0,
    progress: 1,
    processed: 0,
    total: 0,
    lastFirstTokenMs: 0,
    lastTotalMs: 0,
    lastNeighbors: 0,
    lastError: "",
  };
  private listeners = new Set<(s: StatusSnapshot) => void>();

  snapshot(): StatusSnapshot {
    return { ...this.state };
  }

  onChange(fn: (s: StatusSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  update(patch: Partial<StatusSnapshot>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) {
      fn(this.snapshot());
    }
  }
}
