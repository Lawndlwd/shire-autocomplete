import * as vscode from "vscode";
import { QwenInlineProvider } from "./provider";
import { getConfig, SECRET_KEY, setCachedApiKey } from "./config";
import { Indexer } from "./index/indexer";
import { Status } from "./status";
import { PanelProvider } from "./ui/panel";

export async function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("Shire Autocompletion");
  log.appendLine("Shire Autocompletion activated.");

  // Load the encrypted API key into the sync cache before anything calls out.
  setCachedApiKey((await context.secrets.get(SECRET_KEY)) ?? "");
  context.subscriptions.push(
    context.secrets.onDidChange(async (e) => {
      if (e.key === SECRET_KEY) {
        setCachedApiKey((await context.secrets.get(SECRET_KEY)) ?? "");
      }
    })
  );

  const status = new Status();

  // Per-workspace storage so each repo keeps its own index (no cross-repo
  // contamination). Falls back to global storage when no folder is open.
  const storageUri = context.storageUri ?? context.globalStorageUri;

  // Build/restore the repo index in the background — never blocks activation.
  const indexer = new Indexer(storageUri, log, status);
  indexer.start().catch((e) => log.appendLine(`indexer.start failed: ${e?.message ?? e}`));

  const provider = new QwenInlineProvider(log, indexer, status);
  const registration = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: "**" },
    provider
  );

  // Sidebar UI.
  const panel = new PanelProvider({
    context,
    status,
    onRebuild: () => indexer.rebuild().catch((e) => log.appendLine(`rebuild failed: ${e?.message ?? e}`)),
  });
  const panelReg = vscode.window.registerWebviewViewProvider(PanelProvider.viewId, panel);

  const toggle = vscode.commands.registerCommand("shire.toggle", async () => {
    const cfg = vscode.workspace.getConfiguration("shire");
    const next = !cfg.get<boolean>("enabled", true);
    await cfg.update("enabled", next, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Shire Autocompletion ${next ? "enabled" : "disabled"}.`);
  });

  const showOutput = vscode.commands.registerCommand("shire.showOutput", () => log.show());

  const rebuild = vscode.commands.registerCommand("shire.rebuildIndex", () => {
    vscode.window.showInformationMessage("Shire: rebuilding repo index…");
    indexer.rebuild().catch((e) => log.appendLine(`rebuild failed: ${e?.message ?? e}`));
  });

  // Rebuild the index when settings that change its content/shape are edited
  // directly (the panel's Rebuild button covers the explicit case).
  const onCfgChange = vscode.workspace.onDidChangeConfiguration((e) => {
    if (
      e.affectsConfiguration("shire.enableRepoContext") ||
      e.affectsConfiguration("shire.enableSemanticRetrieval") ||
      e.affectsConfiguration("shire.embedModel")
    ) {
      log.appendLine("index-affecting setting changed — rebuilding.");
      indexer.rebuild().catch((err) => log.appendLine(`rebuild failed: ${err?.message ?? err}`));
    }
  });

  const cfg = getConfig();
  if (!cfg.baseUrl) {
    log.appendLine("WARNING: shire.baseUrl is empty — set it in the panel.");
  }

  context.subscriptions.push(registration, panelReg, toggle, showOutput, rebuild, onCfgChange, log, {
    dispose: () => {
      provider.dispose();
      indexer.dispose();
    },
  });
}

export function deactivate() {}
