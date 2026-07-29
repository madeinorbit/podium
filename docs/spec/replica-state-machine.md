# Replica state machine (kernel, in-memory)

**Status:** implemented · POD-369 (Phase 2 / POD-289) · 2026-07-30
**Implements:** [ADR 2](../adr/0002-sync-protocol.md) as amended by
[ADR 2 Amendment 1](../adr/0002-sync-protocol-amendment-1.md) (D12–D17); storage port per
[ADR 6](../adr/0006-replica-storage.md) D3; overlay locality per
[ADR 4](../adr/0004-representation-policy.md) D7.
**Code:** `packages/sync/src/replica/` · **Lint:** `scripts/check-boundaries.ts` rule 9

This document is the reader's map of the module. The **normative** table lives in code, as
data, at `packages/sync/src/replica/transition-table.ts`, and `replica.test.ts` fails if any
row of it is never driven. A table in a document drifts; a table the tests iterate cannot.

---

## 1. What this component is, and the one thing it must never become

The Replica applies an ordering somebody else decided. It holds a cache of Authority truth
plus a derived optimistic overlay, and it arbitrates **nothing**:

- It never resolves a conflict. `revision` is an opaque authority-assigned token it stores
  and echoes — never compares to pick a winner (ADR 2 D3).
- It never invents an id and never promotes a local guess to fact.
- **It never evaluates visibility.** There is no principal, owner or grant anywhere in the
  module. The Authority computes the principal's slice; the Replica applies it. A replica
  that can answer *"may this principal see X"* is a second, untrusted authorization
  surface (ADR 2 Amendment 1 D12.7, ADR 3 D7).

Both halves are enforced structurally, not by convention: boundary-lint rule 9 restricts the
module's imports to its own directory and rejects arbitration/visibility evaluation verbs in
its (comment-stripped) source.

## 2. Shape: delta-first, with bootstrap as the recovery case

Steady state is *apply certified frames in seq order*. Bootstrap is the recovery path that
**every** rung of the D7 ladder terminates at — which is what keeps it the most-exercised
code in the system rather than a rarely-tested emergency path (ADR 2 D6/D7).

The cursor is ADR 2 D1's triple `(feedId, epoch, seq)`, never a bare integer. `epoch` is an
opaque generation id compared **by equality only**.

Every frame carries a **covered range** (Amendment 1 D13):

> "I have evaluated every global `seq` in `(fromSeq, seq]` against your principal, and
> `changes` contains exactly those you may see."

The acceptance rule is therefore `fromSeq === cursor.seq`, not "the first change is
`cursor + 1`" — strictly stronger, because an explicit lower bound also catches a frame that
vanished between two others. An **empty** `changes` array is a **watermark**: a legitimate
cursor advance over a range this principal may not see. Under private-by-default it is the
normal frame, not an exception, which is exactly why it is the same frame on the same ordered
pipe rather than a second control message.

## 3. Postures

| Posture | Meaning |
|---|---|
| `cold` | No slice installed, not connected. |
| `bootstrapping` | Walking a chunked bootstrap; concurrent frames buffer. |
| `live` | Cursor valid, connected, applying frames. |
| `healing` | A gap was detected; `changesSince` is in flight. |
| `stale` | Disconnected, still serving the last-known slice. |

## 4. The healing ladder — one terminal path

| Rung | Detection | Response |
|---|---|---|
| 0 | `feedId`/`epoch` match, `fromSeq === cursor` | Apply (including the empty/watermark case). |
| 1 | **Gap** — `fromSeq > cursor` | Do not apply. Buffer, `changesSince(cursor)`. |
| 2 | **Compacted**, **`resync-required`** (D9 backpressure), **`rescope`** (D14.4 rights change), cold start | Re-bootstrap, scoped. |
| 3 | **Malformed** frame or non-contiguous reply | Do not apply, do not advance. Re-bootstrap. |
| 4 | **Feed/epoch mismatch** | Discard entirely. Re-bootstrap. |
| 5 | **Local corruption** | Clear the cache. Re-bootstrap cold. |
| 6 | **Replica schema bump** | Discard. Re-bootstrap. |

Two rows are **derived**, not quoted — the ADR does not decide them, and the module resolves
them the way most consistent with D13 (see the module header for the full argument):

- `frame.seq <= cursor.seq` (wholly re-delivered) → **ignore**. Our cursor already certifies
  that range. Reading it as a gap would heal-loop forever, the same failure D13 exists to
  prevent, arriving from the other side.
- `fromSeq < cursor.seq < frame.seq` (partial overlap) → apply the **uncovered tail** only.
  This is the truncation D6.3 already requires for a frame straddling the snapshot point.

### 4.1 The outbox survives every rung

ADR 2 D7 calls this the most dangerous sentence in the ADR. ADR 6 co-locates entities,
cursor, overlay **and** the outbox in one transactional store, so "clear the store" reads as
one innocent operation and is in fact two: discarding a **cache** (free) and discarding **the
user's unsent writes** (data loss). Under private-by-default a `rescope` fires whenever
somebody's shares change, so this is now a **normal-path** event — a drop-the-outbox bug is
reachable by a colleague clicking *share*.

