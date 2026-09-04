# Spec: Search v1 — Omni-Index + Lake Reads (Phase P5, backend)

Status: **approved for implementation** · 2026-07-02
Architecture context: `docs/offline-sync-architecture.md` §7. Builds on P1 (registry)
and P4 (transcript lake — the server-local corpus that makes transcript search
possible without daemon round-trips). Backend only: the ⌘K palette UI is owned by
the issues-UI track (#49); the existing SearchView rewires onto this service as a
follow-on.

## 1. Problem

Search today is useless: no transcript content search (transcripts weren't on the
server until P4), no unified entry point across entities. And transcript READS
still require a live daemon — the lake has the bytes but nothing serves them.

## 2. Design

### 2.1 Server gains the agent-bridge dependency (deliberate)

`@podium/server` adds workspace dep `@podium/agent-bridge` (JSONL parsing +
`fileChainSource`). **Ship note: lockfile change → the live merge MUST run
`bun install` in the main checkout before services restart** (known redeploy
crash-loop otherwise; the ship-branch flow handles it).

### 2.2 Lake-fallback transcript reads (deferred from P4)

`registry.readTranscript`: when the daemon answer is empty/timeout AND the
session's segment has `mirrored_bytes > 0`, serve the window from the lake file
via `fileChainSource` (it IS the native JSONL, byte-verbatim). Same for parked
sessions on detached machines. Items flow through the existing wire shape.

### 2.3 Transcript FTS index, fed by the mirror

- FTS5 table `transcript_fts (content, machine_id UNINDEXED, native_id UNINDEXED,
  item_uuid UNINDEXED, ts UNINDEXED)` — one row per user/assistant message.
- Fed incrementally from `MirrorService`: after a chunk lands, parse ONLY the
  newly-appended complete lines (track a per-segment indexed-bytes cursor
  `indexed_bytes` column; partial trailing line waits for the next chunk),
  extract plain text from user/assistant records (reuse agent-bridge record
  parsing), insert. Pacing rides the mirror's own pacing for free.
- Re-mirror (truncate) → delete the segment's FTS rows and cursor, reindex as
  chunks arrive.

### 2.4 Search service + tRPC

`search.query({ text, limit? })` → ranked, typed results across sources, each
`{ kind, id, title, snippet, score, ...refs }`:
- transcripts (FTS5 bm25 + snippet(), joined to registry → podiumId, machine,
  session when resolvable)
- issues + comments (FTS or LIKE over title/description/comments — check what
  exists; FTS if cheap)
- conversations (existing conversations FTS — reuse)
- sessions (name/title/cwd LIKE), settings keys (static catalog)
Ranking: per-source bm25/heuristic score normalized + recency boost + type
weights (issues/sessions above old transcript hits at equal score). Keep the
fusion dead simple and documented.

### 2.5 Out of scope

UI (⌘K is #49's; SearchView rewire is a follow-on), semantic search, indexing
non-file harnesses beyond what the lake holds, cross-machine dedup of identical
conversations.

### 2.6 Feature flag

Both FTS5 indexes are gated by the `command-palette` flag (PDM-25) — the same
switch that shows Cmd+K, because there is deliberately no second, server-only
control over search.

The flag is read ONCE, in the `SessionStore` constructor, so a change takes
effect at the next server start. On: the tables, the three `conversations`
triggers and a rebuild. Off: the triggers are dropped so writes stop paying for
an index nobody reads, both FTS repositories report unavailable, and the
transcript indexer stays inert with `indexed_bytes` parked where it was. The
tables themselves are never dropped, which is what makes turning search back on
cheap — `conversations_fts` rebuilds from the table, and `transcript_fts` keeps
rows that could otherwise only be recovered by re-reading the whole lake.

Off is byte-identical to what a SQLite build without FTS5 already does: search
falls back to LIKE over `conversations`, and transcript hits are absent. The
superagent tools `search_conversations` and `search_all` are not registered at
all when the flag is off, so the assistant is never offered a search it cannot
back.

## 3. Testing

- Lake-fallback: daemon detached → readTranscript serves items from a seeded lake
  file; daemon answering normally → unchanged path.
- Indexer: chunk-boundary safety (a JSONL record split across two mirror chunks
  indexes exactly once), truncate → reindex, non-message records skipped.
- Search: bm25 ordering sane, snippets present, per-kind results typed, empty
  query → empty, limit respected; issue/session sources return expected hits.

## 4. Acceptance

- With the daemon stopped, chat view scrollback for a mirrored session loads.
- `search.query('some phrase from an old transcript')` returns the conversation
  with a snippet, alongside matching issues/sessions, in one call.
