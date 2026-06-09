export interface Chunk {
  file: string; // workspace-relative path
  startLine: number;
  text: string;
}

// Split a file into overlapping line-windows. Simple and language-agnostic —
// good enough for retrieval. (A symbol-aware splitter via LSP is a later
// upgrade; line windows already retrieve the right neighborhood.)
export function chunkFile(
  relPath: string,
  content: string,
  windowLines = 40,
  overlap = 10
): Chunk[] {
  const lines = content.split("\n");
  if (lines.length === 0) {
    return [];
  }
  const chunks: Chunk[] = [];
  const step = Math.max(1, windowLines - overlap);
  for (let i = 0; i < lines.length; i += step) {
    const slice = lines.slice(i, i + windowLines);
    const text = slice.join("\n").trim();
    if (text.length < 16) {
      continue; // skip near-empty windows
    }
    chunks.push({ file: relPath, startLine: i + 1, text });
    if (i + windowLines >= lines.length) {
      break;
    }
  }
  return chunks;
}
