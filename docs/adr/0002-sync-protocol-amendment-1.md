# ADR 2 — Amendment 1: the feed becomes per-principal (watermarks, eviction, scoped bootstrap)

- **Status:** Proposed (human gate: POD-359)
- **Date:** 2026-07-29
- **Deciders:** architecture rewrite ADR pack (POD-359); human decisions of 2026-07-28/29
  recorded in `docs/multi-user-readiness.md`; human sign-off before Phase 1
- **Issue:** POD-1072 (ADR 2 amendment: scoped feed watermarks), under epic POD-359
- **Consumers:** POD-289 (Phase 2 sync kernel — gate), **POD-1077** (2.8 watermarked scoped
  feed — the leaf that implements this amendment), POD-305 (Authority), POD-306
  (Replica + Outbox + conformance suite), POD-307 (clients on the kernel Replica),
  POD-308 (wire cutover — **hard ordering constraint, see D17**), POD-337 (measured
  thresholds), POD-387 / POD-317 (plane ports, gateway — the shared subscription primitive,
  ADR 7 Amendment 1 D13; its phase ordering is open item **O6**)
- **Related ADRs:** ADR 1 (ownership matrix; D5 instance identity; amendment POD-1071),
  ADR 3 (principal from transport D7, apply-time re-authorization D8, outbox states D9,
  horizons D10; amendment POD-1073), ADR 4 (representation policy; Amendment 1 D8),
  ADR 6 (replica storage), ADR 7 (plane/message inventory; amendment POD-1074),
  **ADR 9** (identity, ownership and sharing — POD-1070; **sole owner** of principal,
  visibility class, owner and grant vocabulary, which this amendment consumes and never
  defines)
- **Specs:** [spec:SP-3fe2] (strangler rebuild), [spec:SP-0371] (hub deferred),
  [spec:SP-4428] (drizzle-kit)
- **Base tip verified:** `2ddfec21` (issue/279-integration), 2026-07-29
- **File discipline:** this amendment owns **only** this file plus a single "Amended by"
  line in `docs/adr/0002-sync-protocol.md`. No index edits (POD-359 owns
  `docs/adr/README.md`), no ledger edits, no edits to ADR 1 / 3 / 4 / 7 / 9.

---

## 1. Context

### 1.1 The trigger ADR 2 named has fired

ADR 2 D2 ratifies an unscoped firehose and states its premise in one sentence:

> Podium today is single-tenant-shaped … so every client of an authority is entitled to
> the whole feed. Authorization is therefore enforced at the **authority boundary**.

Owners plus explicit sharing move the authorization boundary **inside** the feed. The
premise is gone (`docs/multi-user-readiness.md` §3.1).

D2 also wrote down, correctly and in advance, why this cannot be patched later with a
`WHERE` clause — and named its own trigger:

> Per-client filtering is **incompatible with the contiguity contract** … Filter the
> stream per client and every suppressed row is an *invisible permanent gap* that
> triggers an endless heal loop … if scoping is ever needed (**the trigger is
> multi-tenancy or an entity kind a client must not see**), it MUST arrive with
> **watermarks** … Adding a filter without a watermark is a protocol break, not an
> optimization.

**That trigger has fired.** The human decision of 2026-07-29 (`docs/multi-user-readiness.md`
header block and §3.1) is option **C's mechanism with option B's default**: build the
visibility machinery in Phase 2, and default to private. Every decision below traces to
that record, and each cites the section it comes from.

D2's warning is not being overturned; it is being **obeyed**. This amendment supplies the
watermarks it demanded as the price of scoping, and nothing here is a filter without one.

### 1.2 Not multi-tenancy — no `instance_id`, anywhere

Multi-user in one tenant lives **inside** one Authority, i.e. inside one feed.
**ADR 1 D5 is unaffected**: `InstanceId` remains a *deployment partition*, not a row-level
discriminator, and its "explicit columns reserved only if a future shared multi-tenant
store is adopted" clause is **not** triggered by this requirement
(`docs/multi-user-readiness.md` §2). Nothing in this amendment authorises an `instance_id`
column on `changes`, on any aggregate, on any wire projection, or on any frame field. An
implementer who reads "scoped feed" and reaches for tenant columns has misread this
document. One feed, one `feedId`, one global `seq` — with per-principal *visibility* laid
over it.

### 1.3 What is true today, verified on tip `2ddfec21`

Read out of the code that decides it, not inferred:

- **The fan-out has no filter at all.** `SessionService.sendMetadataDelta`
  (`apps/server/src/modules/sessions/service.ts:3268`) builds one `metadataDelta` frame and
  sends it to every client holding `CAP_METADATA_DELTA`. The only per-client predicate in
  the loop is the capability check.
- **The op vocabulary has exactly two values.** `MetadataChangeOp = z.enum(['upsert',
  'remove'])` (`packages/protocol/src/messages/sync.ts:13`). There is no third op, and no
  frame that means "your view changed".
- **Contiguity is enforced in three independent places, and all three currently reject a
  watermark.**
  1. Live delta: `TerminalConnection.applyDelta`
     (`packages/terminal-client/src/connection.ts:1093`) returns `false` when
     `fresh[0].seq !== cursor + 1`, and `ingestDelta` (line 1070) turns that into
     `healMetadata()`.
  2. Heal reply, per element: `parseChangesSinceResult` rejects the whole result when
     `change.seq !== prevSeq + 1` (`packages/protocol/src/messages/sync.ts:223`).
  3. Heal reply, tail and empty case: the last change's `seq` must equal `result.cursor`
     (`sync.ts:236`), and an **empty** delta must not move the cursor —
     `result.cursor === opts.fromCursor` (`sync.ts:213`).
  Item 3 is the sharpest fact in this section: *an empty delta that advances the cursor is
  exactly what a watermark is*, and today it is a rejection. Failing to amend these three
  checks would produce the endless heal loop D2 predicted — from the client side.
- **The heal path escalates by returning `null`.** `readChangesSince`
  (`packages/sync/src/change-log.ts:134`) returns `null` — meaning "serve a snapshot" — for
  a null cursor, a cursor past the head, a cursor below the retained range, or a corrupt
  row. Head-only pruning keeps the retained range contiguous; `CHANGE_MAX_AGE_MS` is
  3 days (`change-log.ts:37`).
- **There is no owner, visibility, grant or user vocabulary in the system.**
  `apps/server/src/migrations/schema.ts` contains no `owner`, `visibility`, `owner_id` or
  `user_id` column on any table. `client_sessions` (`schema.ts:190`) is
  `token_hash` / `created_at` / `expires_at` — a *device*, not a person.
  `packages/runtime/src/auth-store.ts` has one password per instance (`setPassword` line 93,
  `verifyPassword` line 126) and no accounts. `packages/domain/src/issue-authz.ts:47`
  declares `OPERATOR: Capability = { role: 'admin', scope: { kind: 'all' } }`.
- **The `changes` table carries no principal dimension.** `schema.ts:196` —
  `seq` (autoincrement PK), `entity`, `entity_id`, `op`, `payload`, `event_time`. The log is
  global by construction, which is the property D12 preserves.
