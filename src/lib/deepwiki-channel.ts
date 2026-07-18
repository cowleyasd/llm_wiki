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

// ── Concurrency limiter ────────────────────────────────────────────────────
// DeepWiki service cannot handle unbounded concurrency. The scheduler caps
// how many runDeepWikiQueryRecord workers run at once per project (default 3,
// configurable via DeepWikiSourceConfig.maxConcurrent). The slot covers only
// the DeepWiki query stage (invoke + write source + enqueueIngest); once
// enqueued, the slot is released (try/finally) and ingest runs in the serial
// ingest-queue — so DeepWiki query throughput is decoupled from ingest speed.
//
// Per-project counters (Map<projectPath, number>) avoid cross-project
// starvation: project A's workers don't consume project B's slots.
const deepWikiRunning = new Map<string, number>()

interface SchedulerCtx {
  projectPath: string
  projectId: string
  llmConfig: LlmConfig
  deepWikiConfig: DeepWikiSourceConfig
  maxConcurrent: number
}

/**
 * Atomically claim one prompt_ready record: inside withRecordsLock, check
// capacity (running < maxConcurrent), increment running, flip the earliest
// prompt_ready → searching, persist, return it. Returns null when at capacity
// or no prompt_ready remains. Doing capacity-check + running++ + status-claim
// in ONE lock callback makes the three steps atomic — concurrent
// processDeepWikiQueue callers can't each see a free slot and overshoot.
 * (mutateRecord is NOT used here — it takes the same lock and the chain is
 * non-reentrant, which would deadlock.)
 */
async function claimNextPromptReady(ctx: SchedulerCtx): Promise<DeepWikiQueryRecord | null> {
  return withRecordsLock(ctx.projectPath, async () => {
    const pp = normalizePath(ctx.projectPath)
    const running = deepWikiRunning.get(pp) ?? 0
    if (running >= ctx.maxConcurrent) return null
    const records = await loadDeepWikiRecords(ctx.projectPath)
    // Earliest prompt_ready (FIFO by createdAt).
    let targetIdx = -1
    let targetCreatedAt = Infinity
    for (let i = 0; i < records.length; i++) {
      const r = records[i]
      if (r.status === "prompt_ready" && r.createdAt < targetCreatedAt) {
        targetCreatedAt = r.createdAt
        targetIdx = i
      }
    }
    if (targetIdx < 0) return null
    records[targetIdx] = { ...records[targetIdx], status: "searching", error: null }
    await writeRecordsRaw(ctx.projectPath, records)
    deepWikiRunning.set(pp, running + 1)
    useDeepWikiStore.getState().updateRecord(records[targetIdx].id, records[targetIdx])
    return records[targetIdx]
  })
}

/** Release one slot and pump the queue. Called from worker's finally. */
function releaseSlotAndPump(ctx: SchedulerCtx): void {
  const pp = normalizePath(ctx.projectPath)
  const cur = deepWikiRunning.get(pp) ?? 0
  deepWikiRunning.set(pp, Math.max(0, cur - 1))
  void processDeepWikiQueue(ctx).catch((err) =>
    console.warn("[deepwiki-channel] pump failed:", err),
  )
}

/**
 * Pull prompt_ready records up to the concurrency cap and start workers.
 * Safe to call concurrently — claimNextPromptReady serializes claims inside
 * the per-project lock, so concurrent callers won't double-claim or overshoot.
 */
export async function processDeepWikiQueue(ctx: SchedulerCtx): Promise<void> {
  // Drain available slots. Each claim is atomic; when at capacity or no
  // prompt_ready left, claimNextPromptReady returns null and we stop.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const claimed = await claimNextPromptReady(ctx)
    if (!claimed) return
    const record = claimed
    // Worker releases its own slot in finally and pumps the queue.
    void runDeepWikiQueryRecord(ctx, record)
      .catch((err) => console.warn("[deepwiki-channel] worker crashed:", err))
  }
}

/**
 * Async worker: search DeepWiki with the record's stored prompt, write source
 * file, enqueue for ingest. Updates record status through
 * searching -> ingested -> graphed/failed.
 *
 * The `graphed` transition is driven by enqueueIngest's onComplete
 * callback (fires when the ingest-queue task reaches a terminal state).
 * Order matters: we `await patchRecord(ingested)` BEFORE enqueue so the
 * non-terminal `ingested` is durably on disk first; the terminal-state
 * guard in mutateRecord then protects `graphed` from being clobbered by
 * any late `ingested` patch.
 */
