import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { promises as fs } from "fs"
import * as path from "path"
import * as os from "os"
import {
  createDeepWikiRecord, loadDeepWikiRecords, saveDeepWikiRecords,
  appendRecord, runDeepWikiQueryRecord, triggerDeepWikiQuery,
  processDeepWikiQueue, retryAllFailedDeepWiki,
} from "./deepwiki-channel"
import type { LlmConfig, DeepWikiSourceConfig } from "@/stores/wiki-store"

// Build a scheduler ctx for direct worker/scheduler calls in tests.
function ctxFor(overrides: Partial<DeepWikiSourceConfig> = {}, projectId = "proj-1") {
  return {
    projectPath: tmpDir!,
    projectId,
    llmConfig: { provider: "openai", apiKey: "k", model: "m" } as LlmConfig,
    deepWikiConfig: {
      enabled: true, baseUrl: "u", spaceId: "s", model: "m", token: "t",
      branch: "main", timeoutSecs: 60, maxSnippetChars: 10000,
      ...overrides,
    } as DeepWikiSourceConfig,
    maxConcurrent: overrides.maxConcurrent ?? 3,
    reuseSessions: overrides.reuseSessions ?? false,
  }
}

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

    await appendRecord(tmpDir!, record) // seed so patch can find it
    await runDeepWikiQueryRecord(ctxFor(), record)

    const persisted = (await loadDeepWikiRecords(tmpDir!)).find((r) => r.id === record.id)!
    expect(persisted.status).toBe("ingested")
    const writtenPath = (writeFileAtomic as any).mock.calls.find((c: any[]) => c[0].includes(`deepwiki-${record.id}.md`))?.[0] as string
    expect(writtenPath).toContain(`deepwiki-${record.id}.md`)
    expect((writeFileAtomic as any).mock.calls.find((c: any[]) => c[0] === writtenPath)?.[1]).toBe("DeepWiki answer body")
    // enqueueIngest now takes a 4th onComplete callback; assert on the
    // first three positional args and that a function was passed.
    expect(enqueueIngest).toHaveBeenCalledWith("proj-1", writtenPath, "", expect.any(Function))
  })

  it("empty content -> failed, no source written, no enqueue", async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    const { writeFileAtomic } = await import("@/commands/fs")
    const { enqueueIngest } = await import("@/lib/ingest-queue")
    ;(invoke as any).mockResolvedValue({ content: "   ", spaceUrl: "" })

    const record = createDeepWikiRecord({ topic: "T", prompt: "p" })
    await appendRecord(tmpDir!, record)
    await runDeepWikiQueryRecord(ctxFor(), record)
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
    await runDeepWikiQueryRecord(ctxFor(), record)
    const persisted = (await loadDeepWikiRecords(tmpDir!)).find((r) => r.id === record.id)!
    expect(persisted.status).toBe("failed")
    expect(persisted.error).toMatch(/timeout/)
  })
})

