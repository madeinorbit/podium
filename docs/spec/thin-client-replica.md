# Spec: Thin-Client Replica — TanStack DB (Phase P6a)

Status: **approved for implementation** · 2026-07-03
Architecture context: `docs/offline-sync-architecture.md` §6.3 + §8. This is where
TanStack DB enters: the browser/mobile client gains a PERSISTENT local replica of
the durable entities plus offline transcript windows, fed by the P2 protocol
(`sync.changesSince` + `metadataDelta`) that was built to be its input. P6a scopes
to the web PWA (the Tauri webview runs the same bundle); React Native reuse is the
declared reason TanStack DB was chosen (§8) but is not built here.

## 1. Problem

The client holds everything in memory: a reload (or opening the PWA offline on a
phone — THE target use case) starts from nothing and needs the server for first
paint. Offline you can neither see your sessions/issues/conversations nor read any
chat history. The sync protocol and the durable outbox already exist; what's
missing is the persistent replica between them.

## 2. Design

### 2.1 Dependencies (new, isolated behind an adapter)

`@tanstack/db` (+ its React bindings and persistence packages per the INSTALLED
package's own docs — verify exact names/APIs from node_modules, not from memory;
the library is new and fast-moving). ALL TanStack APIs live behind one adapter
module `apps/web/src/replica.ts` — call sites and tests speak our interface
(`Replica` with typed collections + cursor + hydrate/persist), so an API-churn
upgrade or an RN port touches one file. If SQLite-wasm persistence proves
unworkable in the PWA (bundle/OPFS-header constraints), the adapter's persistence
layer may fall back to an IndexedDB/localStorage persister — the ADAPTER decides;
the interface doesn't change. Document the choice made.

### 2.2 Replica collections (sessions, issues, conversations) + cursor

- Three persisted collections keyed by the entity ids, mirroring the wire shapes.
- Fed at the existing seams — no protocol changes: the SocketHub subscriber
  callbacks (`onSessions`/`onIssues`/`onConversations` full-list replaces) upsert-
  diff into the collections, and the hub's `metadataCursor` is persisted alongside
  (a `meta` collection/row) after each applied batch.
- **Resume across reloads**: SocketHub gains an optional `initialCursor` (+ the
  web store passes the persisted one), so a reload calls `changesSince(persisted)`
  instead of `null` — a warm reload downloads a delta, not the world. A compaction
  fallback (snapshot) simply replaces collections; gap-heal semantics unchanged.
- **Hydrate-first paint**: the store's entity state initializes from the replica
  synchronously-ish (async hydrate before/parallel to WS connect; render whatever
  is local, reconcile when the network answers). Offline reload = full UI with
  last-known data instead of a blank shell.

### 2.3 Offline transcript windows

- ChatView's transcript reads (`sessions.transcriptRead`) get a write-through
  cache: the most recent window per conversation persists into a `transcripts`
  collection (bounded: last ~200 items per conversation, LRU cap ~50
  conversations — phones, not archives).
- Offline (tRPC fails / hub disconnected): serve the cached window with a visible
  "offline copy — as of <time>" notice. Online behavior byte-identical.

### 2.4 Explicitly out of scope (P6b+ / follow-ons)

Migrating the outbox to @tanstack/offline-transactions (the localStorage outbox
already works and is idempotency-keyed); live-query UI migration (components keep
consuming the store; collections are the persistence layer, not yet the query
layer); React Native app; blobs/images offline; search offline (FTS lives
server-side in P5); multi-tab write coordination beyond last-writer-wins persists.

## 3. Invariants

1. The replica is a CACHE of server truth: any snapshot/delta from the server
   overwrites it; it never argues (arbitration stays server-side, per P3).
2. A poisoned/corrupt replica must never wedge boot: hydrate failures clear the
   replica and proceed as a cold client (log, don't throw).
3. Persisted cursor is monotonic with applied data: persist cursor AFTER the
   entities it covers (a crash between = re-apply idempotent upserts, never gaps).
4. Zero behavior change when persistence is unavailable (private browsing, quota):
   degrade to today's in-memory client.

## 4. Testing

- Adapter: upsert/remove/hydrate round-trips; corrupt-storage → clean cold start;
  cursor persist-after-data ordering.
- SocketHub: `initialCursor` drives `changesSince(cursor)` on first connect;
  snapshot fallback still replaces + re-persists.
- Store integration: hydrate-first (collections seeded → store state present
  before any hub event); reconcile-on-snapshot keeps final state = server state.
- Transcript cache: write-through on read; LRU + per-conversation bounds; offline
  read serves cache with the notice flag; online read bypasses.
- Build gates: PWA `vite build` succeeds; report bundle-size delta (wasm included
  if the SQLite persister is used) — flag if total precache grows > ~1.5MB.

## 5. Acceptance

- Reload the PWA with the server stopped: sessions/issues/conversations lists and
  recent chat windows render from the replica, with offline indicators.
- Reload online after being away: the client catches up via `changesSince(cursor)`
  (observable: a delta response, not a snapshot, when within retention).
- Private-browsing (no storage): identical to today's behavior.