- **Domain soft-delete already exists and is a separate mechanism.** `deleted_at` on
  `sessions` (`schema.ts:46`) and `issues` (`schema.ts:391`) — D5's "look identical from a
  distance and are not" pair. D14 adds the third member.
- **Emission is one ordered pipe.** `apps/server/src/modules/funnel.ts:45`: "metadataDelta
  emission is ONE seq-ordered pipe (#256) … NEVER reorders: the client gap rule
  (seq !== cursor+1 → heal) turns any reorder into a heal storm." D13's frame must ride
  that pipe rather than open a second emitter.

### 1.4 What this amendment does and does not decide

It decides the **protocol mechanism**: what a scoped feed looks like on the wire, what
restores contiguity over it, how a visibility change is expressed, and what bootstrap does.

It decides **no policy**. Who owns what, what a visibility class means, which entity classes
are personal, how a grant evaluates, and what an agent principal is — those are **ADR 9**
(POD-1070) and **ADR 1's amendment** (POD-1071). This amendment consumes the word
*principal* and the phrase *the principal's visible set* as terms defined there, exactly as
ADR 2 already consumes ADR 3's principal for the authority boundary.

---

## 2. Decisions

Numbering continues ADR 2's sequence (D1–D11 are the base document's). No existing decision
is renumbered.

### D12 — The feed is **per-principal**. D2's unscoped clause is overturned; everything else in D2 survives

**Decision.** There is still **ONE feed per authority, one globally monotonic `seq` across
all entity kinds, and one cursor per replica.** That half of D2 is re-ratified verbatim and
is not reopened.

D2's second paragraph — *"The feed is **unscoped**: every authorized replica receives every
change. We do NOT add per-client filtering in Phase 2"* — is **overturned**. In its place:

> A replica's stream is the **subsequence of the one global feed that its principal may
> see**. Global `seq` values are **global**: they are never renumbered, densified, or
> re-issued per principal. Visibility is the only per-principal quantity in the protocol.

Consequences that are the *point* of stating it this way, not side effects:

1. **D1 is unchanged.** The cursor remains the triple `(feedId, epoch, seq)`. There is one
   `feedId` and one epoch line for all principals; a scoped replica's `seq` is a position in
   the global sequence, comparable across principals, and epoch mismatch still means reset.
2. **D7's healing ladder is unchanged.** All seven rungs keep their detections and their
   responses; D14 adds one new *cause* that resolves to rung 2, and adds no rung.
