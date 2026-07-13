import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import {
  DEFAULT_ASSEMBLY_INSTRUCTION,
  assembleDeepWikiPrompt,
  parseAssemblySections,
  templateAssembly,
  type ResearchContext,
} from "./deepwiki-assembly"

const streamChatMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/llm-client", () => ({
  streamChat: streamChatMock,
}))

const llmConfig: LlmConfig = {
  provider: "custom",
  apiKey: "test",
  model: "test-model",
  ollamaUrl: "",
  customEndpoint: "http://localhost/v1/chat/completions",
  maxContextSize: 128000,
}

const context: ResearchContext = {
  topic: "queryOfferExtendInfo 的 OTTFlag 字段",
  reviewItem: {
    title: "OTTFlag 字段前端无法识别",
    description: "CLP 调用 queryOfferExtendInfo 后 JSON 里没有 OTTFlag",
    type: "suggestion",
    searchQueries: ["queryOfferExtendInfo OTTFlag"],
  },
  wikiIndex: "# Wiki Index",
  purpose: "研究 BSS 接口字段问题",
}

function mockStreamOutput(output: string) {
  streamChatMock.mockImplementationOnce(async (_cfg: unknown, _msgs: unknown, cb: { onToken: (t: string) => void; onDone: () => void }) => {
    cb.onToken(output)
    cb.onDone()
  })
}

describe("parseAssemblySections", () => {
  it("parses a well-formed 4-section output", () => {
    const out = [
      "[上下文]\n任务单 11941506,产品 CPC",
      "[我需要什么]\nOTTFlag 字段的 Java 定义",
      "[来判断什么]\n序列化后前端看到的 JSON key",
      "[以便让我明确]\n是否需要改字段名",
    ].join("\n\n")
    const sections = parseAssemblySections(out)
    expect(sections).not.toBeNull()
    expect(sections!["[上下文]"]).toContain("任务单 11941506")
    expect(sections!["[以便让我明确]"]).toBe("是否需要改字段名")
  })

  it("returns null when a section is missing", () => {
    const out = "[上下文]\nctx\n[我需要什么]\nneed"
    expect(parseAssemblySections(out)).toBeNull()
  })

  it("returns null for empty output", () => {
    expect(parseAssemblySections("")).toBeNull()
    expect(parseAssemblySections("   ")).toBeNull()
  })

  it("strips markdown code fences before parsing", () => {
    const out = "```json\n[上下文]\nctx\n[我需要什么]\nneed\n[来判断什么]\njudge\n[以便让我明确]\ngoal\n```"
    const sections = parseAssemblySections(out)
    expect(sections).not.toBeNull()
    expect(sections!["[上下文]"]).toBe("ctx")
  })
})

describe("templateAssembly", () => {
  it("builds all 4 sections from context fields", () => {
    const prompt = templateAssembly(context)
    expect(prompt).toContain("[上下文]")
    expect(prompt).toContain("[我需要什么]")
    expect(prompt).toContain("[来判断什么]")
    expect(prompt).toContain("[以便让我明确]")
    expect(prompt).toContain("OTTFlag 字段前端无法识别")
    expect(prompt).toContain("queryOfferExtendInfo 的 OTTFlag 字段")
  })

  it("works without a reviewItem (manual research panel path)", () => {
    const prompt = templateAssembly({ topic: "alpha", wikiIndex: "", purpose: "" })
    expect(prompt).toContain("[上下文]")
    expect(prompt).toContain("alpha")
  })
})

describe("assembleDeepWikiPrompt", () => {
  beforeEach(() => {
    streamChatMock.mockReset()
  })

  it("returns the LLM-assembled prompt when output is well-formed", async () => {
    mockStreamOutput(
      "[上下文]\nctx\n[我需要什么]\nneed\n[来判断什么]\njudge\n[以便让我明确]\ngoal",
    )
    const { prompt, fellBack } = await assembleDeepWikiPrompt(llmConfig, context, "")
    expect(fellBack).toBe(false)
    expect(prompt).toContain("[上下文]\nctx")
    expect(prompt).toContain("[以便让我明确]\ngoal")
  })

  it("uses the default instruction when assemblyInstruction is empty", async () => {
    mockStreamOutput("[上下文]\nc\n[我需要什么]\nn\n[来判断什么]\nj\n[以便让我明确]\ng")
    await assembleDeepWikiPrompt(llmConfig, context, "")
    const userMsg = streamChatMock.mock.calls[0][1][0].content
    expect(userMsg).toContain(DEFAULT_ASSEMBLY_INSTRUCTION.slice(0, 30))
  })

  it("uses the custom instruction when provided", async () => {
    mockStreamOutput("[上下文]\nc\n[我需要什么]\nn\n[来判断什么]\nj\n[以便让我明确]\ng")
    await assembleDeepWikiPrompt(llmConfig, context, "MY CUSTOM INSTRUCTION")
    const userMsg = streamChatMock.mock.calls[0][1][0].content
    expect(userMsg).toContain("MY CUSTOM INSTRUCTION")
  })

  it("falls back to template when LLM output is unparseable", async () => {
    mockStreamOutput("sorry I cannot help with that")
    const { prompt, fellBack } = await assembleDeepWikiPrompt(llmConfig, context, "")
    expect(fellBack).toBe(true)
    expect(prompt).toContain("[上下文]")
    expect(prompt).toContain("OTTFlag 字段前端无法识别")
  })

  it("falls back to template when streamChat throws", async () => {
    streamChatMock.mockRejectedValueOnce(new Error("LLM down"))
    const { prompt, fellBack } = await assembleDeepWikiPrompt(llmConfig, context, "")
    expect(fellBack).toBe(true)
    expect(prompt).toContain("[上下文]")
  })

  it("falls back to template when streamChat reports onError", async () => {
    streamChatMock.mockImplementationOnce(async (_cfg: unknown, _msgs: unknown, cb: { onError: (e: Error) => void }) => {
      cb.onError(new Error("stream error"))
    })
    const { fellBack } = await assembleDeepWikiPrompt(llmConfig, context, "")
    expect(fellBack).toBe(true)
  })
})
