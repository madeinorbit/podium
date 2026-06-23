# Transcript Loading Re-architecture — Design

**Date:** 2026-06-22
**Branch:** `feat/transcript-rearch`
**Status:** Approved design, pending spec review → implementation plan
**Scope:** All harnesses (Claude Code, Codex, Grok, Cursor, Opencode). Claude Code is the reference/first-verified path.

---

## 1. Problem

The Podium chat transcript is unreliable for **live (running) sessions**. Observed symptoms:

- **(a)** Transcript does not load at all for some running sessions (e.g. a live "Debug …" session) — chat shows "No transcript yet" while the native PTY view has the full scrollback.
- **(b)** Transcript is missing the newest messages.
- **(c)** Transcript is missing old messages (gaps / truncation when scrolling back).
- **(d)** Chat does not stream output the way the terminal does.

## 2. Root-cause diagnosis

The JSONL file on disk is the actual source of truth, **but live sessions never read it.** For a live session the chat depends entirely on a volatile in-memory server buffer fed by a fragile chain:

```
Claude writes JSONL → daemon learns transcript_path from a hook → ensureTranscriptTail
  → 700ms poll reads new bytes → transcriptAppend (WS) → server in-mem buffer (cap 12k)
  → fan out to transcriptSubscribers → ChatView `items`
```

Every link is a single point of failure and the client has **no disk fallback** for a live session. Concrete seams (verified on `main` at the time of writing):

| # | Cause | Location |
|---|---|---|
| 1 | Server transcript buffer is **in-memory only, never persisted**; rebuilt empty on server boot. | `apps/server/src/relay.ts` `loadFromStore` (~170–229); `apps/server/src/session.ts:149`; no transcript table in `apps/server/src/store.ts` |
| 2 | On a **server-only restart** (daemon survives), the daemon takes the **already-held-bridge** reattach branch which does **zero transcript work** — it never re-seeds the fresh server's empty buffer. Its tail offset is at EOF, so nothing replays until the agent writes a *new* record. | `apps/daemon/src/daemon.ts:1020-1033` |
| 3 | ChatView only reads disk when **`parked`**; a **live** session has no disk fallback, so an empty buffer → "No transcript yet" forever. | `apps/web/src/ChatView.tsx:158,239,257,316` |
| 4 | Claude tail-start is **gated** on a hook's `transcript_path` *or* `msg.resume` (`&& msg.resume`). A fresh spawn is hook-only; lost hooks (degraded hook port) or a resume-less reattach → tail never starts. Codex/Grok self-heal by re-discovering the file from cwd; Claude does not. | `apps/daemon/src/daemon.ts:596-598, 757-758`; `apps/daemon/src/hook-ingest.ts` (ephemeral-port fallback) |
| 5 | `readTranscript` **short-circuits the disk read whenever the buffer is non-empty**, so old messages never backfill for a live session. | `apps/server/src/relay.ts:1407-1411` |
| 6 | Backward paging assumes `tail` is an exact contiguous suffix of the file (`fromEnd: items.length`); once the 12k cap drops a middle chunk this produces a **gap or duplication**, with no id-based stitching. | `apps/web/src/ChatView.tsx:476-490`; caps: `tailer.ts` `MAX_INITIAL_ITEMS=12_000`/`TAIL_BYTES=16MB`, `session.ts:66,262` |
| 7 | `LineDecoder.flush()` is **never called** by the tailer, so a final record written without a trailing newline stays invisible until the next write. | `packages/agent-bridge/src/transcript/tailer.ts`; `jsonl-stream.ts` |
| 8 | Chat is **block-granular** by nature: one JSONL record per completed content block (a single `message.id` spans multiple records). Token-by-token streaming is impossible from the transcript file. | Claude JSONL format (verified); `claude.ts` |

**Summary:** the architecture treats a volatile cache as the source of truth for live sessions, with the disk read reachable only for parked sessions and no bridge between them. Symptom (a) = buffer empty + no disk fallback + no re-seed; (b) = tail not feeding + flush/poll latency; (c) = stacked caps + suffix-assumption paging; (d) = block-granular transcript, architectural.

