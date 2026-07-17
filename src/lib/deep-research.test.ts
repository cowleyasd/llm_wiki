import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import {
  collectResearchSources,
  makeDeepResearchFileName,
  noResearchSourcesTaskPatch,
  queueResearch,
  type ResearchSourceError,
} from "./deep-research"
import type { SearchApiConfig, LlmConfig } from "@/stores/wiki-store"
import type { WebSearchResult } from "./web-search"

const webResult: WebSearchResult = {
  title: "Web",
  url: "https://example.com/web",
  snippet: "web snippet",
  source: "example.com",
}

const localResult: WebSearchResult = {
  title: "Local",
  url: "file:///C:/docs/local.md",
  snippet: "local snippet",
  source: "AnyTXT",
}

const mcpResult: WebSearchResult = {
  title: "wiki-svc",
  url: "mcp://source/svc-a/0",
  snippet: "mcp long-form answer",
  source: "MCP: wiki-svc",
}

function config(patch: Partial<SearchApiConfig>): SearchApiConfig {
  return {
    provider: "none",
    apiKey: "",
    ...patch,
  }
}

/**
 * Build the deps for collectResearchSources. DeepWiki is no longer a
 * synthesis source — DR triggers it as a fire-and-forget ingest channel via
 * triggerDeepWikiQuery (see executeResearch), so there is no deepWikiSearch
 * entry here anymore.
 */
function makeDeps(
  web: ReturnType<typeof vi.fn>,
  anytxt: ReturnType<typeof vi.fn>,
  mcp: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue([]),
) {
  return { webSearch: web as never, anyTxtSearch: anytxt as never, mcpServicesSearch: mcp as never }
}

describe("makeDeepResearchFileName", () => {
  it("keeps Unicode topics and includes time to avoid same-day overwrite", () => {
    const first = makeDeepResearchFileName(
      "反硝化除磷",
      new Date("2026-06-06T10:00:00.000Z"),
    )
    const second = makeDeepResearchFileName(
      "反硝化除磷",
      new Date("2026-06-06T10:00:01.000Z"),
    )

    expect(first.fileName).toBe("research-反硝化除磷-2026-06-06-100000.md")
    expect(second.fileName).toBe("research-反硝化除磷-2026-06-06-100001.md")
    expect(first.fileName).not.toBe(second.fileName)
  })

  it("uses the local calendar date for frontmatter metadata", () => {
    const localMorning = new Date(2026, 5, 6, 1, 30, 0)

    expect(makeDeepResearchFileName("政策版本差异", localMorning).date).toBe("2026-06-06")
  })
})

describe("noResearchSourcesTaskPatch", () => {
  it("marks source failures as an error instead of completed", () => {
    const errors: ResearchSourceError[] = [
      { source: "web", message: "Firecrawl blocked this IP" },
      { source: "anytxt", message: "AnyTXT offline" },
    ]
    expect(noResearchSourcesTaskPatch(errors)).toEqual({
      status: "error",
      synthesis: "",
      error: "[web] Firecrawl blocked this IP\n[anytxt] AnyTXT offline",
    })
  })

  it("marks an empty successful search as done", () => {
    expect(noResearchSourcesTaskPatch([])).toEqual({
      status: "done",
      synthesis: "No research sources found.",
      error: null,
    })
  })
})