describe("runDeepWikiQueryRecord — ingest onComplete → graphed/failed + terminal guard", () => {
  it("onComplete(success) transitions ingested -> graphed", async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    const { enqueueIngest } = await import("@/lib/ingest-queue")
    ;(invoke as any).mockResolvedValue({ content: "body", spaceUrl: "" })
    // Capture the onComplete callback so the test can fire it after enqueue.
    let capturedCb: ((success: boolean, files: string[], error?: string) => void) | null = null
    ;(enqueueIngest as any).mockImplementation(
      async (_p: string, _s: string, _f: string, cb?: (s: boolean, f: string[], e?: string) => void) => {
        capturedCb = cb ?? null
        return "task-1"
      },
    )

    const record = createDeepWikiRecord({ topic: "T", prompt: "p" })
    await appendRecord(tmpDir!, record)
    await runDeepWikiQueryRecord(ctxFor(), record)

    // Before the ingest callback fires, the record stays at ingested.
    expect((await loadDeepWikiRecords(tmpDir!)).find((r) => r.id === record.id)!.status).toBe("ingested")
    expect(capturedCb).not.toBeNull()
    capturedCb!(true, ["wiki/sources/foo.md"], undefined)
    // patchRecord is async; let it settle.
    await new Promise((r) => setTimeout(r, 10))

    const persisted = (await loadDeepWikiRecords(tmpDir!)).find((r) => r.id === record.id)!
    expect(persisted.status).toBe("graphed")
    expect(persisted.error).toBeNull()
  })

  it("onComplete(failure) transitions ingested -> failed with error", async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    const { enqueueIngest } = await import("@/lib/ingest-queue")
    ;(invoke as any).mockResolvedValue({ content: "body", spaceUrl: "" })
    let capturedCb: ((success: boolean, files: string[], error?: string) => void) | null = null
    ;(enqueueIngest as any).mockImplementation(
      async (_p: string, _s: string, _f: string, cb?: (s: boolean, f: string[], e?: string) => void) => {
        capturedCb = cb ?? null
        return "task-1"
      },
    )

    const record = createDeepWikiRecord({ topic: "T", prompt: "p" })
    await appendRecord(tmpDir!, record)
    await runDeepWikiQueryRecord(ctxFor(), record)
    capturedCb!(false, [], "ingest failed")
    await new Promise((r) => setTimeout(r, 10))

    const persisted = (await loadDeepWikiRecords(tmpDir!)).find((r) => r.id === record.id)!
    expect(persisted.status).toBe("failed")
    expect(persisted.error).toBe("ingest failed")
  })

  it("terminal guard: graphed is not regressed by a late ingested patch", async () => {
    const { mutateRecord } = await import("./deepwiki-channel")
    const record = createDeepWikiRecord({ topic: "T", prompt: "p" })
    await appendRecord(tmpDir!, record)
    // Move to ingested, then to graphed (terminal).
    await mutateRecord(tmpDir!, record.id, { status: "ingested" })
    await mutateRecord(tmpDir!, record.id, { status: "graphed" })
    // A late `ingested` patch (e.g. from a racing async callback) must NOT
    // downgrade the terminal `graphed` status.
    const updated = await mutateRecord(tmpDir!, record.id, { status: "ingested" })
    expect(updated!.status).toBe("graphed")
    // Non-status patches still apply on a terminal record.
    const updated2 = await mutateRecord(tmpDir!, record.id, { error: "stale" })
    expect(updated2!.status).toBe("graphed")
    expect(updated2!.error).toBe("stale")
  })

  it("terminal guard: failed is not regressed by a searching patch", async () => {
    const { mutateRecord } = await import("./deepwiki-channel")
    const record = createDeepWikiRecord({ topic: "T", prompt: "p" })
    await appendRecord(tmpDir!, record)
    await mutateRecord(tmpDir!, record.id, { status: "failed", error: "boom" })
    const updated = await mutateRecord(tmpDir!, record.id, { status: "searching", error: null })
    expect(updated!.status).toBe("failed")
    expect(updated!.error).toBeNull() // non-status fields still apply
  })

  it("terminal -> terminal transition is allowed (graphed -> failed)", async () => {
    const { mutateRecord } = await import("./deepwiki-channel")
    const record = createDeepWikiRecord({ topic: "T", prompt: "p" })
    await appendRecord(tmpDir!, record)
    await mutateRecord(tmpDir!, record.id, { status: "graphed" })
    const updated = await mutateRecord(tmpDir!, record.id, { status: "failed", error: "post-hoc" })
    expect(updated!.status).toBe("failed")
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

describe("concurrency limiter", () => {
  it("processDeepWikiQueue respects maxConcurrent (no overshoot)", async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    // Make invoke block until each test releases it, so workers stay in-flight
    // and we can observe the concurrency cap.
    let inflight = 0
    let maxObserved = 0
    const releaseQueue: Array<() => void> = []
    ;(invoke as any).mockImplementation(() => {
      inflight++
      maxObserved = Math.max(maxObserved, inflight)
      return new Promise((resolve) => {
        releaseQueue.push(() => {
          inflight--
          resolve({ content: "answer", spaceUrl: "" })
        })
      })
    })

    // 5 prompt_ready records, maxConcurrent = 2.
    const records = Array.from({ length: 5 }, (_, i) =>
      createDeepWikiRecord({ topic: `t${i}`, prompt: `p${i}` }),
    )
    await saveDeepWikiRecords(tmpDir!, records)
    const c = ctxFor({ maxConcurrent: 2 })
    void processDeepWikiQueue(c).catch(() => {})

    // Let the scheduler claim up to 2 and start workers.
    await new Promise((r) => setTimeout(r, 30))
    expect(maxObserved).toBe(2)
    expect(inflight).toBe(2)
    // 3 still prompt_ready (not yet claimed).
    const after1 = await loadDeepWikiRecords(tmpDir!)
    expect(after1.filter((r) => r.status === "prompt_ready")).toHaveLength(3)
    expect(after1.filter((r) => r.status === "searching")).toHaveLength(2)

    // Release one worker → slot frees → next prompt_ready claimed.
    releaseQueue.shift()!()
    await new Promise((r) => setTimeout(r, 30))
    expect(maxObserved).toBe(2) // never exceeded 2
    expect(inflight).toBe(2)

    // Release workers in waves: each release frees a slot → scheduler claims
    // the next prompt_ready → its invoke pushes a new release onto the queue.
    // Loop until no inflight invoke remains and records settle.
    for (let i = 0; i < 30 && releaseQueue.length; i++) {
      while (releaseQueue.length) releaseQueue.shift()!()
      await new Promise((r) => setTimeout(r, 30))
    }
    await new Promise((r) => setTimeout(r, 50))
    const final = await loadDeepWikiRecords(tmpDir!)
    // All 5 reached ingested (enqueueIngest mock resolves immediately; slot
    // released in finally). None left prompt_ready/searching.
    expect(final.filter((r) => r.status === "prompt_ready" || r.status === "searching")).toHaveLength(0)
    expect(final.filter((r) => r.status === "ingested")).toHaveLength(5)
  })

  it("retryAllFailedDeepWiki resets failed → prompt_ready and re-runs under cap", async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    ;(invoke as any).mockResolvedValue({ content: "answer", spaceUrl: "" })

    const failed = Array.from({ length: 4 }, (_, i) =>
      ({ ...createDeepWikiRecord({ topic: `f${i}`, prompt: `pf${i}` }), status: "failed" as const, error: "boom" }),
    )
    await saveDeepWikiRecords(tmpDir!, failed)

    await retryAllFailedDeepWiki(tmpDir!, {} as any, { maxConcurrent: 2 } as any, "proj-1")
    await new Promise((r) => setTimeout(r, 50))

    const final = await loadDeepWikiRecords(tmpDir!)
    // All 4 re-ran (invoke called 4 times) and reached ingested.
    expect((invoke as any).mock.calls).toHaveLength(4)
    expect(final.filter((r) => r.status === "failed")).toHaveLength(0)
    expect(final.filter((r) => r.status === "ingested")).toHaveLength(4)
  })
})

