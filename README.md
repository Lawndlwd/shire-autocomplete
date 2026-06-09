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

## Settings

| Setting | Default | What it does |
|---|---|---|
| `baseUrl` | `http://localhost:8000/v1` | Endpoint base (ends in `/v1`) |
| `model` | `Qwen2.5-Coder-7B` | Completion model name |
| `enableRecentEdits` | `true` | Recent-edit refactor assist |
| `enableRepoContext` | `true` | Index repo, inject cross-file snippets (lexical) |
| `enableSemanticRetrieval` | `false` | Also use embeddings for similarity |
| `embedModel` | `nomic-embed-text` | Embedding model (semantic mode) |
| `maxIndexFiles` | `5000` | File cap, lexical mode (raise for monorepos) |
| `maxSemanticFiles` | `2000` | File cap, semantic mode |
| `debounceMs` | `150` | Idle time before a request fires |
| `maxTokens` | `256` | Max tokens per completion |
| `maxNeighborFiles` | `4` | Cross-file snippets per completion |

Commands: **Toggle Enabled**, **Show Debug Output**, **Rebuild Repo Index**.

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
