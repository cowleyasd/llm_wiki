# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

LLM Wiki is a Tauri 2 desktop app that incrementally builds and maintains a personal wiki from source documents using an LLM. Three-layer architecture: **Raw Sources** (immutable, `raw/sources/`) → **Wiki** (LLM-generated, `wiki/`) → **Schema** (`schema.md` rules + `purpose.md` intent). Every wiki page has YAML frontmatter and uses `[[wikilink]]` cross-references; the wiki directory is Obsidian-compatible.

## Commands

### Frontend (TS/React, run from repo root)
- `npm run dev` — Vite dev server (frontend only, port 1420)
- `npm run tauri dev` — full app (Vite + Rust compile + Tauri window). **First run needs protoc** (`brew install protobuf`) for LanceDB, and `mcp-server/dist/` must exist (Tauri build.rs bundles it as a resource — run `npm --prefix mcp-server run build` first, or `npm run build:desktop` does both).
- `npm run typecheck` — `tsc --build` (project references; use this, not raw `tsc --noEmit`)
- `npm run build` — typecheck + Vite production build
- `npm test` — all tests (mocks + real-llm)
- `npm run test:mocks` — unit tests, no network. **Default for fast iteration.**
- `npm run test:llm` — `*.real-llm.test.ts` files; need a live LLM/embedding server in `.env.test.local`. Serial, verbose. These fail without a server — not a code regression.
- Single test: `npx vitest run src/lib/deep-research.test.ts` (or a single `it` via `-t "name"`)

### Rust (`src-tauri/`)
- `cargo check` — fast compile check. Needs protoc + `mcp-server/dist`.
- `cargo test --lib commands::deepwiki_search` — run one module's tests. Filter with `::module::tests::test_name`.
- `cargo build` / the Tauri build via `npm run tauri dev|build`.

### MCP server (`mcp-server/`)
Standalone Node package (`@modelcontextprotocol/sdk`). `npm --prefix mcp-server run build` (tsc) / `test` (node --test). It talks to the app's local HTTP API; not bundled into the Tauri binary but shipped as a resource.

## Architecture

### Two runtimes — don't confuse them
1. **Frontend TS pipeline** (renderer, `src/lib/`): ingest, deep research, lint, search, graph. Talks to Rust only for primitives (file IO, web/anytxt/deepwiki search via `invoke("...")` Tauri commands). The Deep Research engine (`src/lib/deep-research.ts`) runs here, NOT in the Rust agent.
2. **Rust chat agent** (`src-tauri/src/agent/`): tool-using chat runtime invoked by `agent_start_turn` / `agent_start_turn_stream` Tauri commands. Has its own tool registry (`agent/tools.rs`), skills system (`agent/skills.rs`), planner (`runtime.rs`). Skills (`SKILL.md` folders) live ONLY here — they are instructions injected into the chat agent's prompt, not information sources for Deep Research.

When adding a feature, decide which runtime it belongs to. A new Deep Research source = frontend TS + a Tauri command shim (see `commands/external_search.rs`, `commands/deepwiki_search.rs`). A new chat-agent tool = `agent/tools.rs` + registry.

### Tauri command boundary
All Rust→frontend calls go through `tauri::generate_handler!` in `src-tauri/src/lib.rs:620`. Search-related commands (`web_search`, `anytxt_search`, `deepwiki_search`) live in `src-tauri/src/commands/` and return `ExternalSearchResult { title, url, snippet, source }` — the lingua franca that the frontend's `collectResearchSources` merges. Add a new source by mirroring this pattern; do NOT route Deep Research sources through `agent/tools.rs` (that module is for the chat agent).

### Local HTTP API (port 19828)
`src-tauri/src/api_server.rs` binds `127.0.0.1:19828/api/v1` (port is a `const`, no env override). 23 routes covering projects, files, reviews, chat, search. The MCP server and external agents call this. The frontend constant is `src/lib/api-server-constants.ts` (`API_SERVER_PORT`) — keep both in sync if you touch the port.

### Ingest pipeline (frontend, `src/lib/ingest.ts`)
`autoIngest()` = **two-step LLM**: (1) analyze source → (2) generate wiki pages. Queue is **strictly serial** (`src/lib/ingest-queue.ts` — module-level `processing` lock, one task at a time; this is intentional, not configurable). SHA256 incremental cache skips unchanged sources. Queue persists to `.llm-wiki/` and survives restart. Failed tasks retry up to 3×.

### Deep Research (frontend, `src/lib/deep-research.ts`)
`queueResearch()` → `executeResearch()` 3-stage pipeline: collect sources → LLM synthesis → save `wiki/queries/research-*.md`. Sources are a **list model** (`deepResearchSources: string[]`): `web`, `anytxt`, `deepwiki`. Key invariants:
- **Any selected source failing aborts before synthesis** (not just when all empty). Selected-but-unconfigured sources are failures, not silent skips.
- DeepWiki results bypass the 20-result cap (long-form answer).
- Review items resolve only after the page is durably saved (`executeResearch` calls `useReviewStore.resolveItem` after `writeFile`).
- The DeepWiki prompt is assembled by an LLM from `ResearchContext` (review item / graph gap + `wiki/index.md` + `purpose.md`) in `src/lib/deepwiki-assembly.ts`.

### State (Zustand, `src/stores/`)
Separate stores per concern: `wiki-store` (config: LLM, search API, embedding, project), `research-store` (research task queue, `maxConcurrent=3`), `review-store`, `chat-store`, `lint-store`, `activity-store`. Stores are independent; cross-store mutation is fine via `useXStore.getState().action(...)` (e.g. research resolving a review item). Config persists to `.llm-wiki/` per project via `src/lib/persist.ts` + `project-store.ts`.

### Config persistence
Persisted config is loaded as an **unchecked generic cast** (`project-store.ts`) — no migration at load time. Runtime normalization happens in `resolveSearchConfig` (`src/lib/web-search.ts`), which is the single place legacy fields are migrated (e.g. old `deepResearchSource` scalar → `deepResearchSources` list). When adding config fields, add normalization here, not at load.

## Conventions

- **No hardcoded endpoint defaults for external services.** The DeepWiki source ships with empty baseUrl/spaceId/model/token — users supply all connection info. Keep the public fork free of internal infrastructure details.
- Frontend↔Rust result shape for search sources is always `{ title, url, snippet, source }`. File paths become `file://` URLs via `file_url_for_path` in `external_search.rs`.
- i18n: `src/i18n/en.json` + `zh.json`. UI text uses `t(key, "fallback")` — fallbacks render even if the key isn't translated yet.
- Tests live next to source (`*.test.ts`). `*.real-llm.test.ts` suffix marks tests needing a live server; excluded from `test:mocks`.
- The `.claude/` dir and `plan.md` are gitignored (local planning, not shipped).