## 3. Design principle

**The harness JSONL file on disk is the single source of truth.** The daemon (filesystem owner) serves *cursor-anchored reads* from it. The server holds a bounded in-memory window purely as a **latency cache** — never the truth — and re-seeds it from disk on every (re)attach. The client always **reads-then-subscribes**, so a cold/empty cache or a late tail never blanks the chat.

## 4. The new protocol primitive

Four messages (`transcriptSnapshot`, `transcriptAppend`, on-demand `transcriptRead`, `transcriptPage`) collapse into **one read + one subscribe**, both cursor-anchored and status-agnostic:

```ts
// Served from disk by the daemon; relayed by the server; exposed to the client over WS + tRPC.
transcriptRead(sessionId, {
  anchor?: Cursor,                 // omit = newest tail window
  direction: 'before' | 'after',  // 'before' = scroll-up history; 'after' = catch-up
  limit: number
}) -> {
  items: TranscriptItem[],         // each item carries its own opaque `cursor`
  head: Cursor,                    // cursor of the first returned item
  tail: Cursor,                    // cursor of the last returned item
  hasMore: boolean                 // more items exist in `direction`
}

transcriptSubscribe(sessionId, { since: Cursor })   // live deltas strictly after `since`
  -> stream of transcriptDelta { items, tail }       // append-only; each item carries a `cursor`
transcriptUnsubscribe(sessionId)
```

`TranscriptItem` gains a stable `cursor` field (derived from the record uuid). All other fields keep their current shape (`packages/protocol/src/messages.ts:203`).

## 5. Cursor semantics

A `Cursor` is an **opaque string** the client never parses. The daemon defines and interprets it; concretely it encodes `{ fileId, recordUuid }`:

- **`recordUuid`** — every JSONL record already carries a unique `uuid`. This is the stable anchor; it survives the 12k cap and re-reads, so stitching is **exact** — the gap/overlap class (cause 6) is gone by construction.
- **`fileId`** — identifies which JSONL file the record lives in. A Claude **resume rolls into a fresh file**, so one Podium session's transcript can span an ordered *chain* of files.

**File-roll handling.** The daemon tracks the ordered file chain per session (it already swaps the tail on `transcript_path` change). A `read` resolves the anchor's `fileId`, seeks to `recordUuid`, reads in `direction`, and continues into the adjacent file at a boundary. `direction:'before'` walks backward across rolled files seamlessly; `hasMore:false` means "start of the oldest file." None of this leaks to client or server.

**Consequences.** Items are keyed by `recordUuid` end-to-end: React keys, dedup, and live↔history stitching all use a real stable id, not an array index. A redelivered item is idempotent (same uuid → replace, never duplicate). This also removes the latent `transcriptAppend{reset}` / client-ignores-`reset` fragility (the snapshot/append split is gone).

## 6. Lifecycle — when the transcript is (re)established

| Event | Behavior |
|---|---|
| **Client opens a session** | Always `read(direction:'before')` then `subscribe(since: tail)`. Cold cache or late tail no longer blanks chat — the read hits disk. Same path for live / parked / exited. |
| **WS reconnect (client)** | Re-`read(anchor: lastTail, direction:'after')` to catch up, then re-`subscribe`. No full reload. |
| **Daemon reattach — fresh bridge** | Start tail (below) + re-seed; unconditional. |
| **Daemon reattach — already-held bridge** (`daemon.ts:1020-1033`) | **NEW: re-seed the transcript** (emit a snapshot from disk) so a freshly-restarted server's empty cache repopulates. Fixes the server-only-restart blank-chat. |
| **Tail-start** | **NEW: ungated, harness-uniform.** Every harness starts its tail by **discovering the active file from cwd (+resume)** on spawn/reattach — the codex/grok pattern that self-heals. Hooks become a latency optimization, not the only trigger. Removes the `&& msg.resume` gate and the hook single-point-of-failure (cause 4). |

Net: a running session's transcript loads from disk on open even if the tail is late, the cache is cold, or hooks were lost; the cache always repopulates after a restart.

## 7. Server role / caching

