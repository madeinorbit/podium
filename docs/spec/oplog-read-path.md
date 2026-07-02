# Spec: Metadata Oplog — Read Path (Phase P2)

Status: **approved for implementation** · 2026-07-02
Architecture context: `docs/offline-sync-architecture.md` §5. This spec covers the **read path only** — server-assigned change sequence, delta broadcasts, and cursor catch-up. The outbox/write path (P3) and thin-client replica (P6) are out of scope but constrain the design (noted inline).

## 1. Problem

All reactive metadata reaches clients as **full-list snapshot broadcasts** (`sessionsChanged`, `issuesChanged`, `conversationsChanged`) with no sequence/cursor. Consequences:

- Every mutation rebroadcasts the whole list to every client (O(list) per change; scales badly with sessions × clients).
- A reconnecting client has no way to ask "what changed since X" — it must take a fresh snapshot and blindly replace state (the source of past appear-then-vanish bugs).
- There is no substrate for offline replicas (P6) or node⇄hub sync (P7), both of which consume "changes since cursor."

The PTY stream already solved this shape with `seq`/`epoch` + `attach sinceSeq`. This phase applies the same pattern to metadata.

## 2. Design

### 2.1 Change log (server)

New SQLite table in the server store:

```sql
CREATE TABLE changes (
  seq        INTEGER PRIMARY KEY,          -- server-assigned, monotonic, gapless at append time
  entity     TEXT NOT NULL,                -- 'session' | 'issue' | 'conversation' (P2 set)
  entity_id  TEXT NOT NULL,
  op         TEXT NOT NULL,                -- 'upsert' | 'remove'
  payload    TEXT,                         -- wire-shape JSON for upsert; NULL for remove
  event_time INTEGER NOT NULL              -- ms epoch (reserved for P3 LWW arbitration)
);
CREATE INDEX changes_entity ON changes(entity, entity_id, seq);
```

- `seq` is a single global counter (one stream, one cursor — not per-entity), persisted implicitly by the PK.
- **Retention**: prune from the head by count/age (default: keep 20 000 rows or 14 days, whichever is larger). `minAvailableSeq` = lowest retained seq. Pruning only from the head keeps the retained range contiguous; catch-up replays are idempotent upserts, so redundancy is harmless.
- Payloads are the existing **wire shapes** (`SessionMeta`, `IssueWire`, `ConversationSummaryWire`) — the oplog speaks protocol, not DB rows.

### 2.2 One feed seam: diff-at-broadcast

*(Amended during implementation.)* The original draft planned a second, store-funneled
seam for issues, but `IssueWire` turns out to be a **broadcast-time composite** too:
`allWire()` embeds derived member-session data, which is why session changes
rebroadcast issues. So ALL THREE entities feed the oplog at the broadcast seam:

- `SessionMeta` is composed from live in-memory session objects and rebroadcast from
  ~25 call sites in `relay.ts`; `broadcastSessions()` already caches the last-sent
  payload for dedup — the oplog extends that idea to a **per-id diff** (serialized
  deep-equal per element), appending only actually-changed rows (`upsert`) and
  disappeared ids (`remove`).
- Issues funnel through the same diff via `publishIssues()` (both the
  `IssueService.broadcast` seam and the derived rebroadcast in `broadcastSessions`).
- Conversations diff inside `broadcastConversations()`.

This captures every change source without refactoring the call sites; the diff cost
is trivial (dozens of rows, in-memory, serialize-once). A store-funneled precise
`recordChange()` becomes relevant with P3 arbitration, not before. Boot
reconciliation (constructor) records the cross-restart diff for sessions and issues;
**conversations are deliberately excluded** — they are daemon-fed, and an empty list
at boot means "not scanned yet", not "all gone".

`hostMetricsChanged` / `machinesChanged` are **live-only** (architecture §5) — they stay full-snapshot broadcasts, no oplog rows.

### 2.3 Wire protocol (additive; no breaking change)

New in `@podium/protocol`:

```ts
// server → client (only to clients that advertised the capability)
MetadataDeltaMessage {
  type: 'metadataDelta',
  seq: number,                    // seq of the LAST change in this batch
  changes: Array<{
    seq: number,
    entity: 'session' | 'issue' | 'conversation',
    id: string,
    op: 'upsert' | 'remove',
    value?: SessionMeta | IssueWire | ConversationSummaryWire,  // present iff upsert
  }>,
}
```

