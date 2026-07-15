import { describe, it, expect } from "vitest"
import {
  cyrb53,
  normalizeMcpServiceConfigs,
  hasConfiguredMcpServices,
  isMcpResult,
  escapeMarkdownForRef,
  mcpServicesSearch,
} from "./mcp-source"
import type { McpServiceConfig } from "@/stores/wiki-store"

describe("cyrb53", () => {
  it("matches locked test vectors (seed=0, base36 slice 0,10)", () => {
    expect(cyrb53("").toString(36).slice(0, 10)).toBe("wvjl67o803")
    expect(cyrb53("mcp-a").toString(36).slice(0, 10)).toBe("2f8hkzbdjm")
    expect(cyrb53("端点|tool|name").toString(36).slice(0, 10)).toBe("19suoqjzdz")
  })
})

describe("normalizeMcpServiceConfigs", () => {
  it("keeps invalid (enabled-but-incomplete) entries instead of dropping them", () => {
    const out = normalizeMcpServiceConfigs([
      { id: "a", name: "good", enabled: true, endpoint: "https://x", toolName: "t", argumentTemplate: "{}" },
      { id: "b", name: "bad", enabled: true, endpoint: "", toolName: "", argumentTemplate: "{}" },
    ])
    expect(out).toHaveLength(2)
    expect(out[1].id).toBe("b")
    expect(out[1].endpoint).toBe("")
  })

  it("fills defaults (timeoutSecs, maxSnippetChars, authHeaders)", () => {
    const out = normalizeMcpServiceConfigs([
      { id: "a", name: "n", enabled: true, endpoint: "https://x", toolName: "t", argumentTemplate: "{}" },
    ])
    expect(out[0].timeoutSecs).toBe(120)
    expect(out[0].maxSnippetChars).toBe(4000)
    expect(out[0].authHeaders).toEqual({})
    expect(out[0].enabled).toBe(true)
  })

  it("dedupes by id, keeping first; collision gets -2 suffix", () => {
    const out = normalizeMcpServiceConfigs([
      { id: "dup", name: "first", enabled: true, endpoint: "https://1", toolName: "t", argumentTemplate: "{}" },
      { id: "dup", name: "second", enabled: true, endpoint: "https://2", toolName: "t", argumentTemplate: "{}" },
    ])
    expect(out).toHaveLength(2)
    expect(out[0].name).toBe("first")
    expect(out[1].id).toBe("dup-2")
  })

  it("derives a deterministic id for missing-id entries (stable across calls)", () => {
    const svc = (): McpServiceConfig[] => [
      { id: "", name: "n", enabled: true, endpoint: "https://x", toolName: "t", argumentTemplate: "{}" },
    ]
    const a = normalizeMcpServiceConfigs(svc())
    const b = normalizeMcpServiceConfigs(svc())
    expect(a[0].id).toBe(b[0].id)
    expect(a[0].id).not.toBe("")
  })

  it("returns [] for undefined/non-array", () => {
    expect(normalizeMcpServiceConfigs(undefined)).toEqual([])
  })
})

describe("hasConfiguredMcpServices", () => {
  it("true when at least one enabled service has endpoint + toolName", () => {
    expect(
      hasConfiguredMcpServices([
        { id: "a", name: "n", enabled: true, endpoint: "https://x", toolName: "t", argumentTemplate: "{}" },
      ]),
    ).toBe(true)
  })

  it("false when all enabled services are incomplete", () => {
    expect(
      hasConfiguredMcpServices([
        { id: "a", name: "n", enabled: true, endpoint: "", toolName: "", argumentTemplate: "{}" },
      ]),
    ).toBe(false)
  })

  it("false for empty/undefined", () => {
    expect(hasConfiguredMcpServices([])).toBe(false)
    expect(hasConfiguredMcpServices(undefined)).toBe(false)
  })
})

describe("isMcpResult", () => {
  it("matches source starting with 'MCP: '", () => {
    expect(isMcpResult({ source: "MCP: wiki-svc" })).toBe(true)
    expect(isMcpResult({ source: "DeepWiki" })).toBe(false)
    expect(isMcpResult({ source: "MCP" })).toBe(false) // no colon-space
  })
})

describe("escapeMarkdownForRef", () => {
  it("escapes link syntax so [title](url) is not a link", () => {
    const out = escapeMarkdownForRef("[t](http://x)")
    expect(out).toContain("\\[")
    expect(out).toContain("\\]")
    expect(out).toContain("\\(")
    expect(out).toContain("\\)")
  })

  it("breaks bare mcp:// scheme so autolink renderers do not link it", () => {
    const out = escapeMarkdownForRef("see mcp://source/a/0")
    expect(out).not.toContain("mcp://")
    expect(out).toContain("​://")
  })

  it("breaks http(s):// and ftp:// schemes", () => {
    expect(escapeMarkdownForRef("http://x")).toContain("​://")
    expect(escapeMarkdownForRef("https://x")).toContain("​://")
    expect(escapeMarkdownForRef("ftp://x")).toContain("​://")
  })
})


describe("mcpServicesSearch", () => {
  it("throws with service name when an enabled service is incomplete (no silent skip)", async () => {
    await expect(
      mcpServicesSearch(
        { topic: "alpha", wikiIndex: "", purpose: "" } as never,
        [{ id: "a", name: "My Service", enabled: true, endpoint: "", toolName: "", argumentTemplate: "{}" }],
      ),
    ).rejects.toThrow(/My Service/)
  })
})
