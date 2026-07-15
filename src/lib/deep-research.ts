import { anyTxtSearchSmart, hasConfiguredAnyTxt } from "./anytxt-search"
import { hasConfiguredSearchProvider, resolveSearchConfig, webSearch, type WebSearchResult } from "./web-search"
import { deepWikiSearch, hasConfiguredDeepWiki } from "./deepwiki-source"
import { mcpServicesSearch, hasConfiguredMcpServices, isMcpResult, escapeMarkdownForRef } from "./mcp-source"
import type { GapContext, ResearchContext, ReviewItemSnapshot } from "./deepwiki-assembly"
import { streamChat } from "./llm-client"
import { currentWikiDate } from "./ingest"
import { writeFile, readFile } from "@/commands/fs"
import { useWikiStore, type LlmConfig, type SearchApiConfig } from "@/stores/wiki-store"
import { useResearchStore } from "@/stores/research-store"
import { useReviewStore } from "@/stores/review-store"
import { normalizePath } from "@/lib/path-utils"
import { buildLanguageDirective } from "@/lib/output-language"
import { makeQueryFileName } from "@/lib/wiki-filename"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"

const MAX_RESEARCH_SOURCES = 20

interface ResearchSourceDeps {
  webSearch: typeof webSearch
  anyTxtSearch: typeof anyTxtSearchSmart
  deepWikiSearch: typeof deepWikiSearch
  mcpServicesSearch: typeof mcpServicesSearch
}

interface CollectResearchSourceOptions {
  llmConfig?: LlmConfig
  context?: ResearchContext
}

export interface ResearchSourceError {
  source: string
  message: string
}

interface ResearchSourceCollection {
  results: WebSearchResult[]
  errors: ResearchSourceError[]
}

export function noResearchSourcesTaskPatch(sourceErrors: ResearchSourceError[]): {
  status: "done" | "error"
  synthesis: string
  error: string | null
} {
  // If every selected source produced zero usable results and at least
  // one source failed, surface the failure state explicitly. Otherwise
  // the UI shows "completed" for a task that could not actually search.
  if (sourceErrors.length > 0) {
    return {
      status: "error",
      synthesis: "",
      error: sourceErrors.map((e) => `[${e.source}] ${e.message}`).join("\n"),
    }
  }
  return {
    status: "done",
    synthesis: "No research sources found.",
    error: null,
  }
}

export function makeDeepResearchFileName(topic: string, now: Date = new Date()): {
  fileName: string
  date: string
} {
  const { fileName } = makeQueryFileName(`research-${topic}`, now)
  return { fileName, date: currentWikiDate(now) }
}

/**
 * Context carried from a research trigger (review item, graph gap, etc.) into
 * the task. Only the fields needed for DeepWiki prompt assembly are snapshotted;
 * the review item is NOT stored wholesale to avoid stale-snapshot drift.
 */
export interface ResearchTriggerContext {
  reviewItemId?: string
  reviewItem?: ReviewItemSnapshot
  gapContext?: GapContext
}

/**
 * Queue a deep research task. Automatically starts processing if under concurrency limit.
 */
export function queueResearch(
  projectPath: string,
  topic: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
  searchQueries?: string[],
  trigger?: ResearchTriggerContext,
): string {
  const store = useResearchStore.getState()
  const taskId = store.addTask(topic)
  // Store search queries on the task
  if (searchQueries && searchQueries.length > 0) {
    store.updateTask(taskId, { searchQueries })
  }
  if (trigger) {
    store.updateTask(taskId, {
      reviewItemId: trigger.reviewItemId,
      researchContext: {
        reviewItem: trigger.reviewItem,
        gapContext: trigger.gapContext,
      },
    })
  }
  // Ensure panel is open
  store.setPanelOpen(true)
  // Start processing on next tick to ensure React has rendered the panel
  setTimeout(() => {
    processQueue(projectPath, llmConfig, searchConfig)
  }, 50)
  return taskId
}