The defence is structural. `ReplicaCacheStore` has no outbox method, so `discardCache()`
**cannot** reach the outbox — not "must not", cannot. A storage adapter implements both ports
over one physical store and one transaction, and hands the Replica only the cache port. Every
rung funnels through one function (`Replica.rebootstrap`), so the rule is a property of one
code path rather than of six call sites where one forgets. `replica.test.ts` asserts the
outbox survives **per rung**, not for one representative rung.

A queued command is a request against an **entity**, not against a feed position. A rescope
never makes it moot; deciding that it did would be the Replica arbitrating.

## 5. Stale-visible posture, and what it means under scoping

On disconnect the Replica keeps serving what it last held, marked stale. Disconnection is not
data loss, and rungs 2–6 must never blank the UI before the replacement state is installed —
which is what D6's atomic swap makes possible.

**Under multi-user this has a consequence that is accepted and is documented here rather than
patched:** while offline, the Replica may still be showing rows that a revocation has since
removed. That is a **stale read**, of the same class as any other stale read, and it is
explicitly *not* corrected locally:

- The Replica does **not** expire visibility on a timer. Deciding that a grant has probably
  lapsed would be the Replica evaluating visibility — the one thing it may never do.
- Convergence happens on **reconnect**, and only from the Authority: it resumes from its
  cursor and the correction arrives either as an `evict` (the cheap incremental path) or as a
  `rescope` → rung 2 → scoped re-bootstrap (the terminal path). Both are tested.
- Watermark traffic is proof of **liveness**, not silence (D13). A connected replica whose
  principal sees nothing still advances. Only a *disconnected* replica is stale.

## 6. The removal family — three members, and evict is the third

| Mechanism | Wire | Means | Scope | Reversible |
|---|---|---|---|---|
| Domain soft-delete | `upsert` with `deletedAt` | "deleted, recoverable" — domain state | Global | by domain action |
| Tombstone | `op: 'remove'` | "gone from your replica" | Global | no |
| **Eviction** | **`op: 'evict'`** | **"gone from *your view*" — it exists, for others** | **Per-principal** | **by grant** |

An `evict` drops the entity from the cache and from derived views and does **nothing else**:
no domain "deleted" event, no tombstone, no deletion affordance. The model keeps the two
apart after the fact too — `Replica.exitKind()` returns `'evicted'` vs `'removed'` — because
"a colleague unshared this" and "someone deleted this" are the same pixels and must not be
the same fact. Re-admission needs no new op: an `upsert` whose `revision` has **not** moved is
still a valid upsert, and it is flagged `readmitted` so a client does not render it as a
creation.

## 7. Scoped bootstrap

D6's shape is unchanged; only *which rows the Authority reads* changed (D15).

1. Chunked, in the same `MetadataChange` shape — new entity kinds stay free on this path.
2. **Delta buffering** for the duration. The buffering rule is stated over **frames**, never
   over ops, so watermarks and evicts are covered by construction rather than by remembering
   to list them.
3. **Atomic install**: the staged slice replaces the cache (this *is* the D7 discard), the
   buffered frames apply on top, and the cursor commits — one transaction. No half-installed
   replica, and no window holding a mixture of two principals' slices.
4. Failure discards staging and **restarts** (resumable bootstrap stays deferred). An
   exhausted bootstrap parks `stale` with the previous slice still visible.

The slice includes **per-user state rows** (POD-1076, keyed by `userId` and `entityId`).
The Replica does not interpret that key — they are ordinary entity kinds, which is exactly
what D4's lenient-parsing rule buys.

## 8. Ports, and what is deliberately not here

| Port | Owner |
|---|---|
| `ReplicaCacheStore` — entities + cursor, atomic batches, atomic install | ADR 6 D3; POD-374 (IndexedDB) / POD-375 (mobile SQLite) supply durable adapters |
| `AuthorityReadPort` — `changesSince`, chunked `bootstrap` | POD-305 (Authority), POD-1077 (scoping), POD-373 (wiring) |
| `OptimisticOverlayPort` — `pending` / `reduce` / `retire` | **Declared only.** POD-372 derives overlays from contract reducers; POD-351 ships the first real contract |

The overlay is **derived, never stored twice** (ADR 4 D7): it is a function of (authoritative
base, pending commands). Nothing persists an overlay row, which is also why a re-bootstrap
cannot lose one — the outbox survives, so the overlay simply recomputes. Retirement is exact,
via envelope provenance (`causationId`/`mutationId`, ADR 2 D8), never by value comparison;
comparing values would be arbitration.

Not here, on purpose: the wire codec (POD-308 maps the pre-cutover protocol shape onto these
kernel types), the outbox state machine (POD-370 / ADR 3 D9), durable storage, and any
transport.
