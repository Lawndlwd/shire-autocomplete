import * as vscode from "vscode";

export interface Config {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  debounceMs: number;
  maxPrefixChars: number;
  maxSuffixChars: number;
  maxTokens: number;
  temperature: number;
  multiline: boolean;
  enableRecentEdits: boolean;
  enableRepoContext: boolean;
  enableSemanticRetrieval: boolean;
  embedModel: string;
  maxNeighborFiles: number;
  retrievalTimeoutMs: number;
  embedConcurrency: number;
  maxIndexFiles: number;
  maxSemanticFiles: number;
}

export const SECRET_KEY = "shire.apiKey";

// API key lives in encrypted SecretStorage, not plaintext settings. We cache it
// here so getConfig() can stay synchronous on the completion hot path.
let cachedApiKey = "";
export function setCachedApiKey(v: string) {
  cachedApiKey = v ?? "";
}
export function getCachedApiKey(): string {
  return cachedApiKey;
}

export function getConfig(): Config {
  const c = vscode.workspace.getConfiguration("shire");
  return {
    enabled: c.get<boolean>("enabled", true),
    baseUrl: c.get<string>("baseUrl", "http://localhost:8000/v1").replace(/\/+$/, ""),
    // Prefer the secret; fall back to a legacy plaintext setting if present.
    apiKey: cachedApiKey || c.get<string>("apiKey", ""),
    model: c.get<string>("model", "Qwen2.5-Coder-7B"),
    debounceMs: c.get<number>("debounceMs", 150),
    maxPrefixChars: c.get<number>("maxPrefixChars", 3000),
    maxSuffixChars: c.get<number>("maxSuffixChars", 1500),
    maxTokens: c.get<number>("maxTokens", 256),
    temperature: c.get<number>("temperature", 0.1),
    multiline: c.get<boolean>("multiline", true),
    enableRecentEdits: c.get<boolean>("enableRecentEdits", true),
    enableRepoContext: c.get<boolean>("enableRepoContext", true),
    enableSemanticRetrieval: c.get<boolean>("enableSemanticRetrieval", false),
    embedModel: c.get<string>("embedModel", "nomic-embed-text"),
    maxNeighborFiles: c.get<number>("maxNeighborFiles", 4),
    retrievalTimeoutMs: c.get<number>("retrievalTimeoutMs", 150),
    embedConcurrency: c.get<number>("embedConcurrency", 5),
    maxIndexFiles: c.get<number>("maxIndexFiles", 30000),
    maxSemanticFiles: c.get<number>("maxSemanticFiles", 3000),
  };
}
