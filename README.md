# Shire Autocompletion

Fast inline code autocomplete for VS Code, powered by **your own** model endpoint — not a
hosted SaaS. Point it at any OpenAI-compatible server (vLLM, llama.cpp, Ollama, TGI, SGLang, or a
cloud endpoint) running a FIM-capable code model (Qwen2.5-Coder, Codestral, DeepSeek-Coder,
StarCoder2) and get Copilot-style ghost-text completions.

## Features

- **Inline FIM completions** with the correct fill-in-the-middle prompt format — streaming, low
  latency, debounced, request-cancelling.
- **Recent-edit refactor assist** — feeds your recent before→after edits into the prompt, so after
  you change something in one file, it proposes the analogous change as you type in another.
- **Cross-file repo context** — indexes your workspace (BM25 lexical by default) and injects the
  most relevant snippets. Optional **semantic** retrieval via your own embedding model.
- **Private by default** — your code only ever goes to the endpoint *you* configure. API key is
  stored in VS Code's encrypted SecretStorage.
- **Sidebar UI** — configure everything and watch live index/latency status, no JSON editing.

## Quick start

1. Install the extension.
2. Open the **Shire Autocompletion** panel from the Activity Bar (sparkle icon).
3. Set **Base URL** (e.g. `http://localhost:8000/v1`), **API Key** (if any), and **Model**.
4. Start typing in a code file — grey ghost text appears; press **Tab** to accept.

Your endpoint must expose OpenAI-compatible **`/v1/completions`** (legacy text completion, not
chat) with `stream` and `stop` support. Serve a **FIM/base** code model for best infill.

## Model compatibility (important)

Autocomplete needs a **fill-in-the-middle (FIM)** code model, and the FIM token
format **must match the model family**. Set `fimTemplate` accordingly:

| `fimTemplate` | Models |
|---|---|
| `qwen` (default) | Qwen2.5-Coder, Qwen3-Coder |
| `codestral` | Mistral Codestral |
| `deepseek` | DeepSeek-Coder |
| `starcoder` | StarCoder, StarCoder2 |
| `custom` | anything — set `customFimTemplate` (`{prefix}`/`{suffix}`) + `customStop` |

If your endpoint only exposes `/v1/chat/completions` (not the legacy
`/v1/completions`), set **`apiMode`** to `chat` or `auto`. Use **Test Connection**
in the panel to verify the model actually does FIM.

## How it works (concepts)

When your cursor sits in the middle of code, the extension sends the model two pieces:

- **prefix** — the code *before* the cursor.
- **suffix** — the code *after* the cursor.

The model fills the gap between them. This is **Fill-In-the-Middle (FIM)** — different
from chat, and the reason a normal chat model gives bad completions. Each model family marks
the prefix/suffix with its own special tokens, which is what `fimTemplate` selects.

On top of that, it can add **context** to the prompt: your recent edits and relevant snippets
from other files (found by indexing your repo). More context = smarter completions, at the cost
of a slightly bigger prompt.

## Configuration

The sidebar panel covers the essentials; **everything** is in VS Code Settings
(`Cmd/Ctrl+,` → search "Shire", or click **⚙** in the panel). Grouped reference:

### Connection
| Setting | Default | Meaning |
|---|---|---|
| `shire.baseUrl` | `http://localhost:8000/v1` | Your endpoint, ending in `/v1`. The extension calls `{baseUrl}/completions` (or `/chat/completions`). |
| `shire.apiKey` | — (panel) | Sent as `Authorization: Bearer`. Set it via the panel — stored encrypted, not in plaintext settings. |
| `shire.model` | `Qwen2.5-Coder-7B` | Completion model name as registered on your server. |