export async function runDeepWikiQueryRecord(
  ctx: SchedulerCtx,
  record: DeepWikiQueryRecord,
): Promise<void> {
  // Status was already flipped to "searching" by claimNextPromptReady (the
  // scheduler holds the slot from that point). Worker does NOT re-patch
  // searching. The slot is released in finally below — covers success, empty
  // response, search throw, and write/enqueue errors.
  try {
    const result = await invoke<DeepWikiSearchResult>("deepwiki_search", {
      prompt: record.prompt,
      config: ctx.deepWikiConfig,
    })
    if (!result.content?.trim()) {
      throw new Error("DeepWiki returned an empty response")
    }
    const srcPath = sourceFilePath(ctx.projectPath, record.id)
    await writeFileAtomic(srcPath, result.content)
    // 1. Durably persist `ingested` first so the terminal guard has
    //    something non-terminal to upgrade from.
    await patchRecord(ctx.projectPath, record.id, { status: "ingested" })
    // 2. Enqueue with a completion callback. The callback may fire
    //    synchronously (early-exit failures) or much later (after
    //    autoIngest finishes). The terminal guard ensures `graphed` /
    //    `failed` written here cannot be regressed by a stray `ingested`.
    await enqueueIngest(ctx.projectId, srcPath, "", (success, _writtenFiles, error) => {
      void patchRecord(ctx.projectPath, record.id, {
        status: success ? "graphed" : "failed",
        error: success ? null : (error ?? "ingest failed"),
      })
    })
  } catch (err) {
    await patchRecord(ctx.projectPath, record.id, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    // Release the slot regardless of outcome, then pump the queue so the next
    // prompt_ready record starts. Slot release is just a decrement (no
    // capacity race — only the claim path increments, under the lock).
    releaseSlotAndPump(ctx)
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
  reviewItemId?: string,
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
    reviewItemId,
    gapContext: context.gapContext,
  })
  // Append record (prompt_ready) atomically — DR completes on durable record.
  await appendRecord(projectPath, record)
  useDeepWikiStore.getState().addRecord(record)

  // Pump the scheduler — it claims prompt_ready records up to maxConcurrent
  // and starts workers. The record just appended is eligible immediately.
  const ctx = makeCtx(projectPath, projectId, llmConfig, deepWikiConfig)
  void processDeepWikiQueue(ctx).catch((err) =>
    console.warn("[deepwiki-channel] schedule failed:", err),
  )

  return record.id
}

/** Retry: reuse stored prompt. Resets failed → prompt_ready (force-bypassing
 *  the terminal guard) then pumps the scheduler. The scheduler caps
 *  concurrency, so批量重试也不会打爆 DeepWiki. */
export async function retryDeepWikiQuery(
  projectPath: string,
  recordId: string,
  llmConfig: LlmConfig,
  deepWikiConfig: DeepWikiSourceConfig,
  projectId: string,
): Promise<void> {
  const updated = await mutateRecord(
    projectPath,
    recordId,
    { status: "prompt_ready", error: null },
    { force: true },
  )
  if (updated) useDeepWikiStore.getState().updateRecord(recordId, updated)
  const ctx = makeCtx(projectPath, projectId, llmConfig, deepWikiConfig)
  void processDeepWikiQueue(ctx).catch((err) =>
    console.warn("[deepwiki-channel] retry schedule failed:", err),
  )
}

/** Retry all failed records at once. Each is reset to prompt_ready (force),
 *  then the scheduler drains them respecting maxConcurrent. */
export async function retryAllFailedDeepWiki(
  projectPath: string,
  llmConfig: LlmConfig,
  deepWikiConfig: DeepWikiSourceConfig,
  projectId: string,
): Promise<void> {
  const records = await loadDeepWikiRecords(projectPath)
  const failed = records.filter((r) => r.status === "failed")
  for (const r of failed) {
    const updated = await mutateRecord(
      projectPath,
      r.id,
      { status: "prompt_ready", error: null },
      { force: true },
    )
    if (updated) useDeepWikiStore.getState().updateRecord(r.id, updated)
  }
  const ctx = makeCtx(projectPath, projectId, llmConfig, deepWikiConfig)
  void processDeepWikiQueue(ctx).catch((err) =>
    console.warn("[deepwiki-channel] retry-all schedule failed:", err),
  )
}

