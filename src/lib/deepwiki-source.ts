import { invoke } from "@tauri-apps/api/core"
import type { DeepWikiSourceConfig, LlmConfig } from "@/stores/wiki-store"
import type { WebSearchResult } from "./web-search"
import { assembleDeepWikiPrompt, type ResearchContext } from "./deepwiki-assembly"

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

/**
 * Assemble a DeepWiki prompt from the research context, then query the
 * DeepWiki knowledge base via the Rust direct-HTTP command.
 *
 * Assembly failure is non-fatal (falls back to a template prompt). A
 * DeepWiki HTTP/timeout/config/parse failure **rejects** (throws) so that
 * `collectResearchSources`'s `Promise.allSettled` records it as a structured
 * source error and `executeResearch` aborts before synthesis.
 */
export async function deepWikiSearch(
  context: ResearchContext,
  config: DeepWikiSourceConfig,
  llmConfig: LlmConfig,
): Promise<WebSearchResult[]> {
  const resolved = normalizeDeepWikiConfig(config)
  if (!resolved.enabled) {
    throw new Error("DeepWiki source is disabled")
  }

  const { prompt } = await assembleDeepWikiPrompt(llmConfig, context, resolved.assemblyInstruction)

  const result = await invoke<DeepWikiSearchResult>("deepwiki_search", {
    prompt,
    config: resolved,
  })

  if (!result.content?.trim()) {
    throw new Error("DeepWiki returned an empty response")
  }

  return [
    {
      title: `DeepWiki: ${context.topic}`,
      url: result.spaceUrl,
      snippet: result.content,
      source: "DeepWiki",
    },
  ]
}
