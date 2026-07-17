import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { promises as fs } from "fs"
import * as path from "path"
import * as os from "os"
import {
  createDeepWikiRecord, loadDeepWikiRecords, saveDeepWikiRecords,
  appendRecord, runDeepWikiQueryRecord, triggerDeepWikiQuery,
} from "./deepwiki-channel"

// Tests run in Node (vitest); the MODULE under test must NOT use Node fs — it
// uses @/commands/fs (Tauri). Mock @/commands/fs and wire to real Node IO on a
// tmp dir, shared by all describes via the top-level beforeEach.
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  createDirectory: vi.fn(),
}))
vi.mock("@/lib/path-utils", () => ({ normalizePath: (p: string) => p.replace(/\/+$/, "") }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))
vi.mock("@/lib/deepwiki-assembly", () => ({
  assembleDeepWikiPrompt: vi.fn().mockResolvedValue({ prompt: "assembled-prompt", fellBack: false }),
}))
vi.mock("@/lib/ingest-queue", () => ({ enqueueIngest: vi.fn().mockResolvedValue("task-1") }))

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dw-test-"))
  const { readFile, writeFileAtomic, createDirectory } = await import("@/commands/fs")
  ;(readFile as any).mockImplementation(async (pp: string) => fs.readFile(pp, "utf-8"))
  ;(writeFileAtomic as any).mockImplementation(async (pp: string, c: string) => {
    await fs.mkdir(path.dirname(pp), { recursive: true })
    await fs.writeFile(pp, c)
  })
  ;(createDirectory as any).mockImplementation(async (pp: string) => fs.mkdir(pp, { recursive: true }))
  // Reset invoke/enqueueIngest call history between tests (NOT clearAllMocks —
  // would wipe the fs mock impls above). Keeps "not.toHaveBeenCalled" honest.
  const { invoke } = await import("@tauri-apps/api/core")
  const { enqueueIngest } = await import("@/lib/ingest-queue")
  ;(invoke as any).mockReset()
  ;(enqueueIngest as any).mockReset()
  ;(enqueueIngest as any).mockResolvedValue("task-1")
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("deepwiki-channel records", () => {
  it("createDeepWikiRecord builds a prompt_ready record with stable id", () => {
    const r = createDeepWikiRecord({ topic: "PayC entity", prompt: "## 上下文\n...", reviewItemId: "rev-1" })
    expect(r.status).toBe("prompt_ready")
    expect(r.id).toMatch(/^dw-/)
    expect(r.topic).toBe("PayC entity")
    expect(r.prompt).toBe("## 上下文\n...")
    expect(r.reviewItemId).toBe("rev-1")
    expect(r.error).toBeNull()
  })

  it("save then load round-trips records", async () => {
    const r = createDeepWikiRecord({ topic: "X", prompt: "p" })
    await saveDeepWikiRecords(tmpDir, [r])
    const loaded = await loadDeepWikiRecords(tmpDir)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe(r.id)
    expect(loaded[0].prompt).toBe("p")
  })

  it("load returns [] when file missing", async () => {
    expect(await loadDeepWikiRecords(tmpDir)).toEqual([])
  })

  it("save writes to .llm-wiki/deepwiki-queries.json", async () => {
    const r = createDeepWikiRecord({ topic: "X", prompt: "p" })
    await saveDeepWikiRecords(tmpDir, [r])
    const stat = await fs.stat(path.join(tmpDir, ".llm-wiki", "deepwiki-queries.json"))
    expect(stat.isFile()).toBe(true)
  })
})

