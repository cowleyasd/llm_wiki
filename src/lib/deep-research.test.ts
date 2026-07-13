import { describe, expect, it, vi } from "vitest"
import {
  collectResearchSources,
  makeDeepResearchFileName,
  noResearchSourcesTaskPatch,
  type ResearchSourceError,
} from "./deep-research"
import type { SearchApiConfig } from "@/stores/wiki-store"
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

const deepWikiResult: WebSearchResult = {
  title: "DeepWiki: alpha",
  url: "https://example.com/space/test-space",
  snippet: "deepwiki long-form answer",
  source: "DeepWiki",
}

function config(patch: Partial<SearchApiConfig>): SearchApiConfig {
  return {
    provider: "none",
    apiKey: "",
    ...patch,
  }
}

/** Build the deps with a default no-op DeepWiki mock so existing web/anytxt
 * tests don't each have to repeat it. */
function makeDeps(
  web: ReturnType<typeof vi.fn>,
  anytxt: ReturnType<typeof vi.fn>,
  deepwiki: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue([]),
) {
  return { webSearch: web as never, anyTxtSearch: anytxt as never, deepWikiSearch: deepwiki as never }
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

  it("calls DeepWiki and appends its result past the 20-result cap", async () => {
    // Web returns enough to hit the cap; DeepWiki must still appear.
    const webSearch = vi.fn().mockResolvedValue(
      Array.from({ length: 25 }, (_, index) => ({
        title: `Result ${index}`,
        url: `https://example.com/${index}`,
        snippet: "snippet",
        source: "example.com",
      })),
    )
    const anyTxtSearch = vi.fn().mockResolvedValue([])
    const deepWikiSearch = vi.fn().mockResolvedValue([deepWikiResult])

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSources: ["web", "deepwiki"],
        provider: "tavily",
        apiKey: "tvly",
        deepWiki: { enabled: true, baseUrl: "https://example.com/api/open", spaceId: "test-space", model: "test-model", branch: "main", timeoutSecs: 600, maxSnippetChars: 4000 },
      }),
      "/project",
      makeDeps(webSearch, anyTxtSearch, deepWikiSearch),
      { llmConfig: { provider: "openai", apiKey: "k", model: "m", endpoint: "" } as never, context: { topic: "alpha", wikiIndex: "", purpose: "" } },
    )

    expect(deepWikiSearch).toHaveBeenCalledTimes(1)
    expect(out.results).toHaveLength(21) // 20 capped web + 1 deepwiki bypass
    expect(out.results[20]).toEqual(deepWikiResult)
  })

  it("records a structured error when DeepWiki is selected but unconfigured", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([localResult])
    const deepWikiSearch = vi.fn().mockResolvedValue([deepWikiResult])

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSources: ["web", "deepwiki"],
        provider: "tavily",
        apiKey: "tvly",
        deepWiki: { enabled: false, baseUrl: "" }, // not configured
      }),
      "/project",
      makeDeps(webSearch, anyTxtSearch, deepWikiSearch),
      { llmConfig: { provider: "openai", apiKey: "k", model: "m", endpoint: "" } as never, context: { topic: "alpha", wikiIndex: "", purpose: "" } },
    )

    expect(deepWikiSearch).not.toHaveBeenCalled()
    expect(out.errors).toEqual([
      { source: "deepwiki", message: "DeepWiki source not configured" },
    ])
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
