import { writeFileAtomic, readFile, createDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

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