describe("collectResearchSources", () => {
  it("uses only Web Search when source mode is web", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([localResult])

    const out = await collectResearchSources(
      ["alpha"],
      config({ deepResearchSources: ["web"], provider: "tavily", apiKey: "tvly" }),
      "/project",
      makeDeps(webSearch, anyTxtSearch),
    )

    expect(webSearch).toHaveBeenCalledTimes(1)
    expect(anyTxtSearch).not.toHaveBeenCalled()
    expect(out.results).toEqual([webResult])
  })

  it("uses only AnyTXT when source mode is anytxt", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([localResult])

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSources: ["anytxt"],
        provider: "tavily",
        apiKey: "tvly",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      }),
      "/project",
      makeDeps(webSearch, anyTxtSearch),
    )

    expect(webSearch).not.toHaveBeenCalled()
    expect(anyTxtSearch).toHaveBeenCalledTimes(1)
    expect(anyTxtSearch.mock.calls[0][0]).toEqual(["alpha"])
    expect(out.results).toEqual([localResult])
  })

  it("uses both sources concurrently and deduplicates by URL", async () => {
    const duplicate = { ...localResult, url: webResult.url }
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([duplicate, localResult])

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSources: ["web", "anytxt"],
        provider: "tavily",
        apiKey: "tvly",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      }),
      "/project",
      makeDeps(webSearch, anyTxtSearch),
    )

    expect(webSearch).toHaveBeenCalledTimes(1)
    expect(anyTxtSearch).toHaveBeenCalledTimes(1)
    expect(out.results).toEqual([webResult, localResult])
  })

  it("keeps web results when AnyTXT fails and exposes the structured source error", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockRejectedValue(new Error("Check that ATGUI.exe is running"))

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSources: ["web", "anytxt"],
        provider: "tavily",
        apiKey: "tvly",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      }),
      "/project",
      makeDeps(webSearch, anyTxtSearch),
    )

    expect(out.results).toEqual([webResult])
    expect(out.errors).toEqual([
      { source: "anytxt", message: "Check that ATGUI.exe is running" },
    ])
  })

  it("treats a selected-but-unconfigured source as a failure, not a silent skip", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([localResult])

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSources: ["web", "anytxt"],
        provider: "none", // web selected but not configured
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      }),
      "/project",
      makeDeps(webSearch, anyTxtSearch),
    )

    expect(webSearch).not.toHaveBeenCalled()
    expect(anyTxtSearch).toHaveBeenCalledTimes(1)
    expect(out.results).toEqual([localResult])
    expect(out.errors).toEqual([
      { source: "web", message: "Web search provider not configured" },
    ])
  })

  it("does NOT call DeepWiki when deepwiki is selected — it is a fire-and-forget ingest channel, not a synthesis source", async () => {
    // DeepWiki is triggered by executeResearch via triggerDeepWikiQuery; it no
    // longer flows through collectResearchSources. Even with deepwiki in the
    // sources list, collectResearchSources returns only web/anytxt/mcp results
    // and records no "deepwiki" error.
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([localResult])
    const mcpServicesSearch = vi.fn().mockResolvedValue([mcpResult])

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSources: ["web", "deepwiki"],
        provider: "tavily",
        apiKey: "tvly",
        deepWiki: { enabled: true, baseUrl: "https://example.com/api/open", spaceId: "test-space", model: "test-model", branch: "main", timeoutSecs: 600, maxSnippetChars: 4000 },
      }),
      "/project",
      makeDeps(webSearch, anyTxtSearch, mcpServicesSearch),
      { llmConfig: { provider: "openai", apiKey: "k", model: "m", endpoint: "" } as never, context: { topic: "alpha", wikiIndex: "", purpose: "" } },
    )

    expect(webSearch).toHaveBeenCalledTimes(1)
    expect(mcpServicesSearch).not.toHaveBeenCalled()
    expect(out.results).toEqual([webResult])
    expect(out.errors).toEqual([])
  })

  it("calls MCP services and appends results past the 20-cap, deduping by url", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([])
    const mcpServicesSearch = vi.fn().mockResolvedValue([mcpResult])

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSources: ["web", "mcpServices"],
        provider: "tavily",
        apiKey: "tvly",
        mcpServices: [{ id: "svc-a", name: "wiki-svc", enabled: true, endpoint: "https://x", toolName: "t", argumentTemplate: "{}" }],
      }),
      "/project",
      makeDeps(webSearch, anyTxtSearch, mcpServicesSearch),
      { llmConfig: { provider: "openai", apiKey: "k", model: "m", endpoint: "" } as never, context: { topic: "alpha", wikiIndex: "", purpose: "" } },
    )

    expect(mcpServicesSearch).toHaveBeenCalledTimes(1)
    expect(out.results).toEqual([webResult, mcpResult])
  })

  it("records a structured error when MCP is selected but not configured", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([])
    const mcpServicesSearch = vi.fn().mockResolvedValue([])

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSources: ["web", "mcpServices"],
        provider: "tavily",
        apiKey: "tvly",
        mcpServices: [],
      }),
      "/project",
      makeDeps(webSearch, anyTxtSearch, mcpServicesSearch),
      { llmConfig: { provider: "openai", apiKey: "k", model: "m", endpoint: "" } as never, context: { topic: "alpha", wikiIndex: "", purpose: "" } },
    )

    expect(mcpServicesSearch).not.toHaveBeenCalled()
    expect(out.errors).toContainEqual({ source: "mcpServices", message: "MCP source not configured" })
  })

  it("records a structured error (abort) when an MCP service call rejects", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([])
    const mcpServicesSearch = vi.fn().mockRejectedValue(
      new Error('MCP service "wiki-svc" is enabled but not fully configured (missing endpoint or toolName)'),
    )

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSources: ["web", "mcpServices"],
        provider: "tavily",
        apiKey: "tvly",
        mcpServices: [{ id: "svc-a", name: "wiki-svc", enabled: true, endpoint: "https://x", toolName: "t", argumentTemplate: "{}" }],
      }),
      "/project",
      makeDeps(webSearch, anyTxtSearch, mcpServicesSearch),
      { llmConfig: { provider: "openai", apiKey: "k", model: "m", endpoint: "" } as never, context: { topic: "alpha", wikiIndex: "", purpose: "" } },
    )

    expect(out.errors).toContainEqual({
      source: "mcpServices",
      message: 'MCP service "wiki-svc" is enabled but not fully configured (missing endpoint or toolName)',
    })
  })

  it("returns no results for blank queries", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([localResult])

    const out = await collectResearchSources(
      [" ", ""],
      config({ deepResearchSources: ["web", "anytxt"], provider: "tavily", apiKey: "tvly" }),
      "/project",
      makeDeps(webSearch, anyTxtSearch),
    )

    expect(webSearch).not.toHaveBeenCalled()
    expect(anyTxtSearch).not.toHaveBeenCalled()
    expect(out.results).toEqual([])
  })

  it("logs once when research sources are capped", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
    const webSearch = vi.fn().mockResolvedValue(
      Array.from({ length: 25 }, (_, index) => ({
        title: `Result ${index}`,
        url: `https://example.com/${index}`,
        snippet: "snippet",
        source: "example.com",
      })),
    )
    const anyTxtSearch = vi.fn().mockResolvedValue([])

    const out = await collectResearchSources(
      ["alpha", "beta"],
      config({ deepResearchSources: ["web"], provider: "tavily", apiKey: "tvly" }),
      "/project",
      makeDeps(webSearch, anyTxtSearch),
    )

    expect(out.results).toHaveLength(20)
    expect(infoSpy).toHaveBeenCalledTimes(1)
    infoSpy.mockRestore()
  })

  it("migrates the legacy scalar deepResearchSource to the list model", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([localResult])

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSource: "both", // legacy scalar
        provider: "tavily",
        apiKey: "tvly",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      }),
      "/project",
      makeDeps(webSearch, anyTxtSearch),
    )

    expect(webSearch).toHaveBeenCalledTimes(1)
    expect(anyTxtSearch).toHaveBeenCalledTimes(1)
    expect(out.results).toEqual([webResult, localResult])
  })
})

