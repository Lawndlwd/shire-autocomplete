# Changelog

## 0.2.0

- **Multi-model FIM**: selectable `fimTemplate` (qwen / starcoder / deepseek / codestral / custom)
  so non-Qwen models work correctly.
- **Chat fallback**: `apiMode` = completions / chat / auto for endpoints that only expose
  `/v1/chat/completions`.
- **Request timeout** (`requestTimeoutMs`) so a hung endpoint no longer freezes silently.
- **Per-language disable** (`disabledLanguages`).
- Panel now surfaces API mode, FIM template, temperature, timeouts, and context budgets.
- Test Connection reflects the configured mode/template and gives clearer guidance.
- README corrected (defaults) and documents what data leaves the machine.

## 0.1.0

- Initial release.
- Inline FIM autocomplete against any OpenAI-compatible endpoint.
- Recent-edit refactor assist.
- Repo indexing with lexical (BM25) and optional semantic (embeddings) cross-file retrieval.
- Per-workspace persisted index; `.gitignore`-aware file selection.
- Sidebar configuration + live index/latency status panel.
- API key stored in encrypted SecretStorage.
