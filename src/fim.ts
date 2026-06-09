// Fill-In-the-Middle prompt assembly for multiple model families. Each family
// uses its own special tokens and ordering — using the wrong ones yields
// garbage, so the template is selectable (or fully custom).

export type FimPreset = "qwen" | "starcoder" | "deepseek" | "codestral" | "custom";

export interface FimSpec {
  name: string;
  pre: string; // prefix sentinel
  suf: string; // suffix sentinel
  mid: string; // middle sentinel ("" if the family has none)
  spm: boolean; // true => suffix,prefix ordering (Codestral); false => prefix,suffix,middle
  stop: string[]; // server-side stop strings
  tokens: string[]; // every sentinel — used to truncate leaked output client-side
  custom?: string; // custom template containing {prefix} and {suffix}
}

const PRESETS: Record<Exclude<FimPreset, "custom">, FimSpec> = {
  // Qwen2.5-Coder / Qwen3-Coder
  qwen: {
    name: "qwen",
    pre: "<|fim_prefix|>",
    suf: "<|fim_suffix|>",
    mid: "<|fim_middle|>",
    spm: false,
    stop: ["<|fim_pad|>", "<|endoftext|>", "<|file_sep|>", "<|repo_name|>"],
    tokens: [
      "<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<|fim_pad|>",
      "<|endoftext|>", "<|file_sep|>", "<|repo_name|>",
    ],
  },
  // StarCoder / StarCoder2
  starcoder: {
    name: "starcoder",
    pre: "<fim_prefix>",
    suf: "<fim_suffix>",
    mid: "<fim_middle>",
    spm: false,
    stop: ["<|endoftext|>", "<file_sep>"],
    tokens: ["<fim_prefix>", "<fim_suffix>", "<fim_middle>", "<|endoftext|>", "<file_sep>"],
  },
  // DeepSeek-Coder (note the full-width pipe ｜ and underscore ▁)
  deepseek: {
    name: "deepseek",
    pre: "<｜fim▁begin｜>",
    suf: "<｜fim▁hole｜>",
    mid: "<｜fim▁end｜>",
    spm: false,
    stop: ["<｜end▁of▁sentence｜>"],
    tokens: ["<｜fim▁begin｜>", "<｜fim▁hole｜>", "<｜fim▁end｜>", "<｜end▁of▁sentence｜>"],
  },
  // Codestral (Mistral): suffix THEN prefix, no middle sentinel
  codestral: {
    name: "codestral",
    pre: "[PREFIX]",
    suf: "[SUFFIX]",
    mid: "",
    spm: true,
    stop: ["</s>"],
    tokens: ["[PREFIX]", "[SUFFIX]", "[MIDDLE]", "</s>"],
  },
};

// Resolve a spec from a preset name, or build a custom one. customTemplate must
// contain {prefix} and {suffix}; customStop is a comma-separated stop list.
export function getFimSpec(
  preset: FimPreset,
  customTemplate?: string,
  customStop?: string
): FimSpec {
  if (preset === "custom") {
    const stop = (customStop ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      name: "custom",
      pre: "",
      suf: "",
      mid: "",
      spm: false,
      stop,
      tokens: stop,
      custom: customTemplate || "{prefix}{suffix}",
    };
  }
  return PRESETS[preset] ?? PRESETS.qwen;
}

// Assemble the final prompt. `preamble` (recent edits + neighbor snippets, as
// comments) is folded into the prefix so the model treats it as context.
export function buildPrompt(
  spec: FimSpec,
  prefix: string,
  suffix: string,
  preamble = ""
): string {
  const pre = preamble + prefix;
  if (spec.custom) {
    return spec.custom.replace(/\{prefix\}/g, pre).replace(/\{suffix\}/g, suffix);
  }
  if (spec.spm) {
    // Codestral: [SUFFIX]{suffix}[PREFIX]{prefix}
    return `${spec.suf}${suffix}${spec.pre}${pre}`;
  }
  return `${spec.pre}${pre}${spec.suf}${suffix}${spec.mid}`;
}
