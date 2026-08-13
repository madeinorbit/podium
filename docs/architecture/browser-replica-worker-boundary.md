# Browser replica worker boundary

## Goal

The browser UI must not be the owner of feed decoding or replica maintenance.
WebSocket delivery can contain a complete principal world, and the current
`onmessage` path performs JSON parsing, lenient row validation, feed mapping,
replica staging, IndexedDB operation construction, and cache event emission in
one main-thread turn. The target boundary makes that work a worker concern so
world size and delta bursts do not compete with pointer, keyboard, paint, or
terminal work.

## Target ownership

One dedicated worker owns the following per authenticated principal:

- the WebSocket and its reconnect/heartbeat lifecycle;
- the lenient decoder, quarantine/skew tally, feed identity checks, and ordering;
- `KernelReplica` and its atomic bootstrap staging/install state;
- the principal-scoped IndexedDB view; and
- the cross-tab channel used to relay durable deltas and rescope/evict frames.

The UI talks to a versioned structured-clone protocol. Worker-to-UI messages
are readiness/posture changes, installed snapshot or bounded patch results,
skew reports, and feed budget samples. UI-to-worker messages are lifecycle,
subscription, and user-intent commands. No UI component receives a live socket
envelope or opens the replica's IndexedDB view directly.

The first protocol version should have an explicit envelope rather than passing
the existing server union through `postMessage`:

```ts
// Illustrative worker-boundary types, defined by the worker package.
type MainToReplicaWorker =
  | { version: 1; type: 'start'; url: string; viewport: Viewport }
  | { version: 1; type: 'subscribe'; kinds: readonly EntityKind[] }
  | { version: 1; type: 'stop' }

type ReplicaWorkerToMain =
  | { version: 1; type: 'ready'; cursor: Cursor | null; posture: Posture }
  | { version: 1; type: 'snapshotChunk'; revision: number; last: boolean; rows: readonly Row[] }
  | { version: 1; type: 'patch'; revision: number; changes: readonly InstalledChange[] }
  | { version: 1; type: 'skew'; report: WireSkew }
  | { version: 1; type: 'budget'; sample: FeedTaskTiming }
```

`Row`, `InstalledChange`, `Cursor`, and `WireSkew` are versioned worker
boundary values, not the protocol's socket message union. Snapshot output is
also chunked so structured-clone and UI cache-event work cannot simply move the
same long task from the worker to the main thread. The worker rejects unknown
message versions and the UI ignores unknown response kinds while retaining the
last known posture.

The worker boundary does not change the feed invariants:

1. A bootstrap stream keeps one `(feedId, epoch, snapshotSeq)` identity across
   all chunks. `last` is the only install boundary; staging is discarded on any
   identity, cursor, validation, or stream error.
2. Deltas that arrive while a bootstrap is staged are buffered and replayed only
   after the atomic install. A gap or retention failure follows the existing
   quarantine/skew and re-bootstrap ladder.
3. Cross-tab relay remains a delivery optimisation, not a second replica owner.
   Bootstrap/resync ownership stays with the socket-bearing worker; relayed
   frames retain their feed identity and dedupe/order checks.

## Safe first tranche

The worker migration is intentionally preceded by a cooperative transport
boundary:

- Current-wire server bootstraps are emitted in chunks of at most 200 rows.
  Every chunk repeats the snapshot cursor and feed identity, and only the final
  chunk has `last: true`. Legacy wire-v1 keeps its single translated snapshot
  until that adapter can represent a stream without changing its install point.
- `SocketHub` recognizes the canonical feed envelope without parsing it, queues
  one feed frame per macrotask, and leaves control, terminal, and legacy messages
  on their existing synchronous route. `PushedBootstrapSource` retains chunks
  from one stream in order while still superseding an older world.
- Feed tasks expose timing telemetry through `feedTask` and `feedBudget()`:
  16.7 ms is the per-task main-thread budget (one 60 Hz frame), and 50 ms is
  the interactability/long-task budget. These are diagnostic counters now; the
  worker protocol will carry them to the same acceptance probe after migration.

This tranche preserves atomic install, concurrent-delta buffering,
quarantine/skew reporting, and cross-tab forwarding. Moving socket and
IndexedDB ownership into a worker is the next change because it needs the
versioned worker message protocol and explicit lifecycle handoff; doing that
without those contracts would create a second cache owner rather than remove
the browser UI's work.

## Acceptance evidence

The server feed test proves a large current-wire bootstrap is split into ordered
chunks with one cursor and one final install marker. Client tests prove that a
feed frame is not delivered synchronously, that each queued stream chunk is
retained, and that feed-task budget telemetry is emitted. Existing replica,
skew, and cross-tab tests remain the authority for the invariants listed above.
