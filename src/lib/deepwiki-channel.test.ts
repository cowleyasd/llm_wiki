import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { promises as fs } from "fs"
import * as path from "path"
import * as os from "os"
import {
  createDeepWikiRecord, loadDeepWikiRecords, saveDeepWikiRecords,
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
