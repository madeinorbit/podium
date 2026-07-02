# Spec: Outbox Write Path — Idempotency, Queued Sends, Client Outbox (Phase P3)

Status: **approved for implementation** · 2026-07-02
Architecture context: `docs/offline-sync-architecture.md` §5.2. Builds on the P2 oplog
read path (`docs/spec/oplog-read-path.md`). Three deliverables, in dependency order:
a server idempotency substrate, a durable server-held queue for messages to
unreachable agents, and a minimal client outbox for offline authoring.

## 1. Problem

1. **No mutation is replay-safe.** Every write (issue edits, sends, snoozes) assumes
   exactly-once HTTP. Any retry/replay layer — the whole offline story — needs
   idempotency first; retrofitting IDs later means auditing every call site again.
2. **Messages to waking agents are droppable.** `resumeAndSend` wakes a parked
   session and hands the text to `sendTextWhenReady` (`relay.ts`) — an in-memory
   200ms poll with a 25s deadline that **silently drops** on timeout, exit, or
   server restart. The user sees a pending bubble that never resolves to failed.
3. **Nothing authored offline survives.** The web client's optimistic writes are
   fire-and-forget; with no connection they are simply lost.

## 2. Design

### 2.1 Idempotency substrate (server)

- New table: `applied_mutations (mutation_id TEXT PRIMARY KEY, proc TEXT,
  result TEXT, applied_at INTEGER)`, pruned after 30 days.
- Write procedures accept an optional `mutationId: string` (client-generated,
  crypto-random). Wrapper semantics: if `mutation_id` exists → return the stored
  result WITHOUT re-running; else run, record `(id, proc, result)` and return.
  Check-run-record happens in one synchronous pass (single-threaded event loop +
  sync store ops → no interleaving window).
- Covered procs (P3): `issues.create/update/close/addComment`,
  `sessions.sendText/resumeAndSend/rename/setArchived/setWorkState`,
  `snoozes.set/clear`. (Text sends are the most critical: a replayed send would
  double-type into the PTY.) Others opt in as they join the outbox.
- Absent `mutationId` = today's behavior, byte-identical.

### 2.2 Durable queued sends (server-held; replaces the silent-drop path)

- New table: `queued_messages (id TEXT PRIMARY KEY /* = mutationId */,
  session_id TEXT, text TEXT, queued_at INTEGER, attempts INTEGER)`, FIFO per
  session by `queued_at, rowid`.
- `registry.queueText({sessionId, text, mutationId})`:
  - Session live/starting AND its queue empty → deliver immediately (today's
    `sendText`), return `{delivered: true}`.
  - Otherwise → persist to the queue, return `{queued: true}`; if the session is
    parked and resumable, trigger `resurrectSession` best-effort (the wake that
    `resumeAndSend` does today).
- **Drain engine** (replaces `sendTextWhenReady`): per-session single-flight loop
  reusing the existing readiness heuristics (live + output-settle floor/quiet/max).
  When ready, deliver queue head → delete row → next. On exit/deadline the loop
  stops but **rows remain** — retried on the next liveness signal. Triggers:
  enqueue, `bind` (markLive), `attachDaemon`, `resurrectSession`, boot.
- **Survives restart**: rows are durable; boot re-arms drains. This closes failure
  modes (i)–(iii) of `sendTextWhenReady`.
- **Wire**: `SessionMeta.queuedMessageCount?: number` (additive, next to
  `draftUpdatedAt`/`snoozedUntil`) — derived from the table, injected at
  serialization like `snoozedUntil`. Flows to clients through the existing
  snapshots AND the P2 delta stream with zero extra plumbing.
- `resumeAndSend` reroutes through `queueText` (its tRPC surface is unchanged);
  `sendTextWhenReady` is deleted.

### 2.3 Client outbox (web, minimal-durable)

- `apps/web/src/outbox.ts`: localStorage-backed FIFO (`podium.outbox.v1`), entries
  `{mutationId, kind, input, queuedAt}`. localStorage (not IndexedDB) is deliberate
  for P3: the entries are small and the web client is the interim consumer — the
  real durable replica is P6 (TanStack DB / SQLite). The module API is
  storage-agnostic so P6 swaps the backing without touching call sites.
- **Every covered write goes through the outbox** (one code path): enqueue →
  optimistic local apply (the store methods already do this) → immediate drain when
  connected. Offline, entries wait; drain resumes on reconnect/`online` and runs
  sequentially in order with each entry's `mutationId` (server dedupes replays).
- Poison handling: a server VALIDATION error (bad input) drops the entry + toasts;
  network errors keep it queued with flat retry.
- Covered store methods (P3, *amended during implementation*): message sends (via
  `resumeAndSend`; live `sendText` stays direct-with-mutationId so it fails fast),
  snooze set/clear, rename, archive, workState. **Issue mutations got server-side
  idempotency but NOT web-outbox routing yet** — their call sites live in the issue
  views, not the store; routing them is a follow-on. Pins/tab-orders/
  sidebar-settings stay direct (low offline value; follow-on).
- **Pending UI**: (a) outbox size surfaces as a small "pending changes" indicator in
  the status strip (HostIndicators) with a toast on poison-drop; (b) chat shows the
  session's `queuedMessageCount` ("queued — will deliver when the agent is back")
  instead of today's forever-pending bubble.

### 2.4 Explicitly out of scope (P3)

Per-field LWW arbitration on replay (the oplog's `event_time` is reserved for it;
until then last-replay-wins per whole mutation), IndexedDB, TanStack DB (P6),
node⇄hub outbox reuse (P7), queued sends to *not-yet-created* sessions, and folding
per-session ad-hoc messages into the delta stream.

## 3. Invariants

1. A `mutationId` is applied at most once per server DB lifetime (30d window ≫ any
   sane replay horizon; a replay after pruning re-applies — acceptable for these
   mutation types, all user-visible and idempotent-ish at the domain level).
2. Queued messages for one session deliver in enqueue order, never interleaved by
   concurrent drains (single-flight per session).
3. A queued message is deleted only AFTER its bytes were written toward the daemon.
4. `queuedMessageCount` on the wire always equals the table's per-session count at
   serialization time.
5. The outbox never reorders entries and never drops one silently (poison drops
   toast; everything else retries).

## 4. Testing

- Store: applied-mutations round-trip + prune; queued_messages FIFO + attempts.
- Registry: immediate-when-live, queue-when-parked (+ auto-wake), drain on
  bind/attachDaemon/boot, rows survive failed drains and restarts, count on wire
  (and in the P2 delta stream), idempotent replay returns the recorded result and
  does NOT double-type (assert single `input` control frame).
- Router: mutationId on covered procs; replayed `issues.create` returns the
  original issue, no duplicate.
- Web outbox: enqueue/drain order, offline queue + reconnect replay with same
  mutationIds, poison drop + toast, indicator count.
- E2e (live server): parked session + `resumeAndSend` → row in queue + count on
  wire; kill the wake (no daemon) → row persists; replayed mutation dedupes.

## 5. Acceptance

- Sending to a hibernated session with the daemon down leaves a durable queued
  message, visible as a queued state in chat across ALL clients (via deltas), and
  it delivers exactly once when the agent comes back — including across a server
  restart in between.
- Replaying any covered mutation with the same `mutationId` is a no-op returning
  the original result.
- Issue edits made while the web client is offline apply optimistically, survive a
  reload (localStorage), and reach the server exactly once on reconnect.