### Completion API
| Setting | Default | Meaning |
|---|---|---|
| `shire.apiMode` | `completions` | `completions` = FIM (best). `chat` = use `/chat/completions` (for endpoints lacking the legacy route; lower quality). `auto` = try completions, fall back to chat. |
| `shire.fimTemplate` | `qwen` | FIM token format — **must match your model family**: `qwen`, `starcoder`, `deepseek`, `codestral`, or `custom`. Wrong choice = garbage output. |
| `shire.customFimTemplate` | `{prefix}{suffix}` | Only when `fimTemplate=custom`. A template string containing the `{prefix}` and `{suffix}` placeholders, e.g. `<PRE>{prefix}<SUF>{suffix}<MID>`. |
| `shire.customStop` | — | Only when `fimTemplate=custom`. Comma-separated stop strings that end generation. |
| `shire.temperature` | `0.1` | Randomness. Low = deterministic, predictable completions (recommended). |
| `shire.maxTokens` | `256` | Max length of a single completion. |
| `shire.requestTimeoutMs` | `8000` | Give up on a request after this many ms (prevents a hung endpoint from freezing suggestions). |

### When completions fire / where
| Setting | Default | Meaning |
|---|---|---|
| `shire.enabled` | `true` | Master on/off. |
| `shire.debounceMs` | `150` | How long you must pause typing before a request fires. Higher = fewer requests, more lag. |
| `shire.multiline` | `true` | Allow multi-line completions. Off = single line only. |
| `shire.disabledLanguages` | `scminput, git-commit, plaintext` | Language ids where it stays silent. Add e.g. `markdown`, `json`. (Language id shows bottom-right of the editor.) |
| `shire.maxPrefixChars` | `3000` | How much code *before* the cursor to send. Bigger = more context, bigger/slower prompt. |
| `shire.maxSuffixChars` | `1500` | How much code *after* the cursor to send. |

### Context (recent edits + cross-file)
| Setting | Default | Meaning |
|---|---|---|
| `shire.enableRecentEdits` | `true` | Feed your recent before→after edits into the prompt, so a change in one file is suggested in another (refactor assist). |
| `shire.enableRepoContext` | `true` | Index the workspace and inject the most relevant snippets from other files. |
| `shire.maxNeighborFiles` | `4` | How many cross-file snippets to inject per completion. |
| `shire.retrievalTimeoutMs` | `150` | Max time spent finding cross-file context before giving up and completing without it (keeps things fast). |
| `shire.enableSemanticRetrieval` | `false` | Use embeddings (vector similarity) in addition to keyword search. Higher relevance, needs an embedding model + a slower index build. |
| `shire.embedModel` | `nomic-embed-text` | Embedding model name — only used when semantic is on. |

### Indexing
| Setting | Default | Meaning |
|---|---|---|
| `shire.maxIndexFiles` | `30000` | Max files indexed in lexical mode (semantic off). Covers large monorepos. |
| `shire.maxSemanticFiles` | `3000` | Max files indexed in semantic mode (every file is embedded, so kept lower). |
| `shire.embedConcurrency` | `5` | How many files to embed in parallel during a semantic build. Higher = faster build, more load on the endpoint. |

> File selection: the indexer skips `node_modules`, `.git`, build output, anything in your
> `.gitignore` / VS Code `files.exclude`, files over 120 KB, and non-code files. The set is
> sorted and capped deterministically, so rebuilds are identical.

## Commands

`Cmd/Ctrl+Shift+P` →
- **Shire Autocompletion: Test Connection** — verifies the endpoint and whether the model does FIM.
- **Shire Autocompletion: Rebuild Repo Index**
- **Shire Autocompletion: Show Debug Output** — per-completion latency + errors.
- **Shire Autocompletion: Toggle Enabled**

## What leaves your machine

When a completion fires, the code around your cursor (prefix + suffix), your recent
edits, and any retrieved cross-file snippets are sent to **your configured `baseUrl`**
— nowhere else. No telemetry. The API key is stored in encrypted SecretStorage.

## What it does / doesn't

- **Does:** Copilot-tier single/multi-line completion, cross-file context, refactor propagation —
  all against your own model.
- **Doesn't:** it is *in-context*, not model training — the model never learns your code into its
  weights. And it doesn't reproduce Cursor's custom next-edit "cursor jump" model; you get the
  suggestion when you start typing at the new site.

## Privacy

No telemetry. Your code is sent only to the `baseUrl` you set. The API key is kept in encrypted
SecretStorage, never in plaintext settings (a legacy plaintext `apiKey` setting is honored as a
fallback only).

## License

MIT