async function trackSourceCall(
  source: string,
  p: Promise<WebSearchResult[]>,
): Promise<{ source: string; results: WebSearchResult[]; error: string | null }> {
  try {
    const results = await p
    return { source, results, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[DeepResearch] source "${source}" failed:`, message)
    return { source, results: [], error: message }
  }
}

export async function collectResearchSources(
  queries: string[],
  searchConfig: SearchApiConfig,
  projectPath: string,
  deps: ResearchSourceDeps = { webSearch, anyTxtSearch: anyTxtSearchSmart, deepWikiSearch, mcpServicesSearch },
  options: CollectResearchSourceOptions = {},
): Promise<ResearchSourceCollection> {
  const resolvedSearchConfig = resolveSearchConfig(searchConfig)
  const sources = resolvedSearchConfig.deepResearchSources ?? ["web"]
  const useWeb = sources.includes("web")
  const useAnyTxt = sources.includes("anytxt")
  const useDeepWiki = sources.includes("deepwiki")
  const useMcpServices = sources.includes("mcpServices")

  const webConfigured = hasConfiguredSearchProvider(resolvedSearchConfig)
  const anyTxtConfigured = hasConfiguredAnyTxt(resolvedSearchConfig.anyTxt)
  const deepWikiConfigured = hasConfiguredDeepWiki(resolvedSearchConfig.deepWiki)
  const mcpConfigured = hasConfiguredMcpServices(resolvedSearchConfig.mcpServices)

  const allResults: WebSearchResult[] = []
  const errors: ResearchSourceError[] = []
  const seenUrls = new Set<string>()
  let cappedWarned = false

  function addResults(results: WebSearchResult[]) {
    for (const r of results) {
      if (allResults.length >= MAX_RESEARCH_SOURCES) {
        if (!cappedWarned) {
          console.info(`[DeepResearch] capped at ${MAX_RESEARCH_SOURCES} research sources; later results were truncated.`)
          cappedWarned = true
        }
        return
      }
      const key = (r.url || `${r.source}:${r.title}:${r.snippet}`).toLowerCase()
      if (!seenUrls.has(key)) {
        seenUrls.add(key)
        allResults.push(r)
      }
    }
  }

  const webQueries = queries.map((q) => q.trim()).filter(Boolean)
  const trackedCalls: Array<Promise<{ source: string; results: WebSearchResult[]; error: string | null }>> = []

  // A selected-but-unconfigured source is a failure, not a silent skip -
  // otherwise synthesis could proceed on the other source's success and
  // resolve a review item that never got the DeepWiki material the user asked for.
  if (useWeb) {
    if (webConfigured) {
      for (const webQuery of webQueries) {
        if (webQuery) {
          trackedCalls.push(trackSourceCall("web", deps.webSearch(webQuery, resolvedSearchConfig, 5)))
        }
      }
    } else {
      errors.push({ source: "web", message: "Web search provider not configured" })
    }
  }

  if (useAnyTxt) {
    if (anyTxtConfigured) {
      trackedCalls.push(
        trackSourceCall(
          "anytxt",
          deps.anyTxtSearch(queries, resolvedSearchConfig.anyTxt, options.llmConfig, 15, projectPath),
        ),
      )
    } else {
      errors.push({ source: "anytxt", message: "AnyTXT local search not configured" })
    }
  }

  // DeepWiki runs concurrently with web/anytxt but its result is appended
  // separately after settle, bypassing the 20-result cap: it is a single
  // long-form answer, not a search hit competing for a slot.
  let deepWikiTracked: Promise<{ source: string; results: WebSearchResult[]; error: string | null }> | null = null
  if (useDeepWiki) {
    if (deepWikiConfigured && options.context && options.llmConfig) {
      deepWikiTracked = trackSourceCall(
        "deepwiki",
        deps.deepWikiSearch(options.context, resolvedSearchConfig.deepWiki!, options.llmConfig),
      )
    } else if (!deepWikiConfigured) {
      errors.push({ source: "deepwiki", message: "DeepWiki source not configured" })
    } else {
      errors.push({ source: "deepwiki", message: "DeepWiki missing research context or LLM config" })
    }
  }

  // MCP services run concurrently; results appended separately after settle,
  // bypassing the 20-result cap (long-form answers, like DeepWiki). Each
  // enabled service must be fully configured - an enabled-but-incomplete
  // service is a failure with its name, not a silent skip (checked inside
  // mcpServicesSearch).
  let mcpServicesTracked: Promise<{ source: string; results: WebSearchResult[]; error: string | null }> | null = null
  if (useMcpServices) {
    if (mcpConfigured && options.context) {
      mcpServicesTracked = trackSourceCall(
        "mcpServices",
        deps.mcpServicesSearch(options.context, resolvedSearchConfig.mcpServices ?? []),
      )
    } else if (!mcpConfigured) {
      errors.push({ source: "mcpServices", message: "MCP source not configured" })
    } else {
      errors.push({ source: "mcpServices", message: "MCP missing research context" })
    }
  }

  const settled = await Promise.all(trackedCalls)
  for (const item of settled) {
    if (item.error) {
      errors.push({ source: item.source, message: item.error })
    } else {
      addResults(item.results)
    }
  }

  if (deepWikiTracked) {
    const dw = await deepWikiTracked
    if (dw.error) {
      errors.push({ source: "deepwiki", message: dw.error })
    } else {
      // Bypass the 20-cap; just dedupe.
      for (const r of dw.results) {
        const key = (r.url || `${r.source}:${r.title}:${r.snippet}`).toLowerCase()
        if (!seenUrls.has(key)) {
          seenUrls.add(key)
          allResults.push(r)
        }
      }
    }
  }

  if (mcpServicesTracked) {
    const mcp = await mcpServicesTracked
    if (mcp.error) {
      errors.push({ source: "mcpServices", message: mcp.error })
    } else {
      // Bypass the 20-cap; dedupe by url (each MCP result url is unique:
      // mcp://source/<id>/<index>, so r.url is a safe dedupe key - no reverse
      // parsing needed).
      for (const r of mcp.results) {
        if (!seenUrls.has(r.url.toLowerCase())) {
          seenUrls.add(r.url.toLowerCase())
          allResults.push(r)
        }
      }
    }
  }

  return { results: allResults, errors }
}

function isActiveProjectPath(projectPath: string): boolean {
  const activePath = useWikiStore.getState().project?.path
  return Boolean(activePath && normalizePath(activePath) === normalizePath(projectPath))
}

function updateTaskIfActive(
  projectPath: string,
  taskId: string,
  patch: Parameters<ReturnType<typeof useResearchStore.getState>["updateTask"]>[1],
): boolean {
  if (!isActiveProjectPath(projectPath)) return false
  useResearchStore.getState().updateTask(taskId, patch)
  return true
}

/**
 * Process queued tasks up to maxConcurrent limit.
 */
function processQueue(
  projectPath: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
) {
  const store = useResearchStore.getState()
  const running = store.getRunningCount()
  const available = store.maxConcurrent - running

  for (let i = 0; i < available; i++) {
    const next = useResearchStore.getState().getNextQueued()
    if (!next) break
    executeResearch(projectPath, next.id, next.topic, llmConfig, searchConfig)
  }
}

async function executeResearch(
  projectPath: string,
  taskId: string,
  topic: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
) {
  const pp = normalizePath(projectPath)

  try {
    if (!isActiveProjectPath(pp)) return
    // Step 1: gather research sources — use multiple queries if available,
    // merge Web Search and local AnyTXT results, then deduplicate.
    if (!updateTaskIfActive(pp, taskId, { status: "searching" })) return

    const task = useResearchStore.getState().tasks.find((t) => t.id === taskId)
    const queries = task?.searchQueries && task.searchQueries.length > 0
      ? task.searchQueries
      : [topic]

    // Read wiki index + purpose up front: the index feeds both the DeepWiki
    // prompt assembly (as context) and the synthesis (for cross-referencing),
    // and purpose feeds the assembly. Reading once avoids a duplicate read at
    // synthesis time.
    let wikiIndex = ""
    try {
      wikiIndex = await readFile(`${pp}/wiki/index.md`)
    } catch {
      // no index yet
    }
    let purpose = ""
    try {
      purpose = await readFile(`${pp}/wiki/purpose.md`)
    } catch {
      // no purpose yet
    }

    const researchContext: ResearchContext = {
      topic,
      reviewItem: task?.researchContext?.reviewItem,
      gapContext: task?.researchContext?.gapContext,
      wikiIndex,
      purpose,
    }

    const { results: allResults, errors: sourceErrors } = await collectResearchSources(
      queries,
      searchConfig,
      pp,
      { webSearch, anyTxtSearch: anyTxtSearchSmart, deepWikiSearch, mcpServicesSearch },
      { llmConfig, context: researchContext },
    )
    if (!isActiveProjectPath(pp)) return

    const webResults = allResults
    if (!updateTaskIfActive(pp, taskId, { webResults })) return

    // Any selected source failing is fatal: abort before synthesis rather
    // than saving a partial page and resolving the review item. This matches
    // the "DeepWiki failure -> review item stays pending" contract.
    if (sourceErrors.length > 0) {
      if (!updateTaskIfActive(pp, taskId, noResearchSourcesTaskPatch(sourceErrors))) return
      if (isActiveProjectPath(pp)) onTaskFinished(pp, llmConfig, searchConfig)
      return
    }
    if (webResults.length === 0) {
      if (!updateTaskIfActive(pp, taskId, noResearchSourcesTaskPatch(sourceErrors))) return
      if (isActiveProjectPath(pp)) onTaskFinished(pp, llmConfig, searchConfig)
      return
    }

    // Step 2: LLM synthesis
    if (!updateTaskIfActive(pp, taskId, { status: "synthesizing" })) return

    const searchContext = webResults
      .map((r, i) => `[${i + 1}] **${r.title}** (${r.source})\n${r.snippet}`)
      .join("\n\n")

    const systemPrompt = [
      "You are a research assistant. Synthesize the collected research sources into a comprehensive wiki page.",
      "",
      buildLanguageDirective(topic),
      "",
      "## Cross-referencing (IMPORTANT)",
      "- The wiki already has existing pages listed in the Wiki Index below.",
      "- When your synthesis mentions an entity or concept that exists in the wiki, ALWAYS use [[wikilink]] syntax to link to it.",
      "- For example, if the wiki has an entity 'anthropic', write [[anthropic]] when mentioning it.",
      "- This is critical for connecting new research to existing knowledge in the graph.",
      "",
      "## Writing Rules",
      "- Organize into clear sections with headings",
      "- Cite sources using [N] notation",
      "- Note contradictions or gaps",
      "- Suggest additional sources worth finding",
      "- Neutral, encyclopedic tone",
      "",
      wikiIndex ? `## Existing Wiki Index (link to these pages with [[wikilink]])\n${wikiIndex}` : "",
    ].filter(Boolean).join("\n")

    let accumulated = ""

    await streamChat(
      llmConfig,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Research topic: **${topic}**\n\n## Research Sources\n\n${searchContext}\n\nSynthesize into a wiki page.` },
      ],
      {
        onToken: (token) => {
          if (!isActiveProjectPath(pp)) return
          accumulated += token
          // Update synthesis progressively so UI shows real-time text
          useResearchStore.getState().updateTask(taskId, { synthesis: accumulated })
        },
        onDone: () => {},
        onError: (err) => {
          if (!isActiveProjectPath(pp)) return
          useResearchStore.getState().updateTask(taskId, {
            status: "error",
            error: err.message,
          })
        },
      },
    )

    // Check if errored during streaming
    if (useResearchStore.getState().tasks.find((t) => t.id === taskId)?.status === "error") {
      if (isActiveProjectPath(pp)) onTaskFinished(pp, llmConfig, searchConfig)
      return
    }
    if (!isActiveProjectPath(pp)) return

    // Step 3: Save to wiki
    if (!updateTaskIfActive(pp, taskId, { status: "saving", synthesis: accumulated })) return

    const { fileName, date } = makeDeepResearchFileName(topic)
    const filePath = `${pp}/wiki/queries/${fileName}`

    const references = webResults
      .map((r, i) =>
        isMcpResult(r)
          ? `${i + 1}. ${escapeMarkdownForRef(r.title)} — ${escapeMarkdownForRef(r.source)}`
          : `${i + 1}. [${r.title}](${r.url}) — ${r.source}`,
      )
      .join("\n")

    // Strip <think>/<thinking> blocks before saving
    const cleanedSynthesis = accumulated
      .replace(/<think(?:ing)?>\s*[\s\S]*?<\/think(?:ing)?>\s*/gi, "")
      .replace(/<think(?:ing)?>\s*[\s\S]*$/gi, "") // unclosed thinking block
      .trimStart()

    const pageContent = [
      "---",
      `type: query`,
      `title: "Research: ${topic.replace(/"/g, '\\"')}"`,
      `created: ${date}`,
      `origin: deep-research`,
      `tags: [research]`,
      "---",
      "",
      `# Research: ${topic}`,
      "",
      cleanedSynthesis,
      "",
      "## References",
      "",
      references,
      "",
    ].join("\n")

    await writeFile(filePath, pageContent)
    const savedPath = `wiki/queries/${fileName}`

    // Resolve the triggering review item only after the page is durably
    // saved. Earlier code resolved at queue time, which lost the item if
    // research later failed. Refresh/embedding below are best-effort and
    // must not gate resolution.
    const reviewItemId = task?.reviewItemId
    if (reviewItemId) {
      try {
        useReviewStore.getState().resolveItem(reviewItemId, "Researched")
      } catch (err) {
        console.warn("[DeepResearch] failed to resolve review item:", err)
      }
    }

    if (!updateTaskIfActive(pp, taskId, {
      status: "done",
      savedPath,
    })) return

    try {
      await refreshProjectFileTree(pp, { bumpDataVersion: true })
    } catch {
      // ignore
    }

    // The query page no longer goes through source ingest, so index it here
    // directly. This keeps freshly generated research available to hybrid
    // search without recreating the review-amplifying ingest loop.
    const embeddingConfig = useWikiStore.getState().embeddingConfig
    if (embeddingConfig.enabled && embeddingConfig.model) {
      try {
        const { embedPage } = await import("@/lib/embedding")
        await embedPage(pp, fileName.replace(/\.md$/i, ""), `Research: ${topic}`, pageContent, embeddingConfig)
      } catch (err) {
        console.warn("[DeepResearch] failed to index generated query page:", err)
      }
    }

    // A research result is already a generated wiki page. Feeding it back
    // through source ingest creates a second summary page and recursively
    // produces low-value review suggestions from its own gaps/references.
    // Keep it directly searchable as the query page instead.
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    updateTaskIfActive(pp, taskId, {
      status: "error",
      error: message,
    })
  }

  if (isActiveProjectPath(pp)) onTaskFinished(pp, llmConfig, searchConfig)
}

function onTaskFinished(
  projectPath: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
) {
  // Process next queued task
  setTimeout(() => processQueue(projectPath, llmConfig, searchConfig), 100)
}
