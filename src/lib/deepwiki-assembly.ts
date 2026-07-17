import { streamChat } from "./llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import { buildLanguageDirective } from "./output-language"

/**
 * Immutable snapshot of a review item carried into the research pipeline.
 * Deliberately not the full {@link ReviewItem} - we only forward the fields
 * the assembly needs, avoiding stale-snapshot drift after refresh/resolve.
 */
export interface ReviewItemSnapshot {
  title: string
  description: string
  type: string
  searchQueries?: string[]
}

export interface GapContext {
  title: string
  description: string
  type: string
}

/**
 * Context fed to the DeepWiki prompt-assembly LLM. Only `topic` + wiki index
 * + purpose are guaranteed; the other fields are present when the research
 * was triggered from a review item or a graph gap.
 */
export interface ResearchContext {
  topic: string
  reviewItem?: ReviewItemSnapshot
  gapContext?: GapContext
  wikiIndex: string
  purpose: string
}

// Truncate large context blocks so the assembly prompt stays bounded.
const MAX_BLOCK_CHARS = 2000

function truncate(text: string, limit: number = MAX_BLOCK_CHARS): string {
  const clean = text.trim()
  if (clean.length <= limit) return clean
  return `${clean.slice(0, limit)}…`
}

/**
 * Default assembly instruction used when the user has not customized one in
 * settings. Produces the 4-layer DeepWiki prompt structure that the
 * deepwiki SKILL contract expects (上下文 / 我需要什么 / 来判断什么 / 以便让我明确).
 */
export const DEFAULT_ASSEMBLY_INSTRUCTION = [
  "你是一个研究助手。根据下方研究上下文，组装一个发给 DeepWiki 知识库的查询 prompt。",
  "DeepWiki 是一个基于代码库的知识库问答 agent，调用方负责把问题和目标说清楚，agent 负责决定搜索策略。",
  "",
  "输出严格遵循 4 段结构，每段以方括号标签开头，段内可多行。不要输出任何其它内容（无解释、无 markdown 代码围栏、无前后缀）：",
  "[上下文]",
  "<已知信息：任务背景、产品/仓库、已尝试的路径。已知的定位锚点（仓库/模块路径、表名、API 端点）必须写全>",
  "[我需要什么]",
  "<要查找的信息/数据/事实>",
  "[来判断什么]",
  "<基于信息要做的分析/判断>",
  "[以便让我明确]",
  "<最终要明确的结论/决策/行动方向>",
].join("\n")

const SECTION_LABELS = ["[上下文]", "[我需要什么]", "[来判断什么]", "[以便让我明确]"] as const

/**
 * Parse the 4 labelled sections out of the LLM output. Returns null if any
 * section is missing or the output is empty/garbage.
 */
export function parseAssemblySections(output: string): Record<string, string> | null {
  const cleaned = output
    .replace(/```(?:[a-zA-Z]*)/g, "")
    .replace(/```/g, "")
    .trim()
  if (!cleaned) return null

  const sections: Record<string, string> = {}
  for (let i = 0; i < SECTION_LABELS.length; i++) {
    const label = SECTION_LABELS[i]
    const startIdx = cleaned.indexOf(label)
    if (startIdx === -1) return null
    const contentStart = startIdx + label.length
    const nextLabel = SECTION_LABELS[i + 1]
    const endIdx = nextLabel ? cleaned.indexOf(nextLabel, contentStart) : -1
    const content = (endIdx === -1 ? cleaned.slice(contentStart) : cleaned.slice(contentStart, endIdx)).trim()
    if (!content) return null
    sections[label] = content
  }
  return sections
}

/**
 * Template fallback when the LLM assembly fails or produces unparseable
 * output. Builds the 4 sections directly from the context fields so DeepWiki
 * still gets a usable prompt.
 */