// ---------------------------------------------------------------------------
// executeResearch: DeepWiki fire-and-forget trigger + completion semantics.
//
// DeepWiki is no longer a synthesis source. When only DeepWiki is selected,
// executeResearch calls triggerDeepWikiQuery (which writes a prompt_ready
// record before returning) and resolves the review item WITHOUT producing a
// query page. When DeepWiki is mixed with web but web returns nothing, the
// existing empty-results failure still fires (DeepWiki runs async regardless).
//
// These tests drive executeResearch indirectly through queueResearch (the only
// exported entry point) using fake timers for its setTimeout(..., 50) pump.
// ---------------------------------------------------------------------------

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn().mockRejectedValue(new Error("not found")),
  writeFile: vi.fn().mockResolvedValue(undefined),
  writeFileAtomic: vi.fn().mockResolvedValue(undefined),
  createDirectory: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/lib/llm-client", () => ({ streamChat: vi.fn() }))
vi.mock("@/lib/project-file-tree-refresh", () => ({
  refreshProjectFileTree: vi.fn().mockResolvedValue(undefined),
}))
// Mock web-search so collectResearchSources's default-deps webSearch returns
// controllable results (executeResearch builds deps internally — no injection).
vi.mock("@/lib/web-search", async () => {
  const actual = await vi.importActual<typeof import("./web-search")>("@/lib/web-search")
  return {
    ...actual,
    webSearch: vi.fn().mockResolvedValue([]),
  }
})
// Mock the DeepWiki channel so executeResearch's dynamic import resolves to a
// tracked spy. The real module writes a record + kicks off an async worker;
// here we only need the trigger to "succeed" (return a record id).
vi.mock("@/lib/deepwiki-channel", () => ({
  triggerDeepWikiQuery: vi.fn().mockResolvedValue("dw-test-record"),
}))