- Capability negotiation: the client `hello` gains an optional `caps?: string[]`; a client sending `caps: ['metadataDelta']` receives `metadataDelta` **instead of** the three full-list broadcasts. Clients without the cap (older web bundles) keep receiving snapshots — zero breaking change, no `WIRE_VERSION` bump required.
- Batching: changes recorded within one broadcast/diff pass are sent as one `metadataDelta`.

Catch-up is a tRPC query (not WS), mirroring how imperative loads already work:

```ts
sync.changesSince({ cursor: number | null }) →
  | { kind: 'delta', changes: Change[], cursor: number }
  | { kind: 'snapshot', sessions: SessionMeta[], issues: IssueWire[],
      conversations: ConversationSummaryWire[],
      diagnostics: ConversationDiagnosticWire[],   // scan-level, not per-entity
      cursor: number }                             // cursor was null or < minAvailableSeq
```

*(Amended during implementation.)* Conversation **diagnostics** are scan-level, not
per-entity, so they don't ride the delta stream: they come with the snapshot, and
when only diagnostics change, cap clients additionally receive the full
`conversationsChanged` snapshot message (rare; a full replace is safe because it is
built from the same state as any delta in flight, and later deltas re-apply
idempotently by id).

### 2.4 Client behavior (web store)

- On connect (and on WS reconnect): call `changesSince(cursor)` — `null` on first load → snapshot + cursor; thereafter deltas.
- Live: apply `metadataDelta` batches in order. **Gap detection**: if a batch's first `seq` ≠ `cursor + 1`, do not apply; call `changesSince(cursor)` to heal (which may return a snapshot if compacted).
- State shape: entity slices become id-keyed maps applied per-delta; derived sorted lists memoized. The existing full-list handlers (`hub.onSessions`, `hub.onIssues`, `hub.onConversations`) remain as the snapshot-application path (bootstrap + heal), preserving today's semantics for non-cap clients.
- The existing ad-hoc per-entity messages (`issueUpdated`, `sessionDraftChanged`, `sessionTitleChanged`, `sessionAgentStateChanged`) are untouched in P2; they are candidates for folding into the delta stream later.

### 2.5 Ordering & durability invariants

1. `seq` assignment and log append happen before (or atomically with) delta emission; per-connection send order preserves seq order (single event loop + per-socket FIFO — already true for PTY frames).
2. A delta is emitted **only after** its change rows are durably in SQLite (so `changesSince` can always heal a gap the client detected).
3. Snapshot responses carry the cursor **as of the snapshot read**, taken in the same transaction/tick as the reads — no window where a change is in neither snapshot nor subsequent deltas.
4. Server restart: seq continues from `MAX(changes.seq)` (PK does this for free). In-memory session state rebuilds on boot as today; the boot pass runs one diff against the last persisted payloads, emitting upserts/removes for anything that changed across the restart.

## 3. Scope

**In**: `changes` table + retention pruning; `recordChange()` (issues) + diff-at-broadcast (sessions, conversations); `metadataDelta` message + `hello.caps`; `sync.changesSince` tRPC route; web client cursor tracking, delta application, gap-heal; tests.

**Out (explicitly)**: outbox/optimistic writes (P3); idempotency IDs (P3); machines/hostMetrics deltas (live-only); repos/worktrees (tRPC-pulled today, fold in later); node⇄hub (P7); folding the ad-hoc per-entity messages into the stream; any UI changes beyond state-layer plumbing.

## 4. Testing

1. **Unit (server)**: diff-at-broadcast produces minimal upsert/remove sets; recordChange transactionality (change row and entity row commit together or not at all); retention pruning preserves contiguity and `minAvailableSeq`; restart-diff emits deltas for cross-restart changes.
2. **Unit (protocol)**: schema round-trips; non-cap hello never receives `metadataDelta` (and cap hello never receives the three snapshots).
3. **Integration (isolated podium instance)**: two clients — mutate an issue via client A, assert client B receives exactly one delta (not a full list); kill B's WS, mutate N times, reconnect → `changesSince` heals to identical state as a fresh snapshot client; force-compact past B's cursor → snapshot fallback path.
4. **Property check**: for a random mutation sequence, `snapshot(0) + all deltas ≡ snapshot(final)` per entity.
5. Existing suites (287+) stay green; typecheck green.

## 5. Acceptance criteria

- With two browsers open, an issue/session change appears in both in real time, delivered as `metadataDelta` (verified at the WS layer), while a client without the cap still works on snapshots.
- Reconnect after offline mutations converges to correct state via `changesSince` without a full-list broadcast.
- Cursor older than `minAvailableSeq` falls back to snapshot and continues on deltas afterwards.
- No change to daemon protocol, PTY path, or UI behavior.