3. **D3 is unchanged.** `revision` is per-entity authority truth and is **never** moved by a
   visibility change (see D14's rejected alternatives — this one is a trap).
4. **D5's tombstone-and-retention argument is unchanged in structure** and is re-proved over
   the slice in D16.
5. **D9 is unchanged.** A slow replica is still demoted to resync; D13 adds the rule that
   watermark-only traffic must not be what demotes it.
6. **D10 is unchanged.** The authority still appends one change row inside one transaction.
   Scoping happens at *read/fan-out*, never at *append* — which is precisely why global seq
   can stay global.
7. **The authorization boundary moves inside the feed, and stays server-side.** The
   authority evaluates visibility; the replica never filters, never re-checks, and never
   receives a row it may not see. ADR 3 D7 (principal from authenticated transport only) is
   the input; ADR 3 D8 (apply-time re-authorization) is the write-side twin.

**Rationale.** The cheapest correct scoping is the one that changes the *smallest* number of
protocol properties. Every alternative below buys the same visibility outcome by breaking
something D1–D11 already proved. Preserving the global sequence is what lets the authority
serve N principals from **one** log read, keeps `minAvailableSeq` a single published number,
keeps D8's `originId`/`causationId` meaningful across principals, and keeps the conformance
suite parameterizable across hops (D2's own stated reason for one cursor). The human
decision (`docs/multi-user-readiness.md` header, §3.1) chose sharing-is-real as the default,
so the feed must carry only what you may see — but nothing in that decision requires the
*ordering substrate* to become per-person, and making it so would be a much larger break.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| **Option A — tenant is the read boundary**: keep D2 unscoped, let ownership govern only writes, attribution and UI defaults | Explicitly considered and **not chosen** by the human decision of 2026-07-29 (`docs/multi-user-readiness.md` §3.1 fork table, and the header block). It is also self-undermining as a product: the stated goal is a personal sidebar ("my tasks"), and under A the privacy exists only in the UI while the wire still carries everyone's work to every device. A privacy property that holds only in a render function is not one. |
| Defer scoping past the POD-308 wire cutover | The cursor shape, the frame shape and the op vocabulary are all **persisted on both sides**. Deferring buys a second protocol migration over exactly the surfaces this programme exists to stop re-migrating — see D17. |
| Per-principal `seq` renumbering (give each principal a dense sequence) | Turns one sequence into N. Breaks D1 (a `seq` would no longer identify a position in *the* feed), breaks D5's single published `minAvailableSeq`, breaks D8's cross-principal provenance, breaks D10 (the authority would have to append N rows in the write transaction, or maintain N counters outside it), and makes one log read unable to serve two connections. All of that to avoid the sparse seqs that D13 makes harmless. |
| Scope only "must-not-see" kinds and leave the rest unscoped | ADR 1 D6 already forbids secrets from replicating **at all** — that is not scoping, it is exclusion. A partial scope still needs the full watermark mechanism (any suppression at all breaks contiguity), so it pays the whole mechanism cost for a fraction of the benefit, and leaves the default-closed rule (`docs/multi-user-readiness.md` §3.1.1) unimplementable. |
| Deliver everything and filter at the replica | Puts the authorization boundary on the client, which ADR 3 D7's posture forbids and which no client-side code can be trusted to hold. It also defeats the point: the rows are on the device. |
| Multi-tenant partitioning (`instance_id` discriminator on `changes` and aggregates) | Multi-user is **not** multi-tenancy (§1.2). ADR 1 D5 stays as written; adding tenant columns solves a problem nobody has and leaves the actual one — per-person visibility inside one instance — untouched. |

### D13 — Watermarks: every frame certifies a **covered range**; contiguity holds over a filtered view

**Decision.** The unit of the feed becomes a frame carrying an explicit **covered range**,
not a bare list of changes.

**The frame.** Each delta frame (live, and each catch-up reply) carries:

| Field | Meaning |
|---|---|
| `fromSeq` | Exclusive lower bound of the range this frame certifies. |
| `seq` | Inclusive upper bound — already present today as the batch stamp. |
| `changes` | Every change in `(fromSeq, seq]` that this principal may see, in `seq` order. **MAY be empty.** |

Its normative meaning, which is the whole mechanism in one sentence:

> **"I have evaluated every global `seq` in `(fromSeq, seq]` against your principal, and
> `changes` contains exactly those you may see."**

**The replica rule** replaces "the first change's seq must be `cursor + 1`" with:

- Accept iff `fromSeq === cursor` (and `feedId`/`epoch` match, per D1). Otherwise it is a
  **gap** → D7 rung 1, unchanged.
- On accept: apply `changes` in `seq` order, then set `cursor = seq` — **including when
  `changes` is empty**. An empty certified frame is a watermark; it is the normal path, not
  an exception.
- The frame is applied in **one** replica transaction (D10). There is no partially-applied
  frame and therefore no cursor that is ahead of its data.

Note the new rule is strictly **stronger** than the one it replaces: today a frame whose
first change happens to land on `cursor + 1` is accepted even if an earlier frame vanished
between them; an explicit lower bound catches that too.

**A watermark is not a new message class.** It is the same frame with an empty `changes`
array, on the same ordered pipe. This is deliberate: `funnel.ts:45` makes single-emitter
ordering the correctness property, and a second control message meaning "advance" would be a
second emitter into that pipe *and* a path that only fires when something is suppressed —
i.e. a rarely-exercised path in a protocol whose entire posture (D7) is that recovery paths
must be the most-exercised code in the system. Under private-by-default, every frame is a
watermark; the watermark path *is* the normal path.

**Ordering and coalescing guarantees:**

1. Frames for one connection are strictly ordered, ranges are **contiguous and
   non-overlapping**, and `fromSeq` of each frame equals `seq` of its predecessor. Reordering
   is forbidden for the reason `funnel.ts` already gives.
2. Watermark-only frames may be **coalesced**: two adjacent certified ranges `(a, b]` and
   `(b, c]` may merge into `(a, c]` with the concatenation of their change lists. Because
   only the head of a watermark-only run matters, a run of watermarks collapses to one frame
   without loss.
3. Coalescing may **never** reorder, drop, or merge-out-of-order a frame containing visible
   changes. Merging is range-extension only.
4. **Watermark-only frames must not demote a replica (D9).** Because of (2) a suppressed
   firehose collapses to a single pending frame per connection, so the bounded outbound
   queue cannot be overflowed by traffic the principal cannot even see. A replica must never
   be forced to re-bootstrap because of activity it is not allowed to observe.
5. **A liveness floor, not a number.** The authority MUST advance a connected replica's
   covered range within a bounded lag of the global head, even when nothing visible happens.
   The bound is a measured threshold and belongs to POD-337 (this ADR does not invent
   numbers), but its *floor* is derived here: the lag must stay small relative to D5's change
   retention horizon, or a replica with sparse visible traffic falls below `minAvailableSeq`
   and re-bootstraps for lack of news. Under private-by-default that is the **common** case,
   not an edge — which is why the bound is normative even though the value is not fixed here.

**Three shipped validation rules must be amended with it — and this is the load-bearing
part.** Each was written to catch a real class of permanent divergence (D7 ratifies them as
protocol law), and each currently rejects a watermark. They are amended *narrowly*, and only
for frames that carry the covered-range certification:

| Shipped rule | Amendment |
|---|---|
| Live: `fresh[0].seq !== cursor + 1 → heal` (`connection.ts:1098`) | Replaced by `fromSeq === cursor` for certified frames. Retained verbatim for uncertified frames. |
| Heal, per element: `change.seq !== prevSeq + 1 → reject` (`sync.ts:223`) | Within a certified reply, change seqs must be **non-decreasing and inside the covered range**; contiguity is certified by the range, not by adjacency. Retained verbatim for uncertified replies. |
| Heal, empty/tail: empty delta must satisfy `cursor === fromCursor` (`sync.ts:213`); last change's `seq` must equal `result.cursor` (`sync.ts:236`) | For certified replies, `cursor` is the **covered-range head**, so an empty reply MAY advance it and the last change's `seq` MAY be below it. Retained verbatim for uncertified replies. |

The retention of each rule for *uncertified* frames is not politeness — it is what makes an
N-1 peer safe during POD-308's transition: a peer that does not send the certification gets
the old, stricter contract, and the amended contract is unreachable without an explicit
capability. **This is negotiated by capability, not by a `WIRE_VERSION` bump** (D4: additive
fields negotiate by capability; the version moves only for breaking framing changes).

**Replica behaviour over a long watermark-only stretch.** The cursor advances; no entity
changes; no UI change; no heal. Two obligations follow: watermark traffic **is** proof of
liveness and must not be treated as silence by connection-health or stale-badge logic
(D7's "stale-visible, never blank" concerns the *disconnected* case, which is unchanged);
and a disconnected replica gets no watermarks at all, so on reconnect it heals through
`changesSince` and receives a certified reply — or, if its cursor is below
`minAvailableSeq`, rung 2. That path is unchanged.

**Rationale.** D2 already decided that scoping without watermarks is a protocol break; this
decision is the smallest mechanism that satisfies it. Putting the certification on **every**
frame rather than on a special one is what makes suppression indistinguishable in cost from
non-suppression and impossible to forget — the authority cannot filter without also
certifying, because there is only one way to send a frame.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| A separate `watermark` control message, sent only when something was suppressed | Two emitters into the one pipe whose single-emitter ordering `funnel.ts:45` names as the correctness property, plus a path that runs only in the suppressed case — a rarely-exercised recovery path, which is the exact failure shape D7 is built to avoid. It would also need its own ordering proof against deltas; the covered range gets that for free by being on the frame. |
| Infer the advance from the existing `seq` stamp, with no explicit `fromSeq` | Then the replica cannot distinguish "nothing visible in the gap" from "a frame was lost". That distinction *is* the contiguity contract. Without a lower bound the client would advance past dropped frames — the silent permanent divergence `sync.ts`'s checks exist to prevent (#247 rounds 2/3). |
| Piggyback the advance only on the next visible change (no idle watermarks) | A replica whose visible traffic is sparse never advances, falls below `minAvailableSeq` (D5), and re-bootstraps forever. Private-by-default makes sparse the common case, so this is not a tail risk but the normal operating point. |
| Keep the shipped `first === cursor + 1` rule and pad suppressed rows with no-op placeholders carrying ids | Leaks existence — the ids alone reveal that entities you may not see exist and are changing (`docs/multi-user-readiness.md` §3.1.2's existence-leak class). Scoping that publishes the shape of what it hides is not scoping. |
| Per-principal dense renumbering so contiguity is literal | Rejected in D12: N sequences, and the properties D1/D5/D8/D10 lose are worth far more than the sparse seqs this avoids. |
| Skip suppressed frames silently and let the client heal | This is precisely D2's "invisible permanent gap that triggers an endless heal loop", verified live: `applyDelta` returns false → `healMetadata()` → `changesSince` returns the same filtered rows → loop. Named here so nobody re-invents it as a shortcut. |

### D14 — A visibility change is **not** an entity change: `evict` (op) + `rescope` (control frame). `remove` is forbidden

**Decision.** Granting or revoking a share makes entities appear or disappear for a
principal **without the entity's `revision` moving** and without any entity change occurring
at all (`docs/multi-user-readiness.md` §3.1 item 2). The feed cannot express that today. It
gains **two** mechanisms with a strict division of labour, and one prohibition.

**D14.1 — `evict`: a third op, meaning "this leaves *your view*".**
The change op vocabulary becomes `upsert` | `remove` | `evict`
(today: `packages/protocol/src/messages/sync.ts:13`).

- `evict` carries an entity kind and id and **no payload**.
- The replica drops the entity from its cache and from derived views. It **must not**
  surface it as a deletion, must not emit a domain "deleted" event, and must not write a
  tombstone. An entity you can no longer see has not stopped existing.
- `evict` is **per-principal and reversible**: a later grant re-admits the entity (D14.2).
  `remove` is global and terminal.

**D14.2 — Re-admission needs no new op.** A grant is expressed as ordinary `upsert` rows
carrying the entities' current wire values. This is deliberate and must be stated, because
the obvious objection is wrong: **an upsert whose `revision` has not moved is still a valid
upsert.** `revision` is an authority-assigned token the replica never arbitrates on (D3);
byte-equality dedup (`ChangeBaseline`) is *authority-side change detection*, not a replica
constraint. A replica that drops "an upsert I already have at this revision" is fine; a
replica that drops one it has *never* had would be broken. Re-admission is therefore free on
the replica side.

**D14.3 — Anchoring: per-principal rows occupy the seq of the change that caused them.**
The grant or revoke is itself a durable change (the grant edge is an entity owned by ADR 9 /
ADR 1's amendment), so it has a global `seq`. The `evict` rows and re-admitting `upsert`
rows a principal receives are **anchored at that `seq`** and delivered inside the frame whose
covered range contains it. Principals unaffected by the grant simply see that `seq`
suppressed — i.e. as watermark. Two properties follow:

- Anchored rows may **share** a `seq`. Under D13 contiguity is certified by the covered
  range, not by adjacency, so this is well-formed. Uniqueness of `seq` remains a property of
  the **global log**, not of a per-principal frame.
- Visibility changes are therefore **ordered against entity changes**. "Did the revoke
  happen before or after that edit?" has one answer, from the one sequence.

**D14.4 — `rescope`: a per-principal control frame resolving to D7 rung 2.**
When the visible set changes by more than a bounded amount — a role change, an owner
transfer of a subtree, a revoke whose affected set cannot be enumerated cheaply, or simple
queue pressure — the authority sends `rescope` instead of enumerating. The replica's
response is **rung 2 of the D7 ladder: re-bootstrap, scoped (D15)**. No new rung, no new
recovery path.

- `rescope` is **always** legal in place of D14.1/D14.2. The authority may take the terminal
  path at any time; the ladder still resolves strictly downward.
- ADR 7 classifies it as a control-plane frame, alongside D9's `resync-required`.
- The two must be **distinguishable in telemetry**: `resync-required` means the authority
  shed load; `rescope` means the principal's rights changed. Collapsing them makes an authz
  event look like a performance event, and a re-bootstrap storm after a policy change would
  be misdiagnosed as backpressure.
- **The outbox survives `rescope` exactly as it survives every other rung** (D7's outbox
  rule). A rights change is not a licence to discard the user's queued writes; ADR 3 D8
  decides those writes at apply time, and a rejection is surfaced (ADR 3 D9), never silently
  dropped.

**D14.5 — `remove` MUST NOT be reused for eviction.** Normative, and the reason is D5's own
warning arriving a third time.

D5 already names a pair that "look identical from a distance and are not": a **domain
soft-delete** (`sessions.deleted_at`, `issues.deleted_at` — verified at
`apps/server/src/migrations/schema.ts:46` and `:391`), which replicates as an `upsert`, and a
**tombstone** (`op: 'remove'`), which means "this entity is gone from your replica".
**Eviction is the third member of that family**, and the family should be read as a whole:

| Mechanism | Wire | Means | Scope | Reversible |
|---|---|---|---|---|
| Domain soft-delete | `upsert` with `deletedAt` set | "deleted, recoverable" — domain state (ADR 1) | Global | Yes, by domain action |
| Tombstone | `op: 'remove'` | "gone from your replica" — the entity no longer exists | Global | No |
| **Eviction** | **`op: 'evict'`** | **"gone from *your view*" — it exists, for others** | **Per-principal** | **Yes, by grant (D14.2)** |

Reusing `remove` would make the replica render a *revoked share* as a *deletion*: the entity
would disappear as deleted from derived views, from counts, from any UI that distinguishes
"gone" from "not yours", and a later re-grant would read as a resurrection. Worse, the lie is
type-correct and silent — exactly the class of error the pack keeps catching by naming
mechanisms that look alike. Naming the third member now is cheaper than discovering it after
the cutover.

**Rationale.** Both mechanisms are required, and neither alone is adequate. Rescope-only
means a single unshare re-bootstraps the entire slice; under private-by-default,
share/unshare is a *normal product action* (`docs/multi-user-readiness.md` header block), so
the common case must be cheap. Evict-only means an unbounded visibility change (a role
change touching everything) must be enumerated row by row, which is unbounded work on the
fan-out path. Pairing a cheap incremental path with an always-available terminal one is the
same shape D9 already uses for backpressure, and it keeps D7's "every failure resolves
downward" intact.

**A note on ADR 4 D7.2.** Evict/re-admit enumeration is per-principal work, but it is
O(entities whose visibility changed) on a **grant/revoke event**, not O(entities) on every
write. ADR 4 D7.2's prohibition is on the write/publish/fan-out path per change; this does
not enter it. Visibility *evaluation* per frame is the cost that does touch fan-out, and it
is bounded by caching the principal's visible-set predicate keyed by the grant edges (whose
changes are themselves feed rows, so invalidation is exact). Thresholds are POD-337's.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Reuse `op: 'remove'` for revocation | D14.5. The replica renders it as deletion; D5 already warns the pair looks identical from a distance; this is the third member of that family and would be indistinguishable from the second at exactly the moment the distinction matters (a colleague unshared an issue vs deleted it). |
| Silently stop sending the entity | The suppressed-row invisible gap, verified live at `connection.ts:1098` → `healMetadata()` → same filtered rows → loop forever. D2 named it; D13 exists to prevent it. |
| Bump the entity's `revision` on grant/revoke so the change rides the normal path | `revision` is per-entity truth (D3). Moving it for a per-principal event lies to **every other replica** (they see a revision bump with no content change), invalidates ADR 4 D7.3's revision-keyed replica-side view caches instance-wide, and breaks `expectedRevision` preconditions (ADR 3 D13) for writers who did nothing wrong — their in-flight command is rejected because someone else's share changed. |
| `rescope` only; no `evict` | One unshare costs a full scoped re-bootstrap. Under a private default, unshare is routine, so the routine action would take the heaviest path in the protocol. It would also make `evict` a thing invented ad hoc later, after the wire is frozen. |
| `evict` only; no `rescope` | An unbounded visibility change (role change, subtree owner transfer) would have to be enumerated. Unbounded work with no terminal fallback is precisely what D9 refuses for backpressure. |
| A separate per-principal visibility feed with its own cursor | Two cursors and a cross-feed ordering problem — "did the revoke land before or after that edit?" would have no answer. D2's single-seq rationale applies verbatim: the entities are not independent, so their feeds cannot be either. |
| Express visibility changes as global log rows visible to everyone | A per-principal event would burn global seq for every principal and tell every other replica that *someone's* access changed — an existence leak by construction, and O(principals) log growth. |

### D15 — Bootstrap is per-principal; D6's shape is unchanged

**Decision.** D6 stands as written. The authority reads its **scoped slice** — the entities
the principal may see — at a definite `(feedId, epoch, seq)`, and streams it as ordered
chunks of the same change shape. Everything else in D6 is untouched
(`docs/multi-user-readiness.md` §3.1 item 3):

1. Chunked, in `MetadataChange` shape — so new entity kinds stay free on the bootstrap path.
2. **Delta buffering** with `seq > snapshotSeq` for the duration — and the buffered deltas
   are the **already-scoped, already-certified** frames of D13, so there is no second
   filtering step at install and no chance of installing an unfiltered buffer.
3. **Atomic install** — staging swapped in, buffered deltas applied in order, cursor
   committed, in one transaction (D10). No half-installed replica; no window in which the
   replica holds a mixture of two principals' slices.
4. **Paced** — the inter-chunk delay and per-pass byte budget are unchanged, and the
   reconnect-storm requirement stands. Scoping *shrinks* the average bootstrap but does not
   relax the pacing rule; a grant to a large subtree can produce a large rescope-bootstrap,
   which is the reconnect-storm case arriving by a new route.
5. Failure discards staging and restarts. Resumable bootstrap stays deferred.

**Rescope-bootstrap is the same path.** D14.4's `rescope` resolves here, so the scoped
bootstrap is exercised by every cold start, every epoch bump, every quota clear, every
backpressure demotion **and** every large share change — which is the property that keeps it
the most-tested path in the system rather than an authorization-only special case.

**Rationale.** The scoping decision changes *which rows the authority reads*, and nothing
about how they are transferred. Recording that explicitly is the point: the temptation after
adding scoping is to give bootstrap its own scoped endpoint, and that would fork the read
path in a place D6 deliberately unified ("bootstrap and delta stop being two ways to learn
the truth and become one way at two rates").

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Bootstrap unscoped, then evict down to the slice | Ships the whole world to every client on the most-used path in the protocol, and does it during recovery. The leak would be complete and permanent (the rows are on the device); the eviction afterwards is cosmetic. |
| A separate scoped-snapshot endpoint alongside the existing one | A second read path with its own authorization surface, i.e. a second place to get authz wrong, and it would be the *rarely* exercised one. Same reasoning ADR 4 Amendment 1 D8 gives against a per-principal server-side join path. |
| Filter chunks at the gateway rather than at the authority read | Re-introduces per-principal work on the path D6 requires to be paced, and puts a visibility decision outside the authority, which ADR 3 D7/D8's posture reserves to it. |
| Keep the monolithic product-typed snapshot and add a per-principal `WHERE` | D6 already deleted that arm for growth reasons (POD-181); adding scoping to it would re-freeze the per-entity-kind array shape (`SyncChangesSinceResult`, `sync.ts:124`) at exactly the moment a new per-user state family (ADR 1 amendment) is about to arrive. |

### D16 — Retention and compaction under scoping: D5's proof, re-proved over the slice; and the op-stream constraint

**Decision.** Two things, both constraints, neither building anything.

**D16.1 — D5's safety argument holds per principal, unchanged in structure.** The proof
steps re-read over the slice:

1. Pruning is still **head-only**, on the one global log, so the retained range is still
   contiguous. Unchanged.
2. A replica below `minAvailableSeq` still cannot be served a delta
   (`change-log.ts:134`). `minAvailableSeq` is a **global** number and is published to every
   principal, unchanged — it is a property of the log, not of a view.
3. The bootstrap snapshot is still **positive state**, now the principal's positive state
   (D15). An entity that was deleted is absent; an entity the principal may not see is
   *also* absent. **So a missed `evict` heals exactly the way a missed tombstone heals** —
   the replica past the window gets a snapshot that simply lacks the entity.

Therefore `evict` rows are head-pruned with everything else and need no special retention.
D13's liveness floor is what makes this comfortable rather than tight: a scoped replica must
be watermarked forward so that sparse *visible* traffic does not push it below the horizon
and force needless re-bootstraps.

**D16.2 — The op-stream constraint (recorded, not built).** ADR 1's amendment (POD-1071)
reserves an `op-stream` conflict class for collaborative text
(`docs/multi-user-readiness.md` §4). ADR 2 owes it one constraint, because D5's proof depends
on the snapshot being *positive state*:

> A document whose truth is a stream of ops is **not** positive state, and head-pruning its
> ops would leave a replica with an incomplete document that no snapshot repairs. An
> op-stream entity therefore keeps D5 intact **only if** it carries its **materialized
> value** plus a **bounded recent-op tail** — so the bootstrap snapshot remains positive
> state and the tail is what head-pruning is allowed to eat. Anything else is log compaction
> beyond head-pruning, which ADR 2 already parks as needing its own ADR.

This is a precondition on whoever builds the class, not a decision to build it. Concurrent
text editing stays deferred and unblocked.

**Rationale.** D5's proof is one of the pack's load-bearing arguments and it was written for
a global feed with two ops. Both the third op and the prospective op-stream class touch its
premises, and an unstated proof is one an implementer will assume still holds.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Retain `evict` rows longer than ordinary changes ("so nobody misses a revocation") | Confuses the feed with a security log. A replica that misses an evict is past the window and re-bootstraps into a slice that does not contain the entity; retaining the row buys nothing and breaks the uniform head-only pruning D5's proof requires. |
| Prune op-stream ops by age like ordinary changes | Ops are *deltas of a document*; pruning them leaves a document the snapshot cannot repair, which is the exact hole head-only pruning is proved not to punch. |
| Keep whole op histories forever | Unbounded, and it is the log-compaction problem ADR 2 already parks — deciding it here by accident would be the sloppiest possible way to acquire it. |
| Say nothing and let the op-stream owner discover it | This document is where D5's proof lives. A constraint on a proof belongs next to the proof, not in the amendment that later violates it. |

### D17 — The machinery is **load-bearing from day one**, and it lands **before POD-308**

**Decision.** Two clauses, both normative, both gate conditions rather than aspirations.

**D17.1 — Load-bearing from day one; conformance is a Phase-2 gate condition.**
Because the default is **private** (`docs/multi-user-readiness.md` header block: "C's
mechanism with B's default"), there is **no grace period** in which watermarks, evictions and
share/unshare events are inert. They carry the product's **normal path** from the moment the
POD-308 cutover lands: on a private-by-default instance with more than one principal, most
frames are watermarks and most sidebars are slices. Conformance coverage for them is
therefore a **gate condition on POD-289**, not a follow-up on POD-290.

POD-306's conformance suite gains these three cases, named so they cannot be quietly
descoped:

1. **Grant / revoke mid-session.** A live replica gains and loses entities **without the
   entities' `revision` moving**. Assert: re-admission arrives as `upsert` and installs
   (D14.2); revocation arrives as `evict` and does **not** surface as a deletion or a
   domain-delete event (D14.5); the cursor stays contiguous across both; and a subsequent
   grant re-admits the same entity (reversibility).
2. **Scoped gap heal.** A replica whose visible traffic is sparse: a long watermark-only
   stretch that advances the cursor, then a forced heal, then a heal whose reply spans a
   suppressed range. Assert: no endless heal loop (the D2 failure mode, reproduced against
   the amended `parseChangesSinceResult` rules); the replica does **not** re-bootstrap for
   lack of visible traffic inside D5's horizon; and an uncertified reply is still rejected by
   the old rules (D13's retention clause).
3. **Revoked while offline with queued writes.** ADR 3 D8 already re-authorizes on every
   apply including outbox replay — the suite must **prove** it, not assume it. Queue writes
   offline, revoke the principal's access, reconnect. Assert: the writes are **rejected and
   surfaced** (ADR 3 D9), never silently applied and never silently dropped; the outbox
   survives the resulting `rescope` → rung 2 → scoped re-bootstrap (D7's outbox rule).

ADR 2's existing conformance list (epoch bump mid-session, bootstrap interrupted mid-chunk,
slow-consumer demotion asserting convergence, receipt-pruned replay, reconnect storm) is
**re-run under a scoped feed**, not replaced: each of them acquires a second principal.

**D17.2 — Ordering: all of this lands before the POD-308 wire cutover.**
The covered-range certification, the `evict` op and the `rescope` frame are **wire shape**,
and the cursor semantics they imply are **persisted on both sides**. Landing them after
POD-308 means a second protocol migration over the same surfaces — and this programme exists
because of half-finished migrations (`docs/multi-user-readiness.md` §1, §5). POD-308's N/N-1
edge adapter is an **expiring** shim with a Phase-7 deletion deadline (D6's consequences,
registered in the deletion audit); it exists to carry a transition between two decided
protocols, not to carry an undecided one. Using it to defer this work would make the
adapter permanent, which is the specific outcome its deadline exists to prevent.

**Rationale.** The pack's habit is to state the bar where it can be checked. "Build the
machinery in Phase 2" without "and prove it in the Phase-2 gate" is how a mechanism ships
untested behind the product's normal path — and under a private default, untested here means
untested on the path every user takes.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Ship scoping behind a flag, default off, harden later | There is no default-off. Private-by-default means the machinery carries the normal path at the cutover (`docs/multi-user-readiness.md` header). A flag would mean the tested configuration is the one nobody runs, and the shipped one is the one nobody tested. |
| Treat grant/revoke conformance as a Phase-3 (POD-290) follow-up | Phase 3 is *after* POD-308. The wire would be frozen against a mechanism nothing had exercised, and the first bug found would need a protocol change to fix. |
| Land the mechanism in Phase 2 but the `evict` op in Phase 3 | The op is wire shape. Adding a third value to a persisted enum after the cutover is a migration of every replica and every N-1 peer, to save writing one case in a switch now. |
| Let POD-308's adapter carry the transition to scoping later | The adapter is an expiring edge shim with a registered deletion deadline. Loading an undecided protocol onto it converts a temporary object into a permanent one — the failure mode the deletion audit exists to catch. |

---

## 3. Deliberately open — recorded, not answered

These are open in `docs/multi-user-readiness.md` and are **not** decided here. Each is listed
with the protocol question ADR 2 will owe once the policy lands. **This amendment must not
pre-empt them:** each is a *policy* call, and the mechanism above is deliberately neutral to
all four answers.

> **Numbering is the pack's canonical open list — ADR 9 §3** (POD-359 reconciliation, 2026-07-29).
> **O5** (host-local credentials under a `use` grant) and **O6** (phase ordering of the one
> subscription primitive) raise no ADR 2 protocol question and are therefore absent below, not
> closed.

| # | Open question | What ADR 2 will owe once it is answered | Who decides | When |
|---|---|---|---|---|
| **O1** | **Which existence facts leak** — counts, machine session lists, "this worktree is in use", lock holders, issue ref-letter allocation (`docs/multi-user-readiness.md` §3.1.2) | Whether the covered range itself is an existence side channel (its *width* is observable, so "a lot happened that you cannot see" is inferable), and if so whether watermark ranges must be quantized or padded. The mechanism works either way; the answer only constrains coalescing policy (D13.2). | Feature owner per surface, against ADR 9's visibility classes; human where it is a product call | Phase 3 policy (POD-290). The consistent-error rule for the write side is already fixed upstream (`docs/multi-user-readiness.md` §3.1.5) |
| **O2** | **Cross-boundary graph edges**: hide the edge, or show an opaque reference (§3.1.2) | Whether an invisible endpoint of a visible edge is simply absent from the slice, or whether the slice must carry a redacted stand-in row — which would be a fourth thing on the feed and would need its own op or projection. ADR 3 D5 redaction and ADR 4 Amendment 1 O2 are the nearer homes. | Human + feature owner — it is a policy call, because the opaque form leaks existence | Phase 3 policy (POD-290), before any issue-graph wire change |
| **O3** | **Is `reparent` a permission-affecting operation**, given that subtree scope is dynamic (§3.1.5 case 2) | Nothing new in the mechanism: a reparent that widens or narrows a scope simply produces a visibility change, and D14 already expresses it (`evict` / re-admit, or `rescope`). What is undecided is whether it requires confirmation — an ADR 3 D2 confirmation shape, not a feed change. | Human, on the tracker's behaviour | Phase 3 (POD-290); surfaced in UI at the latest |
| **O4** | **Per-class owner/grant inheritance on create** (§3.1.2, §3.1.3 A4) | Only the *timing* of the visibility change: if a child inherits its parent's grants, its creation is already visible to the parent's grantees and needs no separate visibility event; if it inherits the actor's, a subsequent share produces one. Both are already expressible. | ADR 1's amendment (matrix annotation) + per-class feature owner | Declared per class as classes land; annotation shape at Phase 1 (POD-304) |

Two further items are open but are **measurements, not policy**, and are routed rather than
decided: the **idle-watermark lag bound** (D13.5) belongs to POD-337's measured thresholds
alongside sync lag and bootstrap time; and the **enumerate-vs-`rescope` bound** (D14.4) is an
authority tuning parameter for POD-305, not a protocol constant.

---

## 4. Forward references this amendment does not execute

Recorded here because they belong to other owners, per the pack's one-owner rule.

1. **ADR 4 D7.3's rationale must narrow.** Its rejected-alternatives table rejects a
   server-side IVM engine with the clause *"the client already holds the world"*
   (`docs/adr/0004-representation-policy.md`, D7 rejected-alternatives, line 306). Under D12
   the client holds **its slice**. D7.3 should be **kept** — replica-side joins still work
   within the slice, and a join that would cross the visibility boundary is a join the
   principal may not see anyway — with the sentence amended.
   **Status: already carried.** `docs/adr/0004-representation-policy-amendment-1.md` D8
   (integrator-authored under POD-359) makes exactly this narrowing. **This amendment does
   not edit ADR 4**, and no further action is owed unless that amendment changes.
2. **ADR 2's Deferred list.** The bullet *"Per-client feed scoping. Not needed while
   single-tenant-shaped. Requires watermarks (D2); the trigger is multi-tenancy or a
   must-not-see entity kind."* is **struck**. It is not silently deleted: **its own stated
   trigger fired** (§1.1), and the work it deferred now lives in D12 (scoped feed), D13
   (watermarks), D14 (visibility events), D15 (scoped bootstrap) and D17 (timing and gate),
   with the policy in ADR 9 (POD-1070) and ADR 1's amendment (POD-1071), scheduled at Phase 2
   (POD-289) before POD-308. The "Amended by" line inserted into
   `docs/adr/0002-sync-protocol.md` names the bullet explicitly so the base document points
   at its own supersession. **Status: done.** POD-359 struck the line in place at
   reconciliation (2026-07-29), keeping the original text visible as strikethrough with a dated
   pointer to D12–D15/D17 — no decision was required, only the edit.
3. **ADR 7 classifies `rescope`** as a control-plane frame alongside D9's `resync-required`
   (POD-1074 / ADR 7's message inventory). This amendment states the requirement and the
   telemetry distinction; it does not add rows to ADR 7's inventory.
   **Status: already carried.** `docs/adr/0007-plane-inventory-amendment-1.md` D16.3 classifies
   both the watermark and the rescope/evict family as **C/e** on the funnel's ordered pipe, never
   stream, and explicitly forbids reusing `remove`. Its reconciliation note records that D13's
   watermark is a field on the existing delta frame rather than a new frame, so ADR 7's inventory
   gains a row for `rescope` only. No further action is owed unless that amendment changes.
4. **ADR 9 owns the vocabulary** this amendment consumes — principal, visibility class,
   owner, grant, and the default-closed classification rule
   (`docs/multi-user-readiness.md` §3.1.1). ADR 2 defines none of them and must not.
5. **ADR 3 D10 remains the sole owner of the outbox horizon.** No number is restated here;
   D11's inequality is unchanged, and D14.4's outbox-survives-rescope clause adds a *cause*,
   not a value.

---

## 5. Consequences

### Positive

- D2's warning is honoured rather than overturned: scoping arrives **with** the watermarks
  D2 said were its precondition, so the protocol break it predicted does not happen.
- The change is confined to visibility. D1's triple, D3's revision, D5's proof structure,
  D6's transfer shape, D7's ladder, D8's provenance, D9's demotion, D10's transaction and
  D11's inequality all survive verbatim — which is what makes this affordable at all.
- The scoped bootstrap is reachable from an authorization event (`rescope`), so the
  most-tested path in the protocol acquires one more reason to be exercised rather than a
  parallel special case.
- Private-by-default becomes a property of the **wire**, not of a render function: a device
  never holds rows its principal may not see, which is also what makes the personal sidebar
  honest on a shared machine.
- Doing it now costs a frame field, an enum value and a control frame. Doing it after
  POD-308 costs a second migration of every persisted cursor, every replica store, and every
  N-1 peer.

### Cost

- Every frame now carries a covered range, and the authority evaluates a per-principal
  predicate per frame. That is real work on the fan-out path (bounded by caching keyed on
  grant edges, whose changes are themselves feed rows); thresholds belong to POD-337.
- Three shipped validation rules — the ones D7 explicitly ratified as protocol law and told
  implementers not to relitigate — are amended. They are amended *narrowly and by
  capability*, but this is the highest-risk edit in the amendment and it lands in the code
  path where every past mistake produced silent permanent divergence.
- POD-306's conformance suite grows a second principal in every existing case, plus three
  new ones (D17.1), and those are gate conditions rather than backlog.
- POD-305 gains visible-set evaluation, watermark emission with a liveness bound, and the
  enumerate-vs-`rescope` decision — none of which exist in any form today.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Someone "just adds the filter" and skips the watermark, or lands the filter first and the watermark second | D13's frame is the *only* way to send a delta after this amendment — there is no uncertified scoped frame. D17.1 makes the scoped-gap-heal conformance case a gate condition, and it fails loudly (endless heal) rather than quietly. |
| The three amended validation rules are relaxed too far, re-opening the divergence classes they were written for | Each is amended only for frames carrying the certification, and retained verbatim otherwise. The amended form is *stronger* on the live path (`fromSeq === cursor` also catches lost frames that today's rule accepts). POD-306 asserts the uncertified path still rejects. |
| `evict` is implemented as an alias of `remove` "for now" | D14.5 is normative and names the three-member family. The conformance case asserts no deletion semantics surface. |
| A replica with no visible traffic re-bootstraps in a loop | D13.5's liveness floor, derived from D5's horizon; asserted by conformance case 2. |
| Watermark traffic is treated as silence by health/stale logic, or as load by backpressure | D13.4 (watermarks must not demote) and D13's replica-behaviour clause (watermarks are proof of liveness). |
| An implementer reads "scoped feed" as "multi-tenant" and adds `instance_id` columns | §1.2 and D12's rejected-alternatives table. ADR 1 D5 is unaffected; POD-304's annotation review rejects tenant columns. |
| `rescope` and `resync-required` are collapsed into one signal | D14.4 requires them to be distinguishable in telemetry; otherwise a policy change reads as a performance incident. |
| Scoping is deferred past POD-308 "because the adapter can carry it" | D17.2, and the adapter's registered Phase-7 deletion deadline. |

### For the phase issues

- **POD-305 (Authority):** visible-set evaluation per principal with grant-edge-keyed
  invalidation; covered-range certification on every frame; watermark emission with a
  liveness bound and coalescing; `evict` emission; the `rescope` control frame and its
  enumerate-vs-rescope bound; scoped bootstrap reads at `(feedId, epoch, seq)`.
- **POD-306 (Replica + Outbox):** `fromSeq === cursor` acceptance; empty-certified-frame
  cursor advance; `evict` application with no deletion semantics; `rescope` → rung 2 with the
  outbox preserved; the three new conformance cases plus a second principal in the existing
  ones.
- **POD-307 (clients):** watermark-only traffic must not read as silence; a re-admitted
  entity must appear without a "created" affordance and an evicted one must not appear as
  deleted.
- **POD-308 (wire cutover):** capability-negotiated certification; N-1 peers keep the
  unamended contiguity rules; **this amendment's mechanism lands first** (D17.2).
- **POD-289 (phase gate):** the acceptance criteria gain scoped feed + watermarks + scoped
  bootstrap, with D17.1's three conformance cases as gate conditions.

---

## 6. Compliance checklist

Additive to ADR 2's decisions. In compliance when:

- [ ] No frame is sent to a replica containing a change its principal may not see, and no
      replica performs visibility filtering of its own.
- [ ] Every delta frame and every catch-up reply carries a covered range; the replica accepts
      on `fromSeq === cursor` and advances to `seq` even when `changes` is empty.
- [ ] `seq` is global everywhere: no per-principal renumbering, no per-principal sequence, no
      second cursor.
- [ ] The three shipped contiguity rules (`connection.ts:1098`, `sync.ts:213/223/236`) are
      amended **only** for certified frames and retained verbatim otherwise, with the
      distinction negotiated by capability and not by a `WIRE_VERSION` bump.
- [ ] A connected replica's covered range advances within the bounded lag even when nothing
      visible happens, and watermark-only frames coalesce rather than accumulate.
- [ ] Watermark-only traffic never demotes a replica under D9 and is never treated as
      silence by liveness/stale logic.
- [ ] `op: 'evict'` exists, is per-principal, carries no payload, is reversible by
      re-admitting `upsert`, and **never** renders as a deletion. `op: 'remove'` is never
      emitted for a visibility change.
- [ ] `rescope` exists as a control frame, resolves to D7 rung 2, preserves the outbox, and is
      distinguishable from `resync-required` in telemetry.
- [ ] Bootstrap reads the principal's slice; delta buffering, atomic install and pacing are
      unchanged; there is no second snapshot endpoint.
- [ ] No entity's `revision` moves because of a grant or revoke.
- [ ] No `instance_id` (or equivalent tenant discriminator) appears on `changes`, on any
      frame, or on any aggregate.
- [ ] No outbox horizon value appears in ADR 2 (ADR 3 D10 remains sole owner).
- [ ] D17.1's three conformance cases pass **before** the POD-289 gate, and the mechanism
      lands **before** POD-308.

---

## 7. Self-verification record

Checked on integration tip `2ddfec21`, 2026-07-29. Every factual claim above was read out of
the artefact named here.

| Claim | Where verified |
|---|---|
| The fan-out has no per-client filter beyond the capability check | `apps/server/src/modules/sessions/service.ts:3268` — `sendMetadataDelta` loops `this.clients.values()` and sends to every client with `CAP_METADATA_DELTA` |
| The op vocabulary is exactly `upsert` \| `remove` | `packages/protocol/src/messages/sync.ts:13` — `MetadataChangeOp = z.enum(['upsert', 'remove'])` |
| Live delta gap rule is `first fresh seq !== cursor + 1 → heal` | `packages/terminal-client/src/connection.ts:1093` (`applyDelta` returns false at line 1098), `ingestDelta` line 1070 calls `healMetadata()` |
| Heal reply rejects non-adjacent seqs | `packages/protocol/src/messages/sync.ts:223` — `if (prevSeq !== null && change.seq !== prevSeq + 1) return null` |
| An empty heal reply may not advance the cursor today | `packages/protocol/src/messages/sync.ts:213` — `return result.cursor === opts.fromCursor ? result : null` |
| The last change's seq must equal the reply cursor today | `packages/protocol/src/messages/sync.ts:236` — `if (last !== undefined && last.seq !== result.cursor) return null` |
| `readChangesSince` returns null (→ snapshot) for out-of-range or corrupt cursors, and pruning is head-only/contiguous | `packages/sync/src/change-log.ts:134-146` |
| Change retention default is 3 days | `packages/sync/src/change-log.ts:37` — `CHANGE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000` |
| The `changes` table has no principal/visibility dimension | `apps/server/src/migrations/schema.ts:196` — columns `seq`, `entity`, `entity_id`, `op`, `payload`, `event_time` |
| The bootstrap snapshot arm is a per-entity-kind product type | `packages/protocol/src/messages/sync.ts:124` — `SyncChangesSinceResult` snapshot arm: `sessions`, `issues`, `conversations`, `diagnostics`, `automations?`, `automationRuns?` |
| Emission is one seq-ordered pipe that must never reorder | `apps/server/src/modules/funnel.ts:45` — "metadataDelta emission is ONE seq-ordered pipe (#256) … NEVER reorders" |
| Domain soft-delete exists on sessions and issues (D5's look-alike pair) | `apps/server/src/migrations/schema.ts:46` (`sessions.deleted_at`) and `:391` (`issues.deleted_at`) |
| No owner / visibility / user column exists on any server table | `apps/server/src/migrations/schema.ts` — grep for `owner`, `visibility`, `user_id`, `owner_id` returns nothing |
| A client session is a device, not a person | `apps/server/src/migrations/schema.ts:190` — `client_sessions` is `token_hash` / `created_at` / `expires_at` |
| Auth is one password per instance, no accounts | `packages/runtime/src/auth-store.ts` — `setPassword` (line 93), `verifyPassword` (line 126); no account table or user record |
| The operator capability is unconstrained | `packages/domain/src/issue-authz.ts:47` — `OPERATOR: Capability = { role: 'admin', scope: { kind: 'all' } }` |
| D2's unscoped decision, its contiguity warning and its named trigger | `docs/adr/0002-sync-protocol.md` D2, "Why unscoped, stated honestly" and "The consequence that must be written down before someone 'just adds a filter'" |
| D5 names soft-delete and tombstone as looking identical from a distance | `docs/adr/0002-sync-protocol.md` D5, final paragraph |
| D6's chunked/buffered/atomic/paced bootstrap properties | `docs/adr/0002-sync-protocol.md` D6 |
| D7's ladder has rung 2 = re-bootstrap and the outbox survives every rung | `docs/adr/0002-sync-protocol.md` D7 |
| ADR 2's Deferred list contains the "Per-client feed scoping" bullet with its stated trigger | `docs/adr/0002-sync-protocol.md` "Deferred (explicitly not decided here)", third bullet |
| ADR 3 D8 re-authorizes on every apply including outbox replay | `docs/adr/0003-command-security.md` D8 (line 273) |
| ADR 3 D10 owns the outbox horizon; ADR 3 D13 owns `expectedRevision` on the envelope | `docs/adr/0003-command-security.md` D10 (line 338), D13 (line 425) |
| ADR 4 D7.3 rejects a server-side IVM engine with "the client already holds the world" | `docs/adr/0004-representation-policy.md` D7 rejected-alternatives, line 306 |
| The D7.3 narrowing is already carried by ADR 4's amendment | `docs/adr/0004-representation-policy-amendment-1.md` D8 ("the client already holds its slice") |
| ADR 7 classifies control-plane frames and bridges today's `MessageSyncClass` labels | `docs/adr/0007-plane-inventory.md` D1 (line 31) |
| ADR 1 D5 makes `InstanceId` a deployment partition, not a row discriminator | `docs/adr/0001-authority-ownership.md` D5 (line 163) |
| Human decision: C's mechanism with B's default; private default; per-feature policy deferred; machinery load-bearing with conformance as a gate condition | `docs/multi-user-readiness.md` header HUMAN DECISION block |
| The four consequences of scoping (watermarks, visibility events, per-principal bootstrap, D7.3 narrowing) | `docs/multi-user-readiness.md` §3.1 items 1-4 |
| The A/B/C fork and its recorded resolution | `docs/multi-user-readiness.md` §3.1 option table and the DECIDED line beneath it |
| Default-closed classification rule and the tenant-visible infrastructure floor | `docs/multi-user-readiness.md` §3.1.1 |
| Open items O1-O4 are recorded as deliberately open upstream | `docs/multi-user-readiness.md` §3.1.2 (existence leaks, cross-boundary edges, inheritance on create) and §3.1.5 case 2 (reparent) |
| The op-stream class, and D5's positive-state dependency for documents | `docs/multi-user-readiness.md` §4 and its item 1 |
| Phase-2 sequencing: scoped feed before the POD-308 cutover; named conformance cases | `docs/multi-user-readiness.md` §5 sequence table, Phase 2 row |
| Sibling ownership: ADR 9 = POD-1070, ADR 1 amendment = POD-1071, ADR 3 amendment = POD-1073, ADR 7 amendment = POD-1074 | `podium issue show` for each id |

---

## 8. Status / sign-off path

| Stage | Owner |
|---|---|
| Proposed | POD-1072, under epic POD-359 |
| Pack reconciliation + index | POD-359 |
| Human approval | POD-359 human gate |
| Implemented | Phase 2 (POD-289), before POD-308; conformance at POD-306 |
