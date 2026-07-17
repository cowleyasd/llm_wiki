import { writeFileAtomic, readFile, createDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { invoke } from "@tauri-apps/api/core"
import { assembleDeepWikiPrompt, type ResearchContext } from "@/lib/deepwiki-assembly"
import { enqueueIngest } from "@/lib/ingest-queue"
import { useDeepWikiStore } from "@/stores/deepwiki-store"
import type { LlmConfig, DeepWikiSourceConfig } from "@/stores/wiki-store"

interface DeepWikiSearchResult { content: string; spaceUrl: string }

function sourceFilePath(projectPath: string, recordId: string): string {
  return `${normalizePath(projectPath)}/raw/sources/deepwiki-${recordId}.md`
}

/** Persist record patch (whole RMW inside per-project lock) + update store. */
async function patchRecord(
  projectPath: string,
  id: string,
  patch: Partial<DeepWikiQueryRecord>,
): Promise<DeepWikiQueryRecord | null> {
  const updated = await mutateRecord(projectPath, id, patch)
  if (updated) useDeepWikiStore.getState().updateRecord(id, updated)
  return updated
}

/**
 * Async worker: search DeepWiki with the record's stored prompt, write source
 * file, enqueue for ingest. Updates record status through searching -> ingested/failed.
 * Does NOT track autoIngest internal progress (ingest-queue owns that).
 */
export async function runDeepWikiQueryRecord(
  projectPath: string,
  record: DeepWikiQueryRecord,
  _llmConfig: LlmConfig,
  deepWikiConfig: DeepWikiSourceConfig,
  projectId: string,
): Promise<void> {
  await patchRecord(projectPath, record.id, { status: "searching", error: null })

  try {
    const result = await invoke<DeepWikiSearchResult>("deepwiki_search", {
      prompt: record.prompt,
      config: deepWikiConfig,
    })
    if (!result.content?.trim()) {
      throw new Error("DeepWiki returned an empty response")
    }
    const srcPath = sourceFilePath(projectPath, record.id)
    await writeFileAtomic(srcPath, result.content)
    await enqueueIngest(projectId, srcPath, "")
    await patchRecord(projectPath, record.id, { status: "ingested" })
  } catch (err) {
    await patchRecord(projectPath, record.id, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Trigger from DR: assemble prompt (with AbortSignal timeout — see Task 4),
 * write a prompt_ready record, kick off the async worker (fire-and-forget).
 * Returns the record id immediately so DR can complete. On hard assembly
 * failure (timeout AND template fallback unavailable) no record is written
 * and this throws — caller (DR) treats as DeepWiki not triggered.
 */
export async function triggerDeepWikiQuery(
  projectPath: string,
  context: ResearchContext,
  llmConfig: LlmConfig,
  deepWikiConfig: DeepWikiSourceConfig,
  projectId: string,
): Promise<string> {
  // Assembly timeout: AbortSignal threaded through assembleDeepWikiPrompt →
  // streamChat so a stuck LLM request is truly cancelled (not raced). On
  // timeout AbortError propagates out of assembleDeepWikiPrompt (hard failure,
  // no template fallback) and no record is written. See Task 4.
  const timeoutMs = (deepWikiConfig.timeoutSecs ?? 120) * 1000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let prompt: string
  try {
    const result = await assembleDeepWikiPrompt(
      llmConfig, context, deepWikiConfig.assemblyInstruction ?? "", controller.signal,
    )
    prompt = result.prompt
  } finally {
    clearTimeout(timer)
  }
  const record = createDeepWikiRecord({
    topic: context.topic,
    prompt,
    reviewItemId: (context.reviewItem as any)?.reviewItemId,
    gapContext: context.gapContext,
  })
  // Append record (prompt_ready) atomically — DR completes on durable record.
  await appendRecord(projectPath, record)
  useDeepWikiStore.getState().addRecord(record)

  // Fire-and-forget the async search+ingest. Errors land in record.status=failed.
  void runDeepWikiQueryRecord(projectPath, record, llmConfig, deepWikiConfig, projectId)
    .catch((err) => console.warn("[deepwiki-channel] worker crashed:", err))

  return record.id
}

/** Retry: reuse stored prompt, re-run worker (status reset to searching inside). */
export async function retryDeepWikiQuery(
  projectPath: string,
  recordId: string,
  llmConfig: LlmConfig,
  deepWikiConfig: DeepWikiSourceConfig,
  projectId: string,
): Promise<void> {
  const records = await loadDeepWikiRecords(projectPath)
  const record = records.find((r) => r.id === recordId)
  if (!record) throw new Error(`DeepWiki record not found: ${recordId}`)
  await runDeepWikiQueryRecord(projectPath, record, llmConfig, deepWikiConfig, projectId)
}

/**
 * Restart recovery: load persisted records, hydrate the store, and re-run the
 * async worker for any record left mid-flight (prompt_ready / searching) when
 * the app closed. ingested / failed records are left as-is. Workers are
 * fire-and-forget (same as trigger) — their errors land in record.status=failed.
 */
export async function resumeDeepWikiQueries(
  projectPath: string,
  llmConfig: LlmConfig,
  deepWikiConfig: DeepWikiSourceConfig,
  projectId: string,
): Promise<void> {
  const records = await loadDeepWikiRecords(projectPath)
  useDeepWikiStore.getState().setRecords(records)
  const toResume = records.filter((r) => r.status === "prompt_ready" || r.status === "searching")
  for (const r of toResume) {
    void runDeepWikiQueryRecord(projectPath, r, llmConfig, deepWikiConfig, projectId).catch((err) =>
      console.warn(`[deepwiki-channel] resume failed for ${r.id}:`, err),
    )
  }
}

export type DeepWikiQueryStatus = "prompt_ready" | "searching" | "ingested" | "failed"

export interface DeepWikiQueryRecord {
  /** Stable unique id; source file is named deepwiki-<id>.md so retries overwrite. */
  id: string
  topic: string
  /** Assembled prompt — the retry basis. Re-running never re-assembles. */
  prompt: string
  status: DeepWikiQueryStatus
  error: string | null
  createdAt: number
  /** Originating review item, for traceability. */
  reviewItemId?: string
  /** Originating graph gap context, for traceability. */
  gapContext?: unknown
}

let idCounter = 0

export function createDeepWikiRecord(input: {
  topic: string
  prompt: string
  reviewItemId?: string
  gapContext?: unknown
}): DeepWikiQueryRecord {
  const id = `dw-${Date.now()}-${++idCounter}`
  return {
    id,
    topic: input.topic,
    prompt: input.prompt,
    status: "prompt_ready",
    error: null,
    createdAt: Date.now(),
    reviewItemId: input.reviewItemId,
    gapContext: input.gapContext,
  }
}

function recordsPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/deepwiki-queries.json`
}

export async function loadDeepWikiRecords(projectPath: string): Promise<DeepWikiQueryRecord[]> {
  try {
    const raw = await readFile(recordsPath(projectPath))
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * The ENTIRE read-modify-write must run inside one per-project serial critical
 * section, or concurrent trigger/status updates read the same stale snapshot
 * and clobber each other. Callers use `withRecordsLock` to mutate.
 */
const recordChains = new Map<string, Promise<unknown>>()

function withRecordsLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
  const pp = normalizePath(projectPath)
  const prev = recordChains.get(pp) ?? Promise.resolve()
  const next = prev.then(fn, fn) // run fn regardless of prior success/failure
  recordChains.set(pp, next.catch(() => {})) // keep chain alive on error
  return next
}

async function writeRecordsRaw(projectPath: string, records: DeepWikiQueryRecord[]): Promise<void> {
  const pp = normalizePath(projectPath)
  await createDirectory(`${pp}/.llm-wiki`)
  await writeFileAtomic(recordsPath(pp), JSON.stringify(records, null, 2))
}

export async function saveDeepWikiRecords(projectPath: string, records: DeepWikiQueryRecord[]): Promise<void> {
  await withRecordsLock(projectPath, () => writeRecordsRaw(projectPath, records))
}

/**
 * Atomically update one record: load all, replace by id, persist. Whole RMW
 * inside the per-project lock so concurrent updates don't lose data.
 */
export async function mutateRecord(
  projectPath: string,
  id: string,
  patch: Partial<DeepWikiQueryRecord>,
): Promise<DeepWikiQueryRecord | null> {
  return withRecordsLock(projectPath, async () => {
    const records = await loadDeepWikiRecords(projectPath)
    const idx = records.findIndex((r) => r.id === id)
    if (idx < 0) return null
    records[idx] = { ...records[idx], ...patch }
    await writeRecordsRaw(projectPath, records)
    return records[idx]
  })
}

/** Atomically append a record. Returns the appended record. */
export async function appendRecord(projectPath: string, record: DeepWikiQueryRecord): Promise<void> {
  await withRecordsLock(projectPath, async () => {
    const records = await loadDeepWikiRecords(projectPath)
    records.push(record)
    await writeRecordsRaw(projectPath, records)
  })
}