function makeCtx(
  projectPath: string,
  projectId: string,
  llmConfig: LlmConfig,
  deepWikiConfig: DeepWikiSourceConfig,
): SchedulerCtx {
  return {
    projectPath,
    projectId,
    llmConfig,
    deepWikiConfig,
    maxConcurrent: normalizeMaxConcurrent(deepWikiConfig.maxConcurrent),
  }
}

function normalizeMaxConcurrent(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 3
  return Math.floor(v)
}

/**
 * Restart recovery: load persisted records, hydrate the store, reset any
 * mid-flight records (prompt_ready / searching) to prompt_ready, then pump
 * the scheduler. searching records were interrupted by the crash — reset
 * them so the scheduler re-claims them (DeepWiki queries are idempotent:
 * same prompt → same answer, source file overwrites, entities union-merge).
 * ingested / failed / graphed records are left as-is.
 */
export async function resumeDeepWikiQueries(
  projectPath: string,
  llmConfig: LlmConfig,
  deepWikiConfig: DeepWikiSourceConfig,
  projectId: string,
): Promise<void> {
  const records = await loadDeepWikiRecords(projectPath)
  useDeepWikiStore.getState().setRecords(records)
  // Reset mid-flight (prompt_ready stays; searching → prompt_ready) so the
  // scheduler can claim them. searching→prompt_ready is non-terminal→non-
  // terminal, no force needed.
  for (const r of records) {
    if (r.status === "searching") {
      const updated = await mutateRecord(
        projectPath,
        r.id,
        { status: "prompt_ready", error: null },
      )
      if (updated) useDeepWikiStore.getState().updateRecord(r.id, updated)
    }
  }
  const ctx = makeCtx(projectPath, projectId, llmConfig, deepWikiConfig)
  void processDeepWikiQueue(ctx).catch((err) =>
    console.warn("[deepwiki-channel] resume schedule failed:", err),
  )
}

export type DeepWikiQueryStatus =
  | "prompt_ready"
  | "searching"
  | "ingested"
  | "graphed"
  | "failed"

/** Terminal states — once reached, they cannot be overwritten by a
 *  non-terminal status (searching/ingested/prompt_ready). Guards against
 *  the race where enqueueIngest's async onComplete (graphed) fires
 *  before a late patchRecord(ingested) lands, which would otherwise
 *  regress a finished record back to "queued". */
const TERMINAL_STATUSES: ReadonlySet<DeepWikiQueryStatus> = new Set(["graphed", "failed"])
function isTerminalStatus(s: DeepWikiQueryStatus): boolean {
  return TERMINAL_STATUSES.has(s)
}

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
 *
 * Terminal-state guard: if the existing record is already in a terminal
 * state (graphed/failed), a patch whose `status` would move it back to a
 * non-terminal state (searching/ingested/prompt_ready) has its `status`
 * field dropped. This prevents the enqueueIngest→onComplete race from
 * regressing a finished record. Patches without a `status` field, and
 * patches that keep/enter a terminal state, apply normally.
 */
export async function mutateRecord(
  projectPath: string,
  id: string,
  patch: Partial<DeepWikiQueryRecord>,
  options?: { force?: boolean },
): Promise<DeepWikiQueryRecord | null> {
  return withRecordsLock(projectPath, async () => {
    const records = await loadDeepWikiRecords(projectPath)
    const idx = records.findIndex((r) => r.id === id)
    if (idx < 0) return null
    const current = records[idx]
    const applied: Partial<DeepWikiQueryRecord> = { ...patch }
    if (
      !options?.force &&
      patch.status !== undefined &&
      isTerminalStatus(current.status) &&
      !isTerminalStatus(patch.status)
    ) {
      // Reject the status downgrade; keep all other patch fields.
      // `force` (used by retry) bypasses this to allow failed → prompt_ready.
      delete applied.status
    }
    records[idx] = { ...current, ...applied }
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