describe("reuseSessions: fixed session pool + slot binding", () => {
  it("reuses at most maxConcurrent distinct session ids, bound to slots", async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    // Block each invoke so we can observe concurrent session assignment.
    const releaseQueue: Array<() => void> = []
    ;(invoke as any).mockImplementation(() =>
      new Promise((resolve) => {
        releaseQueue.push(() => resolve({ content: "answer", spaceUrl: "" }))
      }),
    )

    // 5 records, reuseSessions=true, maxConcurrent=2 → only 2 distinct session ids.
    const records = Array.from({ length: 5 }, (_, i) =>
      createDeepWikiRecord({ topic: `t${i}`, prompt: `p${i}` }),
    )
    await saveDeepWikiRecords(tmpDir!, records)
    const c = ctxFor({ maxConcurrent: 2, reuseSessions: true })
    void processDeepWikiQueue(c).catch(() => {})
    await new Promise((r) => setTimeout(r, 30))

    // 2 in flight → 2 distinct session ids assigned (slot 0 and slot 1).
    const inflight = (invoke as any).mock.calls
      .filter((c: any[]) => c[1]?.sessionId !== undefined)
      .map((c: any[]) => c[1].sessionId)
    expect(new Set(inflight).size).toBe(2)
    // The records claimed have slotIdx 0 and 1.
    const claimed = (await loadDeepWikiRecords(tmpDir!)).filter((r) => r.status === "searching")
    expect(claimed.map((r) => r.slotIdx).sort()).toEqual([0, 1])

    // Release all; every invoke must carry one of the same 2 session ids.
    for (let i = 0; i < 20 && releaseQueue.length; i++) {
      while (releaseQueue.length) releaseQueue.shift()!()
      await new Promise((r) => setTimeout(r, 30))
    }
    await new Promise((r) => setTimeout(r, 40))
    const allSessionIds = (invoke as any).mock.calls
      .map((c: any[]) => c[1]?.sessionId)
      .filter((s: unknown): s is string => typeof s === "string")
    expect(new Set(allSessionIds).size).toBe(2)
  })

  it("reuseSessions=false does not pass a sessionId (Rust generates UUID)", async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    ;(invoke as any).mockResolvedValue({ content: "answer", spaceUrl: "" })
    const record = createDeepWikiRecord({ topic: "T", prompt: "p" })
    await saveDeepWikiRecords(tmpDir!, [record])
    const c = ctxFor({ reuseSessions: false })
    void processDeepWikiQueue(c).catch(() => {})
    await new Promise((r) => setTimeout(r, 40))
    const passed = (invoke as any).mock.calls[0]?.[1]
    expect(passed?.sessionId).toBeUndefined()
  })
})
