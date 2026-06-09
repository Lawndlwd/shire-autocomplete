import * as vscode from "vscode";

// Tracks your recent before→after edits and formats them as a compact diff
// block to inject into the completion prompt. This is the cheap, high-value
// approximation of Cursor's "knows what you just did": when you make a change
// in file A and then start typing on similar code in file B, the model sees
// your recent diff and proposes the analogous change.
//
// Session-scoped. Not persistent "learning" — it resets on restart, and the
// model weights never change. It's in-context memory, which is the achievable
// version of what people mean by "it learns from me".

interface EditRecord {
  file: string; // basename for compactness
  oldText: string;
  newText: string;
}

export class RecentEdits {
  private buf: EditRecord[] = [];
  private readonly cap: number;
  // Shadow copy of each document's text, so on change we can recover the
  // pre-edit slice (the "before" half of the diff).
  private shadow = new Map<string, string>();
  private disposables: vscode.Disposable[] = [];

  constructor(cap = 16) {
    this.cap = cap;

    // Seed shadows for already-open docs.
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === "file") {
        this.shadow.set(doc.uri.toString(), doc.getText());
      }
    }

    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.uri.scheme === "file") {
          this.shadow.set(doc.uri.toString(), doc.getText());
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => this.onChange(e)),
      // Drop shadow copies of closed docs so the map doesn't grow unbounded.
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.shadow.delete(doc.uri.toString());
      })
    );
  }

  private onChange(e: vscode.TextDocumentChangeEvent) {
    if (e.document.uri.scheme !== "file" || e.contentChanges.length === 0) {
      return;
    }
    const key = e.document.uri.toString();
    const before = this.shadow.get(key);
    const file = e.document.uri.path.split("/").pop() ?? "file";

    if (before !== undefined) {
      for (const ch of e.contentChanges) {
        const oldText = before.slice(ch.rangeOffset, ch.rangeOffset + ch.rangeLength);
        const newText = ch.text;
        // Skip noise: identical, pure whitespace, single-char typing, huge pastes.
        const a = oldText.trim();
        const b = newText.trim();
        if (a === b) continue;
        if (b.length <= 1 && a.length === 0) continue; // plain typing one char
        if (oldText.length > 400 || newText.length > 400) continue;
        this.push({ file, oldText: this.oneLine(oldText), newText: this.oneLine(newText) });
      }
    }
    // Update shadow to post-change full text.
    this.shadow.set(key, e.document.getText());
  }

  private oneLine(s: string): string {
    return s.replace(/\s+/g, " ").trim().slice(0, 120);
  }

  private push(rec: EditRecord) {
    // Collapse consecutive edits to the same location (typing within one edit).
    const last = this.buf[this.buf.length - 1];
    if (last && last.file === rec.file && last.oldText === rec.oldText) {
      last.newText = rec.newText;
      return;
    }
    this.buf.push(rec);
    if (this.buf.length > this.cap) {
      this.buf.shift();
    }
  }

  // Compact diff block, most-recent last (closest to the cursor = most weight),
  // using the given comment token so it reads as a natural preamble to the code.
  format(commentToken: string, limit = 6): string {
    const recs = this.buf.slice(-limit);
    if (recs.length === 0) {
      return "";
    }
    const lines: string[] = [`${commentToken} Recent edits I just made:`];
    for (const r of recs) {
      if (r.oldText) {
        lines.push(`${commentToken} - [${r.file}] ${r.oldText}  =>  ${r.newText}`);
      } else {
        lines.push(`${commentToken} + [${r.file}] ${r.newText}`);
      }
    }
    return lines.join("\n") + "\n";
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}
