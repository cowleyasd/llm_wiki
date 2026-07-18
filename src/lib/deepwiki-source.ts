import type { DeepWikiSourceConfig } from "@/stores/wiki-store"

// No hardcoded defaults for connection details — the user must supply their
// own DeepWiki base URL, space ID, model, branch, token, and a positive
// timeout. This keeps the fork free of any internal endpoint info so it can
// be published as a public repo without leaking private infrastructure.

export function normalizeDeepWikiConfig(config?: DeepWikiSourceConfig): Required<DeepWikiSourceConfig> {
  return {
    enabled: config?.enabled ?? false,
    baseUrl: config?.baseUrl?.trim() ?? "",
    token: config?.token?.trim() ?? "",
    spaceId: config?.spaceId?.trim() ?? "",
    model: config?.model?.trim() ?? "",
    branch: config?.branch?.trim() ?? "",
    // Empty instruction signals "use the built-in default" in assembleDeepWikiPrompt.
    assemblyInstruction: config?.assemblyInstruction ?? "",
    timeoutSecs: clampPositive(config?.timeoutSecs, 0),
    maxSnippetChars: clampPositive(config?.maxSnippetChars, 0),
    maxConcurrent: clampPositive(config?.maxConcurrent, 3),
    reuseSessions: config?.reuseSessions ?? false,
  }
}

function clampPositive(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

/**
 * Whether the DeepWiki source is fully configured. Every connection field
 * (baseUrl, spaceId, model, token, timeout) must be set by the user — there
 * are no built-in defaults. If the token field is empty Rust falls back to
 * ~/.claude/deepwiki.config.json, but that path is user-managed too.
 */
export function hasConfiguredDeepWiki(config?: DeepWikiSourceConfig): boolean {
  const resolved = normalizeDeepWikiConfig(config)
  // Every connection field must be set by the user — no built-in defaults.
  // token is allowed to be empty here because Rust falls back to
  // ~/.claude/deepwiki.config.json, but the other fields have no fallback.
  return Boolean(
    resolved.enabled &&
      resolved.baseUrl.trim() &&
      resolved.spaceId.trim() &&
      resolved.model.trim() &&
      resolved.branch.trim() &&
      resolved.timeoutSecs > 0 &&
      resolved.maxSnippetChars > 0,
  )
}

/** Wire shape returned by the `deepwiki_search` Tauri command. */
export interface DeepWikiSearchResult {
  content: string
  spaceUrl: string
}
