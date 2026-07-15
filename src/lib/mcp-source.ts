import { invoke } from "@tauri-apps/api/core"
import type { McpServiceConfig } from "@/stores/wiki-store"
import type { WebSearchResult } from "./web-search"
import type { ResearchContext } from "./deepwiki-assembly"

// No hardcoded defaults for connection details - the user supplies endpoint,
// toolName, argumentTemplate. timeoutSecs/maxSnippetChars have safe defaults.

/**
 * cyrb53: deterministic, synchronous, non-cryptographic hash. Used to derive a
 * stable id for configs missing one (React key + dedupe identity). Synchronous
 * on purpose - `resolveSearchConfig` is a sync contract; `crypto.subtle.digest`
 * is async and would break it. Locked by the test vectors in mcp-source.test.ts.
 */
export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

function clampPositive(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

function deriveId(endpoint: string, toolName: string, name: string): string {
  return cyrb53(`${endpoint}|${toolName}|${name}`).toString(36).slice(0, 10)
}

/**
 * Normalize the MCP services list: fill defaults, keep invalid entries (do NOT
 * delete - deleting would let an enabled-but-incomplete service silently
 * disappear, violating "any selected source failure aborts"). Dedupe by id;
 * missing ids get a deterministic derived id (stable across resolve/load).
 * Collisions get a `-2`/`-3` suffix (collision set includes explicit + derived).
 */
export function normalizeMcpServiceConfigs(
  services?: McpServiceConfig[],
): Required<McpServiceConfig>[] {
  const input = Array.isArray(services) ? services : []
  const seen = new Set<string>()
  const out: Required<McpServiceConfig>[] = []
  for (const s of input) {
    const name = s?.name ?? ""
    const endpoint = s?.endpoint ?? ""
    const toolName = s?.toolName ?? ""
    const baseId = (s?.id ?? "").trim() || deriveId(endpoint, toolName, name)
    let id = baseId
    let suffix = 2
    while (seen.has(id)) {
      id = `${baseId}-${suffix}`
      suffix++
    }
    seen.add(id)
    out.push({
      id,
      name,
      enabled: s?.enabled ?? true,
      endpoint,
      authHeaders: s?.authHeaders ?? {},
      toolName,
      argumentTemplate: s?.argumentTemplate ?? "",
      timeoutSecs: clampPositive(s?.timeoutSecs, 120),
      maxSnippetChars: clampPositive(s?.maxSnippetChars, 4000),
    })
  }
  return out
}

/**
 * At least one enabled service with endpoint + toolName. Only the "selected but
 * entirely unconfigured" gate; per-service completeness is checked in
 * `mcpServicesSearch` (so an enabled-but-incomplete service aborts with its
 * name, not a silent skip).
 */
export function hasConfiguredMcpServices(services?: McpServiceConfig[]): boolean {
  return normalizeMcpServiceConfigs(services).some(
    (s) => s.enabled && s.endpoint.trim() && s.toolName.trim(),
  )
}

/** Wire shape returned by the `mcp_service_search` Tauri command. */
export interface McpServiceSearchResult {
  serviceId: string
  serviceName: string
  results: { title: string; url: string; snippet: string; source: string }[]
}

/**
 * Query all enabled MCP services in parallel. `{{topic}}` in each service's
 * argumentTemplate is filled by Rust with the research topic.
 *
 * Any enabled-but-incomplete service throws with its name (no silent skip). A
 * service HTTP/timeout/protocol failure **rejects** (throws) so
 * `collectResearchSources`'s `trackSourceCall` records it as a source error and
 * `executeResearch` aborts before synthesis.
 */
export async function mcpServicesSearch(
  context: ResearchContext,
  services: McpServiceConfig[],
): Promise<WebSearchResult[]> {
  const resolved = normalizeMcpServiceConfigs(services).filter((s) => s.enabled)
  for (const s of resolved) {
    if (!s.endpoint.trim() || !s.toolName.trim()) {
      throw new Error(
        `MCP service "${s.name || s.id}" is enabled but not fully configured (missing endpoint or toolName)`,
      )
    }
  }
  const settled = await Promise.all(
    resolved.map((s) =>
      invoke<McpServiceSearchResult>("mcp_service_search", {
        topic: context.topic,
        service: s,
      }),
    ),
  )
  const out: WebSearchResult[] = []
  for (const r of settled) {
    for (const item of r.results) {
      out.push({
        title: item.title,
        url: item.url,
        snippet: item.snippet,
        source: item.source,
      })
    }
  }
  return out
}

/** Identify a result as coming from an MCP service (Rust sets source="MCP: <name>"). */
export function isMcpResult(r: { source?: string }): boolean {
  return Boolean(r.source?.startsWith("MCP: "))
}

/**
 * Escape a string for use as plain-text reference text: fully escape Markdown
 * metacharacters and break URI schemes (`mcp://`, `http(s)://`, `ftp://`) by
 * inserting a zero-width space before `://`, so autolink-capable renderers
 * (react-markdown + remark-gfm) do not turn a bare `mcp://...` into a link.
 */
export function escapeMarkdownForRef(s: string): string {
  const escaped = s.replace(/[\\`*_\[\]()<>#+\-.!|~]/g, (m) => `\\${m}`)
  return escaped.replace(/\b(mcp|https?|ftp):\/\//g, "$1​://")
}
