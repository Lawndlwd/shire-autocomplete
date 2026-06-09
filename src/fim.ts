// Qwen2.5-Coder Fill-In-the-Middle prompt assembly.
//
// File-level format (the model was trained on exactly this):
//   <|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>
//
// Repo-level format (cross-file context via neighbor snippets):
//   <|repo_name|>{repo}<|file_sep|>{path}\n{content>...<|file_sep|>{currentPath}\n
//   <|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>
//
// Getting these tokens exactly right is the single biggest quality lever. A
// chat template or a wrong token = garbage completions.

export const FIM_PREFIX = "<|fim_prefix|>";
export const FIM_SUFFIX = "<|fim_suffix|>";
export const FIM_MIDDLE = "<|fim_middle|>";
export const REPO_NAME = "<|repo_name|>";
export const FILE_SEP = "<|file_sep|>";

// Anything in this list ends generation. file_sep / endoftext stop the model
// from inventing whole new files; fim_pad is padding it should never emit.
export const STOP_TOKENS = ["<|fim_pad|>", "<|endoftext|>", "<|file_sep|>", "<|repo_name|>"];

export interface NeighborFile {
  path: string;
  content: string;
}

export function buildFimPrompt(
  prefix: string,
  suffix: string,
  opts?: {
    repoName?: string;
    currentPath?: string;
    neighbors?: NeighborFile[];
    recentEdits?: string;
  }
): string {
  // Recent-edit diffs go right before the cursor's code as a comment preamble,
  // so the model treats them as fresh context for what to type next.
  const pre = (opts?.recentEdits ?? "") + prefix;

  const neighbors = opts?.neighbors ?? [];
  if (neighbors.length === 0) {
    return `${FIM_PREFIX}${pre}${FIM_SUFFIX}${suffix}${FIM_MIDDLE}`;
  }

  let head = `${REPO_NAME}${opts?.repoName ?? "workspace"}`;
  for (const n of neighbors) {
    head += `${FILE_SEP}${n.path}\n${n.content}`;
  }
  head += `${FILE_SEP}${opts?.currentPath ?? "current"}\n`;
  return `${head}${FIM_PREFIX}${pre}${FIM_SUFFIX}${suffix}${FIM_MIDDLE}`;
}