const resolveItemSpy = vi.fn()

describe("executeResearch — DeepWiki fire-and-forget + completion", () => {
  const projectPath = "/project"
  const llmConfig = { provider: "openai", apiKey: "k", model: "m", endpoint: "" } as unknown as LlmConfig
  const deepWikiConfigured = {
    enabled: true,
    baseUrl: "https://example.com/api/open",
    token: "tok",
    spaceId: "test-space",
    model: "test-model",
    branch: "main",
    timeoutSecs: 120,
    maxSnippetChars: 4000,
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveItemSpy.mockClear()

    const { useWikiStore } = await import("@/stores/wiki-store")
    useWikiStore.getState().setProject({
      id: "proj-1",
      name: "Test",
      path: projectPath,
      rawSourceDir: "raw",
      config: {},
    } as never)
    // Embedding disabled so executeResearch skips the embedPage import.
    useWikiStore.getState().setEmbeddingConfig({ enabled: false, model: "", endpoint: "", apiKey: "", dimension: 0, provider: "none" } as never)

    const { useResearchStore } = await import("@/stores/research-store")
    useResearchStore.setState({ tasks: [], maxConcurrent: 3, panelOpen: false })

    const { useReviewStore } = await import("@/stores/review-store")
    // Swap in a getState whose resolveItem is our spy; the rest of the store
    // is irrelevant to executeResearch's resolve path.
    ;(useReviewStore as unknown as { getState: () => unknown }).getState = () => ({ resolveItem: resolveItemSpy })

    // Default: web returns nothing. Individual tests override.
    const { webSearch } = await import("./web-search")
    ;(webSearch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Pump the queueResearch setTimeout + the subsequent async microtasks. */
  async function flush() {
    await vi.advanceTimersByTimeAsync(60)
    // Let dynamic import + triggerDeepWikiQuery + collectResearchSources settle.
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(5)
  }

  it("only-deepwiki: triggers channel, resolves review item, writes NO query page", async () => {
    const { useResearchStore } = await import("@/stores/research-store")
    const { triggerDeepWikiQuery } = await import("@/lib/deepwiki-channel")
    const { writeFile } = await import("@/commands/fs")

    const searchConfig = config({
      deepResearchSources: ["deepwiki"],
      deepWiki: deepWikiConfigured,
    })

    const taskId = queueResearch(projectPath, "alpha", llmConfig, searchConfig, ["alpha"], {
      reviewItemId: "rev-1",
    })

    await flush()

    expect(triggerDeepWikiQuery).toHaveBeenCalledTimes(1)
    // DR completion did NOT depend on the DeepWiki worker; it resolved the
    // review item as soon as the prompt_ready record was durable.
    expect(resolveItemSpy).toHaveBeenCalledWith("rev-1", "Researched")
    // No query page was produced (synthesis was skipped entirely).
    expect(writeFile).not.toHaveBeenCalled()

    const task = useResearchStore.getState().tasks.find((t) => t.id === taskId)
    expect(task?.status).toBe("done")
    expect(task?.savedPath).toBeNull()
  })

  it("web+deepwiki with web empty: fails (no resolve), DeepWiki still triggered", async () => {
    const { triggerDeepWikiQuery } = await import("@/lib/deepwiki-channel")
    const { writeFile } = await import("@/commands/fs")

    const searchConfig = config({
      deepResearchSources: ["web", "deepwiki"],
      provider: "tavily",
      apiKey: "tvly",
      deepWiki: deepWikiConfigured,
    })

    queueResearch(projectPath, "alpha", llmConfig, searchConfig, ["alpha"], {
      reviewItemId: "rev-2",
    })

    await flush()

    // DeepWiki channel was still fired (async, fire-and-forget).
    expect(triggerDeepWikiQuery).toHaveBeenCalledTimes(1)
    // But DR reported the web-empty failure: review item NOT resolved.
    expect(resolveItemSpy).not.toHaveBeenCalled()
    // No query page.
    expect(writeFile).not.toHaveBeenCalled()
  })
})