describe("runDeepWikiQueryRecord", () => {
  it("searching -> ingested on success, writes deepwiki-<id>.md, enqueues", async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    const { enqueueIngest } = await import("@/lib/ingest-queue")
    const { writeFileAtomic } = await import("@/commands/fs")
    ;(invoke as any).mockResolvedValue({ content: "DeepWiki answer body", spaceUrl: "http://dw" })

    const record = createDeepWikiRecord({ topic: "T", prompt: "assembled-prompt" })
    const llmConfig: any = { provider: "openai", apiKey: "k", model: "m" }
    const dwConfig: any = { enabled: true, baseUrl: "u", spaceId: "s", model: "m", token: "t", branch: "main", timeoutSecs: 60, maxSnippetChars: 10000 }

    await appendRecord(tmpDir!, record) // seed so patch can find it
    await runDeepWikiQueryRecord(tmpDir!, record, llmConfig, dwConfig, "proj-1")

    const persisted = (await loadDeepWikiRecords(tmpDir!)).find((r) => r.id === record.id)!
    expect(persisted.status).toBe("ingested")
    const writtenPath = (writeFileAtomic as any).mock.calls.find((c: any[]) => c[0].includes(`deepwiki-${record.id}.md`))?.[0] as string
    expect(writtenPath).toContain(`deepwiki-${record.id}.md`)
    expect((writeFileAtomic as any).mock.calls.find((c: any[]) => c[0] === writtenPath)?.[1]).toBe("DeepWiki answer body")
    expect(enqueueIngest).toHaveBeenCalledWith("proj-1", writtenPath, "")
  })

  it("empty content -> failed, no source written, no enqueue", async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    const { writeFileAtomic } = await import("@/commands/fs")
    const { enqueueIngest } = await import("@/lib/ingest-queue")
    ;(invoke as any).mockResolvedValue({ content: "   ", spaceUrl: "" })

    const record = createDeepWikiRecord({ topic: "T", prompt: "p" })
    await appendRecord(tmpDir!, record)
    await runDeepWikiQueryRecord(tmpDir!, record, {} as any, {} as any, "proj-1")
    const persisted = (await loadDeepWikiRecords(tmpDir!)).find((r) => r.id === record.id)!
    expect(persisted.status).toBe("failed")
    expect(persisted.error).toMatch(/empty/i)
    expect(writeFileAtomic).not.toHaveBeenCalledWith(expect.stringContaining(`deepwiki-${record.id}.md`), expect.anything())
    expect(enqueueIngest).not.toHaveBeenCalled()
  })

  it("search throws -> failed with error message", async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    ;(invoke as any).mockRejectedValue(new Error("timeout"))
    const record = createDeepWikiRecord({ topic: "T", prompt: "p" })
    await appendRecord(tmpDir!, record)
    await runDeepWikiQueryRecord(tmpDir!, record, {} as any, {} as any, "proj-1")
    const persisted = (await loadDeepWikiRecords(tmpDir!)).find((r) => r.id === record.id)!
    expect(persisted.status).toBe("failed")
    expect(persisted.error).toMatch(/timeout/)
  })
})

describe("resumeDeepWikiQueries", () => {
  it("re-runs prompt_ready and searching records, skips ingested/failed", async () => {
    // Cannot vi.spyOn runDeepWikiQueryRecord (same-module local binding — ES
    // module live-binding interception doesn't reach internal calls). Instead
    // assert on the observable side effect: resume calls the DeepWiki search
    // (invoke) exactly for the prompt_ready + searching records, and NOT for
    // ingested/failed.
    const { invoke } = await import("@tauri-apps/api/core")
    ;(invoke as any).mockReset()
    ;(invoke as any).mockResolvedValue({ content: "answer", spaceUrl: "" })
    const ready = { ...createDeepWikiRecord({ topic: "a", prompt: "p-a" }), status: "prompt_ready" as const }
    const searching = { ...createDeepWikiRecord({ topic: "b", prompt: "p-b" }), status: "searching" as const }
    const ingested = { ...createDeepWikiRecord({ topic: "c", prompt: "p-c" }), status: "ingested" as const }
    const failed = { ...createDeepWikiRecord({ topic: "d", prompt: "p-d" }), status: "failed" as const, error: "x" }
    await saveDeepWikiRecords(tmpDir!, [ready, searching, ingested, failed])
    await (await import("./deepwiki-channel")).resumeDeepWikiQueries(tmpDir!, {} as any, {} as any, "proj-1")
    // settle the fire-and-forget workers
    await new Promise((r) => setTimeout(r, 50))
    const invokedPrompts = (invoke as any).mock.calls.map((c: any[]) => c[1]?.prompt)
    expect(invokedPrompts).toEqual(expect.arrayContaining(["p-a", "p-b"]))
    expect(invokedPrompts).not.toContain("p-c")
    expect(invokedPrompts).not.toContain("p-d")
  })
})

describe("triggerDeepWikiQuery assembly timeout", () => {
  it("abort on timeout, writes no record", async () => {
    vi.useFakeTimers()
    const { assembleDeepWikiPrompt } = await import("@/lib/deepwiki-assembly")
    ;(assembleDeepWikiPrompt as any).mockImplementation(
      (_l: unknown, _c: unknown, _i: unknown, signal: AbortSignal) =>
        new Promise((_res, rej) => {
          signal?.addEventListener("abort", () =>
            rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
          )
        }),
    )
    const dwConfig: any = { timeoutSecs: 1, assemblyInstruction: "" }
    const p = triggerDeepWikiQuery(
      tmpDir!, { topic: "T", purpose: "", wikiIndex: "" } as any, {} as any, dwConfig, "proj-1",
    )
    vi.advanceTimersByTime(1500)
    await expect(p).rejects.toThrow(/abort/i)
    expect(await loadDeepWikiRecords(tmpDir!)).toEqual([])
    vi.useRealTimers()
  })
})