- The server keeps a **bounded in-memory window per session** as a latency cache only. It answers a `read`/`subscribe` from the cache when warm, and falls through to a daemon disk `read` when cold — invisible to the client.
- The cache is **never the source of truth** and is **never persisted to SQLite.** The JSONL is already the durable store; a second copy would only add a sync/invalidation problem.
- The server **does not trust its buffer across a daemon (re)connect** — reattach re-seeds it.

## 8. Harness coverage

The `transcriptRead`/`subscribe` machinery is harness-agnostic — it operates on `TranscriptItem[]` + cursors. Per-harness code shrinks to one responsibility: **given a session, resolve its ordered file chain and parse records → items with uuids/cursors.** Claude / Codex / Grok / Cursor / Opencode each implement that resolver; cursor read/page/subscribe/seek is shared. This removes the per-harness divergence (Claude's hook-gated tail vs codex/grok's cwd-scan) that caused the bugs.

## 9. Streaming (out of scope this effort)

Chat stays **block-granular** — the JSONL cannot give token-by-token. Two latency leaks get fixed so it feels near-live:

- **Call `LineDecoder.flush()`** so a written-but-unterminated final record surfaces (cause 7).
- Tighten the tail poll where cheap.

True token-streaming (a PTY-fed "pending message" reconciled against the JSONL record when it lands) is a clean future addition; the cursor model does not block it. Explicitly **not built here.**

## 10. Migration

web + server + daemon deploy together from `main`, so this is a **coordinated big-bang protocol swap** — no back-compat shim. The old `transcriptSnapshot` / `transcriptAppend` / on-demand `transcriptRead` / `transcriptPage` messages and their handlers are removed. The live backend runs from the `main` checkout working tree, so this lands via the standard rebase + FF-merge + redeploy flow only after full verification in this worktree.

## 11. Testing strategy (TDD — failing tests first)

**Unit**
- Cursor encode / resolve round-trip.
- `direction` paging across a **file-roll boundary** (two chained JSONL files).
- Idempotent redelivery: same `recordUuid` replaces, never duplicates.
- `flush()` surfaces a trailing newline-less record.

**Integration**
- `read`-then-`subscribe` produces no gap and no overlap at the seam.
- Cold-cache live `read` falls through to a daemon disk read.
- Already-held-bridge reattach re-seeds the server cache.
- Tail-start with **no resume ref and no hook** still loads history from disk.

**E2e (Playwright harness — runtime verification, not just unit/build)**
- Open a **running** session → transcript appears.
- Restart the server → live transcript survives (re-seed).
- Scroll to top of a long session → full history, no gaps.

## 12. Out of scope

- Token-by-token chat streaming (§9).
- The separate duplicate-session-rows / unstable-dedup bug (session identity, `relay.ts:1241`) — tracked elsewhere; cursors assume stable session identity but do not fix that bug.
- Persisting transcripts to SQLite (explicitly rejected, §7).

## 13. Primary file touch-points

- `packages/protocol/src/messages.ts` — new `transcriptRead`/`transcriptDelta`/`transcriptSubscribe` shapes; `TranscriptItem.cursor`; remove old messages.
- `packages/agent-bridge/src/transcript/tailer.ts` — cursor-aware read/page/seek; `flush()`; file-chain awareness.
- `packages/agent-bridge/src/transcript/{claude,codex,grok,cursor,opencode}.ts` — per-harness file-chain resolver + uuid/cursor on items.
- `apps/daemon/src/daemon.ts` — ungated harness-uniform tail-start; re-seed on both reattach branches; cursor read/page handlers.
- `apps/server/src/relay.ts`, `apps/server/src/session.ts` — cache as cursor-aware latency window; re-seed on reattach; serve `read`/`subscribe` from cache-or-disk.
- `apps/server/src/router.ts` — tRPC `transcriptRead` (replaces `transcript`/`transcriptPage`).
- `apps/web/src/ChatView.tsx`, `packages/terminal-client/src/connection.ts` — uniform read-then-subscribe; cursor-keyed items; drop the `parked` branch and `fromEnd` arithmetic.