export function templateAssembly(context: ResearchContext): string {
  const ctxParts: string[] = []
  if (context.purpose) ctxParts.push(`Wiki 目的：\n${truncate(context.purpose)}`)
  if (context.wikiIndex) ctxParts.push(`已有 Wiki 概况：\n${truncate(context.wikiIndex)}`)
  if (context.reviewItem) {
    ctxParts.push(`待审阅知识点：${context.reviewItem.title}（${context.reviewItem.type}）`)
    if (context.reviewItem.description) ctxParts.push(truncate(context.reviewItem.description))
  } else if (context.gapContext) {
    ctxParts.push(`知识缺口：${context.gapContext.title}（${context.gapContext.type}）`)
    if (context.gapContext.description) ctxParts.push(truncate(context.gapContext.description))
  }

  const need = context.reviewItem?.description || context.gapContext?.description || context.topic
  const judge = context.reviewItem?.searchQueries?.[0] || context.topic
  const goal = context.topic

  return [
    "[上下文]",
    ctxParts.join("\n\n") || context.topic,
    "",
    "[我需要什么]",
    truncate(need),
    "",
    "[来判断什么]",
    truncate(judge),
    "",
    "[以便让我明确]",
    truncate(goal),
  ].join("\n")
}

/**
 * Use an LLM to turn the research context into a 4-layer DeepWiki prompt.
 *
 * Assembly failure is NON-fatal: if the LLM throws, reports an error,
 * returns empty, or produces unparseable output, we fall back to
 * {@link templateAssembly}. A real DeepWiki HTTP/timeout failure is fatal
 * and handled by the caller ({@link deepWikiSearch}).
 */
export async function assembleDeepWikiPrompt(
  llmConfig: LlmConfig,
  context: ResearchContext,
  assemblyInstruction: string,
  signal?: AbortSignal,
): Promise<{ prompt: string; fellBack: boolean }> {
  const instruction = assemblyInstruction.trim() || DEFAULT_ASSEMBLY_INSTRUCTION

  const userMessage = [
    instruction,
    "",
    buildLanguageDirective(`${context.topic} ${context.purpose} ${context.wikiIndex}`),
    "",
    "## 研究上下文",
    `主题：${context.topic}`,
    context.purpose ? `\n### Wiki 目的\n${truncate(context.purpose)}` : "",
    context.wikiIndex ? `\n### 已有 Wiki 概况\n${truncate(context.wikiIndex)}` : "",
    context.reviewItem
      ? `\n### 待审阅知识点\n类型：${context.reviewItem.type}\n标题：${context.reviewItem.title}\n描述：${truncate(context.reviewItem.description)}`
      : "",
    context.gapContext
      ? `\n### 知识缺口\n类型：${context.gapContext.type}\n标题：${context.gapContext.title}\n描述：${truncate(context.gapContext.description)}`
      : "",
    "",
    "## 任务",
    "按上述 4 段结构组装 DeepWiki 查询 prompt，仅输出 4 段。",
  ].filter(Boolean).join("\n")

  let output = ""
  let streamError: Error | null = null

  try {
    await streamChat(
      llmConfig,
      [{ role: "user", content: userMessage }],
      {
        onToken: (token) => { output += token },
        onDone: () => {},
        onError: (err) => { streamError = err },
      },
      signal,
    )
    // streamChat does NOT throw on abort — it calls onDone() and returns
    // normally (llm-client.ts:129-141), leaving `output` empty, which would
    // silently fall back to the template. A real timeout must be a hard
    // failure, so check the signal explicitly and throw AbortError.
    if (signal?.aborted) {
      throw new DOMException("assembly aborted", "AbortError")
    }
  } catch (err) {
    // AbortError is a hard failure (timeout) — rethrow, do NOT template-fall
    // back. Other errors keep the existing fallback behavior.
    if (
      err instanceof Error &&
      (err.name === "AbortError" || (err as DOMException)?.code === DOMException.ABORT_ERR)
    ) {
      throw err
    }
    streamError = err instanceof Error ? err : new Error(String(err))
  }

  if (streamError) {
    console.warn("[DeepWiki] assembly LLM errored, using template:", streamError.message)
    return { prompt: templateAssembly(context), fellBack: true }
  }

  const sections = parseAssemblySections(output)
  if (!sections) {
    console.warn("[DeepWiki] assembly output unparseable, using template. Output was:", output.slice(0, 200))
    return { prompt: templateAssembly(context), fellBack: true }
  }

  const prompt = SECTION_LABELS.map((label) => `${label}\n${sections[label]}`).join("\n\n")
  return { prompt, fellBack: false }
}
