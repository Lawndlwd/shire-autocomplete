import * as vscode from "vscode";
import * as crypto from "crypto";
import { getConfig, SECRET_KEY, setCachedApiKey } from "../config";
import type { Status, StatusSnapshot } from "../status";

interface PanelDeps {
  context: vscode.ExtensionContext;
  status: Status;
  onRebuild: () => void;
}

// Sidebar UI: edit connection + behaviour settings and watch live index/latency
// state. Settings persist to workspace configuration; the API key goes to
// encrypted SecretStorage.
export class PanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "shire.panel";
  private view?: vscode.WebviewView;

  constructor(private deps: PanelDeps) {
    deps.status.onChange((s) => this.pushStatus(s));
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          await this.pushState();
          break;
        case "save":
          await vscode.workspace
            .getConfiguration("shire")
            .update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
          break;
        case "saveSecret":
          await this.deps.context.secrets.store(SECRET_KEY, msg.value ?? "");
          setCachedApiKey(msg.value ?? "");
          vscode.window.showInformationMessage("Shire: API key saved (encrypted).");
          break;
        case "rebuild":
          this.deps.onRebuild();
          break;
      }
    });
  }

  private async pushState() {
    if (!this.view) return;
    const cfg = getConfig();
    const hasSecret = !!(await this.deps.context.secrets.get(SECRET_KEY));
    this.view.webview.postMessage({
      type: "state",
      config: {
        enabled: cfg.enabled,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        embedModel: cfg.embedModel,
        hasApiKey: hasSecret,
        debounceMs: cfg.debounceMs,
        maxTokens: cfg.maxTokens,
        maxNeighborFiles: cfg.maxNeighborFiles,
        maxIndexFiles: cfg.maxIndexFiles,
        maxSemanticFiles: cfg.maxSemanticFiles,
        embedConcurrency: cfg.embedConcurrency,
        multiline: cfg.multiline,
        enableRecentEdits: cfg.enableRecentEdits,
        enableRepoContext: cfg.enableRepoContext,
        enableSemanticRetrieval: cfg.enableSemanticRetrieval,
      },
      status: this.deps.status.snapshot(),
    });
  }

  private pushStatus(s: StatusSnapshot) {
    this.view?.webview.postMessage({ type: "status", status: s });
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 10px 12px; }
  h3 { margin: 16px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; opacity: .7; }
  label { display:block; margin: 8px 0 3px; font-size: 12px; }
  input[type=text], input[type=password], input[type=number] {
    width: 100%; box-sizing: border-box; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent);
    padding: 5px 7px; border-radius: 3px; }
  .row { display:flex; align-items:center; gap:8px; margin:6px 0; }
  .row input[type=checkbox] { margin:0; }
  button { margin-top: 10px; width: 100%; padding: 6px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 3px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .status { margin-top: 8px; padding: 8px; border-radius: 4px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); font-size: 12px; }
  .status div { display:flex; justify-content:space-between; padding: 2px 0; }
  .pill { padding: 1px 7px; border-radius: 10px; font-size: 11px; }
  .ok { background:#1f7a3f; color:#fff; } .warn { background:#8a6d1f; color:#fff; }
  .err { background:#a3302a; color:#fff; } .muted { opacity:.7; }
  .hint { font-size: 11px; opacity:.6; margin-top: 2px; }
</style>
</head>
<body>
  <h3>Connection</h3>
  <label>Base URL <span class="hint">(ends in /v1)</span></label>
  <input id="baseUrl" type="text" placeholder="https://host/v1" />
  <label>API Key <span id="keyState" class="hint"></span></label>
  <input id="apiKey" type="password" placeholder="paste to update (stored encrypted)" />
  <button id="saveKey" class="secondary">Save API Key</button>
  <label>Model</label>
  <input id="model" type="text" />
  <label>Embedding Model</label>
  <input id="embedModel" type="text" />

  <h3>Behaviour</h3>
  <div class="row"><input id="enabled" type="checkbox" /><label for="enabled" style="margin:0">Autocomplete enabled</label></div>
  <div class="row"><input id="multiline" type="checkbox" /><label for="multiline" style="margin:0">Multi-line</label></div>
  <div class="row"><input id="enableRecentEdits" type="checkbox" /><label for="enableRecentEdits" style="margin:0">Recent-edit refactor assist</label></div>
  <div class="row"><input id="enableRepoContext" type="checkbox" /><label for="enableRepoContext" style="margin:0">Repo context (index)</label></div>
  <div class="row"><input id="enableSemanticRetrieval" type="checkbox" /><label for="enableSemanticRetrieval" style="margin:0">Semantic (embeddings)</label></div>
  <label>Debounce (ms)</label><input id="debounceMs" type="number" />
  <label>Max tokens</label><input id="maxTokens" type="number" />
  <label>Max neighbor files</label><input id="maxNeighborFiles" type="number" />

  <h3>Indexing</h3>
  <label>Max index files <span class="hint">(lexical / semantic off)</span></label><input id="maxIndexFiles" type="number" />
  <label>Max semantic files <span class="hint">(semantic on)</span></label><input id="maxSemanticFiles" type="number" />
  <label>Embed concurrency</label><input id="embedConcurrency" type="number" />

  <h3>Index status</h3>
  <div id="progwrap" style="display:none; margin-bottom:8px;">
    <div style="height:6px; background:var(--vscode-editorWidget-background); border-radius:3px; overflow:hidden;">
      <div id="progbar" style="height:100%; width:0%; background:var(--vscode-progressBar-background,#0a84ff); transition:width .15s;"></div>
    </div>
    <div id="progtext" class="hint" style="margin-top:3px;">—</div>
  </div>
  <div class="status">
    <div><span>State</span><span id="st_state" class="pill muted">—</span></div>
    <div><span>Files</span><span id="st_files">0</span></div>
    <div><span>Chunks</span><span id="st_chunks">0</span></div>
    <div><span>Retrieval</span><span id="st_mode">lexical</span></div>
    <div><span>Last first-token</span><span id="st_ftt">—</span></div>
    <div><span>Last neighbors</span><span id="st_nb">—</span></div>
    <div><span>Last error</span><span id="st_err" class="muted">none</span></div>
  </div>
  <button id="rebuild">Rebuild Index</button>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const TEXT = ["baseUrl","model","embedModel"];
  const NUM = ["debounceMs","maxTokens","maxNeighborFiles","maxIndexFiles","maxSemanticFiles","embedConcurrency"];
  const BOOL = ["enabled","multiline","enableRecentEdits","enableRepoContext","enableSemanticRetrieval"];

  function bind() {
    TEXT.forEach(k => $(k).addEventListener("change", e => save(k, e.target.value)));
    NUM.forEach(k => $(k).addEventListener("change", e => {
      const n = Number(e.target.value);
      if (!Number.isFinite(n)) { return; } // ignore empty/invalid — keep prior value
      save(k, n);
    }));
    BOOL.forEach(k => $(k).addEventListener("change", e => save(k, e.target.checked)));
    $("saveKey").addEventListener("click", () => {
      vscode.postMessage({ type: "saveSecret", value: $("apiKey").value });
      $("apiKey").value = "";
    });
    $("rebuild").addEventListener("click", () => vscode.postMessage({ type: "rebuild" }));
  }
  function save(key, value) { vscode.postMessage({ type: "save", key, value }); }

  function applyConfig(c) {
    TEXT.forEach(k => $(k).value = c[k] ?? "");
    NUM.forEach(k => $(k).value = c[k] ?? 0);
    BOOL.forEach(k => $(k).checked = !!c[k]);
    $("keyState").textContent = c.hasApiKey ? "✓ set (encrypted)" : "not set";
  }
  function applyStatus(s) {
    const building = s.indexState === "building";
    $("progwrap").style.display = building ? "block" : "none";
    if (building) {
      const pct = Math.round((s.progress || 0) * 100);
      $("progbar").style.width = pct + "%";
      $("progtext").textContent = (s.processed || 0) + "/" + (s.total || 0) + " files (" + pct + "%)";
    }
    const st = $("st_state");
    st.textContent = s.indexState;
    st.className = "pill " + (s.indexState==="ready"||s.indexState==="restored" ? "ok"
      : s.indexState==="building" ? "warn" : s.indexState==="error" ? "err" : "muted");
    $("st_files").textContent = s.files;
    $("st_chunks").textContent = s.chunks;
    $("st_mode").textContent = s.semanticDim>0 ? ("semantic dim="+s.semanticDim) : "lexical";
    $("st_ftt").textContent = s.lastFirstTokenMs ? (s.lastFirstTokenMs+" ms") : "—";
    $("st_nb").textContent = s.lastNeighbors != null ? s.lastNeighbors : "—";
    $("st_err").textContent = s.lastError || "none";
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "state") { applyConfig(m.config); applyStatus(m.status); }
    else if (m.type === "status") { applyStatus(m.status); }
  });

  bind();
  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
  }
}
