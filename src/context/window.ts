import * as vscode from "vscode";

export interface CodeWindow {
  prefix: string;
  suffix: string;
}

// Slice prefix/suffix around the cursor, budget-limited and trimmed to line
// boundaries so the model never sees a half-token of context. Tier-1 context:
// pure local string ops, no network, must stay well under a millisecond.
export function getWindow(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  maxPrefixChars: number,
  maxSuffixChars: number
): CodeWindow {
  const offset = doc.offsetAt(pos);
  const full = doc.getText();

  let prefix = full.slice(Math.max(0, offset - maxPrefixChars), offset);
  let suffix = full.slice(offset, offset + maxSuffixChars);

  // Trim the prefix forward to the first newline so we start on a clean line
  // (only if we actually truncated — keep file starts intact).
  if (offset - maxPrefixChars > 0) {
    const nl = prefix.indexOf("\n");
    if (nl !== -1) {
      prefix = prefix.slice(nl + 1);
    }
  }
  // Trim the suffix back to the last newline for the same reason.
  if (offset + maxSuffixChars < full.length) {
    const nl = suffix.lastIndexOf("\n");
    if (nl !== -1) {
      suffix = suffix.slice(0, nl);
    }
  }

  return { prefix, suffix };
}
