# ADR 2: Sync protocol

Status: **proposed** · 2026-07-17 · Issue POD-748, epic POD-359
Governs: POD-289 (Phase 2 sync kernel), POD-305 (Authority), POD-306 (Replica + Outbox), POD-307 (clients on the kernel Replica), POD-309 (retire upstream sync)
Related ADRs: ADR 1 (authority/ownership matrix), ADR 3 (command security & lifecycle), ADR 4 (representation policy), ADR 5 (peer topology seam), ADR 6 (replica storage), ADR 7 (plane/message inventory)
Spec components: [spec:SP-3fe2] (strangler rebuild), [spec:SP-0371] (hub deferred), [spec:SP-4428] (drizzle-kit)
**Amended by:** [Amendment 1 — the feed becomes per-principal](0002-sync-protocol-amendment-1.md) (POD-1072, 2026-07-29): D2's "the feed stays **unscoped**" clause is **overturned** (D2's one-feed/one-global-seq/one-cursor half survives verbatim); D5's safety proof is re-proved over the per-principal slice and gains an op-stream constraint; D6's bootstrap reads the principal's scoped slice (shape unchanged); and the Deferred bullet **"Per-client feed scoping"** is **struck — its own stated trigger fired**. New decisions D12–D17 (per-principal feed, covered-range watermarks, `evict` op + `rescope` frame, scoped bootstrap, retention/op-stream constraints, load-bearing-from-day-one and the must-land-before-POD-308 ordering). D1, D3, D4, D7–D11 are unchanged.

---

## Context

**This ADR documents and completes a protocol that already exists.** It is not a
greenfield proposal. A cursor-based, seq-ordered, durable change feed is live on
`main` today and is the web client's only read path:

- `packages/sync/src/ledger.ts` — the `Ledger`, single writer of the change log.
  `commit()` runs the entity write and the change append in ONE `transact()` span.
- `packages/sync/src/change-log.ts` — dedup baseline, retention, `readChangesSince`.
- `packages/protocol/src/messages/sync.ts` — `MetadataChange`, `MetadataDeltaMessage`,
  `SyncChangesSinceResult`, and the lenient consumer parsers.
- `apps/server/src/router.ts` → `sync.changesSince` (tRPC catch-up over HTTP).
- `packages/client-core/src/replica/replica.ts` — the client replica + cursor.

The written specs are `docs/spec/oplog-read-path.md` (P2, read path) and
`docs/spec/outbox-write-path.md` (P3, write path), both marked *approved for
implementation* and both largely shipped.

So the job of this ADR is narrow and specific: **name the invariants the shipped
system already relies on, and decide the questions it left open** — the ones Phase 2
(POD-289) cannot implement without an answer. Where the shipped code is right, this
ADR ratifies it rather than inventing a replacement. Where it is wrong or silent,
this ADR says so and decides.

The charter comes from the 2026-07-13 adversarial review of the proposal (POD-279,
finding 5), which is worth quoting because it is the tightest statement of why this
ADR exists at all:

> "Delta-only" was sloppy: **bootstrap/recovery snapshots are required; the protocol
> needs epochs, cursor-vs-revision, tombstones/retention, chunked install with delta
> buffering, transactional entity+cursor+outbox persistence.**

Note the trap in the sources: `docs/rearchitecture-v3.md` is a *migration ledger*, and
the "ledger" in it means that document. The `Ledger` class in `packages/sync` is the
change log. They are unrelated; this ADR always means the class.

**Why a bespoke protocol at all** is already settled and not reopened here:
`docs/offline-sync-architecture.md` §2 rejects Turso ("row-level 'last push wins' is
device-blind and can't express daemon-authoritative rows"), Replicache, Zero /
ElectricSQL / PowerSync ("Postgres-centric + extra sync service; breaks single-binary
SQLite self-host"), Dexie ("IndexedDB-only — dies on React Native") and CRDTs as a
backbone ("merging 'session 12 is busy' is meaningless" — metadata is
server/daemon-authoritative *observation*, not collaborative text). Its conclusion is
this ADR's premise:

> **The durable asset is the sync protocol, not any library.** Client libraries are
> replaceable consumers of it.

That is also why this document is worth its length. TanStack DB is being retired
(POD-307) and the storage engine is ADR 6's call; if the protocol is the durable
asset, its invariants are the thing that must survive both.

The three decided facts this ADR builds on:

- [spec:SP-3fe2]: *tables as truth + transactional change log*. No event sourcing.
  Entities live in normal SQLite tables; every durable write appends its change in
  the same transaction. One replication engine, spoken by every hop.
- [spec:SP-0371]: the hub is **deferred**, but the **federation seam is preserved** —
  feed identity, origin/causation on changes and commands, reserved peer-capability
  fields, ports free of same-machine assumptions.
- [spec:SP-4428]: drizzle-kit owns the **server's** schema migrations. See D4 — this
  is emphatically *not* the sync protocol's version, and conflating the two is a
  named error, not a shorthand.

### What is actually broken today (verified, not assumed)

Each of these was read out of the code that decides it, not inferred from a doc:

1. **There is no feed identity.** `Ledger.cursor()` is just `maxChangeSeq()`. A bare
   integer is the whole cursor. The DB-reset case is handled by a *heuristic* —
   `readChangesSince` returns "snapshot" when `cursor > max` (`change-log.ts:139`).
   That heuristic has a hole; D1 closes it.
2. **Retention is 3 days, and the spec said 14** (*as written; the spec has since been
   corrected by POD-770 — D5 below is authoritative*). `CHANGE_MAX_AGE_MS = 3 days`
   (`change-log.ts:37`), and `pruneChanges` takes `Math.max(rowCapSeq, aged.seq)` —
   *whichever budget deletes **more*** (`sync-repository.ts:96`). The spec promises
   "keep 20 000 rows or 14 days, whichever is **larger**"
   (`docs/spec/oplog-read-path.md:35`) — the opposite reconciliation *and* a
   different number. The shipped horizon is the tighter of the two budgets.
3. **There is no per-entity revision** and no uniform `updated_at`. Change detection
   is JSON byte-equality against an in-memory baseline. `sessions` has no
   `updated_at` at all. ADR 1's expected-revision conflict rule has nothing to
   check against; D3 supplies it.
4. **The feed is an unscoped firehose.** `sendMetadataDelta` loops over every
   cap client and sends every change for every entity, with no filtering
   (`apps/server/src/modules/sessions/service.ts:3221`). D2 decides whether that
   stays.
5. **`WIRE_VERSION` is frozen at 1, and the two compatibility functions disagree.**
   `versionSupport()` (a range) is the live WS gate at `wsServer.ts:277`;
   `isProtocolCompatible()` (equality) has no production callers. They agree today
   only because `MIN_SUPPORTED_VERSION === WIRE_VERSION === 1`. Feature negotiation
   happens entirely through `caps`, not versions.
6. **Bootstrap is a single monolithic response.** The `snapshot` arm of
   `SyncChangesSinceResult` carries every session, issue, conversation, diagnostic,
   automation and automation-run in one tRPC reply, as a product type that must grow
   an array per entity kind forever.
7. **There is no backpressure.** Deltas are written to every cap socket
   unconditionally.

---

## Decisions

### D1 — A cursor is meaningless without feed identity: `(feedId, epoch, seq)`

**Decide.** The feed is identified by a `feedId` (stable, minted once per authority
database) and an `epoch` (the identity of the current seq-continuity generation).
A replica's cursor is the **triple** `(feedId, epoch, seq)` — never a bare integer.
Every delta frame and every catch-up reply carries `feedId` and `epoch`. A replica
compares them on every exchange; any mismatch is a **reset** (D7), not a heal.

The authority mints a **new** epoch whenever it cannot guarantee that its `seq`
sequence continues the one clients hold: restore from backup, DB rebuild, or any
operator action that rewinds `changes`. `feedId` changes only when the database is
genuinely a different feed.

**The epoch is an opaque, never-reused generation id (ULID/UUID), NOT a counter, and
it is compared by equality only.** This is not fastidiousness — a counter is actively
broken here, for a reason specific to how epochs get bumped:

> The epoch lives *in the database*, so restoring a backup restores the **old epoch
> along with the old seqs**. The bump therefore has to happen at restore time, on the
> restored value. Restore a backup stamped `epoch=3` → bump → `4`. Now restore *the
> same backup again* (a second rollback attempt, a re-run runbook, a botched first
> restore) → it is `epoch=3` again → bump → **`4` again** — a different timeline
> wearing an epoch that clients have already accepted. The counter silently
> re-collides exactly in the situation the epoch exists to catch.

A minted id cannot collide, no matter how many times the same backup is restored or in
what order. Ordering epochs is never needed: a replica only ever asks "is this the
generation I hold?" — never "is it newer?". So equality is the entire required
operation, and paying for a counter's ordering buys a collision instead.

**Why.** Today's `cursor > max ⇒ snapshot` heuristic (`change-log.ts:139`, commented
"a cursor from the future (server DB was reset)") catches the *easy* half of a reset
and silently corrupts the hard half:

> Restore the server from a pre-migration backup — **the sanctioned rollback path**.
> [spec:SP-4428] mandates the "pre-migration backup (#43)" as part of the operational
> envelope wrapped around drizzle's migrator, and POD-305 spells out what it is for:
> *"Rollback = restore the automatic pre-migration backup (backup.ts; free-space
> preflight f07d2683) — drizzle has NO down migrations."* Say the backup's log ends
> at seq 400 and a client holds cursor 500. If the client asks now, `500 > 400` →
> snapshot → healed. But the server keeps working. After 100 more commits `max` is
> 500 again. The client asks `changesSince(500)`, hits `cursor === max`, and gets
> `[]` — *"you are up to date."* It is not. It holds entities from changes 401–500 of
> a timeline that no longer exists, and it will never heal. Nothing in the protocol
> can ever detect this.

Worse, the client is wrong in *both* directions: it also missed changes 401–500 of the
restored timeline while it was away. Divergence persists for every entity that is
never touched again — for those, the phantom value is final.

This is not a theoretical CAP-theorem hazard; it is reachable through the documented
rollback procedure, and the failure is silent and permanent. An epoch costs one opaque
id on the wire and one equality check, and closes it completely.

**Consequences.** The authority persists `feedId`/`epoch` alongside the log. Replicas
store the triple, not the integer. Epoch mismatch is cheap: it costs one re-bootstrap,
and the alternative is silent divergence.

**There is no restore code path to hook, and that is the hard part of D1.**
`apps/server/src/migrations/backup.ts` exports `backupDatabase`, `freeDiskBytes` and
`MIGRATION_BACKUPS_TO_KEEP` — and **nothing that restores**. There is no
`restoreBackup` anywhere in the tree. Restore today is an operator copying a file over
`podium.db`. So "the restore path re-mints the epoch" has nowhere to live, and a
purely documented runbook step is exactly the thing that gets skipped at 2am during
the incident the rollback exists for — leaving an epoch that lies, which is worse than
no epoch, because it *looks* checked.

POD-305 therefore owes one of these, and this ADR requires it to choose explicitly
rather than write a runbook line:

- **A restore command** (`podium db restore <backup>`) that copies *and* re-mints in
  one step, making the correct path the easy path; the file-copy stays possible but
  becomes the unsupported one. **Preferred** — it is the only option that makes the
  guarantee hold by construction.
- **Boot-time detection**, if a restore command is refused: the authority notices its
  `changes` head sits below a high-water mark it has seen before and re-mints itself.
  Note the mark cannot live in the same database — a restore would roll it back too —
  so this needs an out-of-DB marker, which is its own reliability problem. Weaker, and
  called out as such.

POD-306's conformance suite must cover *restore → keep writing → stale client
reconnects at the same seq*: the scenario above, and the one no current test can catch.

**Seam note ([spec:SP-0371]).** `feedId` *is* the "authority/feed identity" the
federation seam requires. A future hub distinguishes feeds by it; a node holds one
cursor per upstream feed. We build the identity now precisely because retrofitting it
into persisted cursors later is exactly the migration this ADR is trying to spare a
future us.

### D2 — One feed, one global cursor. The feed stays **unscoped**; scoping needs watermarks

**Decide.** There is ONE feed per authority, with one globally monotonic `seq` across
all entity kinds, and one cursor per replica. This ratifies the shipped design
(`relay.ts:315`: "One changes table + one seq sequence — changesSince consumers see
one unified feed").

The feed is **unscoped**: every authorized replica receives every change. We do NOT
add per-client filtering in Phase 2.

**Why the ratification.** One cursor is what makes gap detection a single integer
comparison, makes bootstrap a single atomic point, and makes the outbox/replica
conformance suite parameterizable across hops. Per-entity feeds would multiply cursors
by entity kinds and re-introduce the cross-entity ordering problem the single seq
deletes for free (`IssueWire` embeds derived session data — the entities are not
independent, so their feeds cannot be either).

**Why unscoped, stated honestly.** This is a real limitation, recorded rather than
hidden. Podium today is single-tenant-shaped (`docs/offline-sync-architecture.md`
§4, rule 3: "The store stays **single-tenant-shaped**... one SQLite + one transcript lake per
tenant"), so every client of an authority is entitled to the whole feed. Authorization
is therefore enforced at the **authority boundary** — what enters the feed at all, and
who may open a connection to it (ADR 3 owns the principal; ADR 1 owns secret
classification and what must never be replicated).

**The consequence that must be written down before someone "just adds a filter".**
Per-client filtering is **incompatible with the contiguity contract**, which is
load-bearing in shipped code: `parseChangesSinceResult` rejects any delta whose first
change is not exactly `fromCursor + 1` (`sync.ts`, citing #247 round 2), and the
client gap rule heals on `seq !== cursor + 1`. Filter the stream per client and every
suppressed row is an *invisible permanent gap* that triggers an endless heal loop —
the identical failure mode the lenient-parsing note already documents for unknown
entity kinds ("healing via changesSince returns the same unknown rows and loops
forever").

So: if scoping is ever needed (the trigger is multi-tenancy or an entity kind a
client must not see), it MUST arrive with **watermarks** — the authority tells the
replica "your cursor advanced to N" for suppressed ranges, so contiguity is preserved
over a filtered view. Adding a filter without a watermark is a protocol break, not an
optimization. Recorded here so the trap is visible at the point someone reaches for it.

### D3 — Cursor and revision are different questions; we need **both**

**Decide.** Adopt both, with strictly separated jobs. They are not alternatives and
choosing between them is a category error.

| | **Feed cursor** `(feedId, epoch, seq)` | **Entity revision** |
|---|---|---|
| Answers | *"Where am I in the stream?"* | *"Is my write based on current truth?"* |
| Scope | One per replica | One per entity |
| Owner | The transport/replication layer | The domain / conflict rule |
| Consumers | Gap detection, resume, bootstrap | ADR 1's expected-revision checks |
| Today | Exists (`changes.seq`) | **Does not exist** |

Every durable entity gains a monotonic `revision`, incremented by the authority on
every accepted write, carried on the wire projection and on the change payload.
`revision` is authority-assigned and opaque to replicas — a replica never computes,
compares-for-truth, or arbitrates on it. It only echoes it back in commands.

**Naming the precondition field — the delegation ADR 1 hands us.** ADR 1 requires:

> Mutating commands carry an **expected revision** (concrete wire field named by ADR 2
> / ADR 3 — e.g. `expectedUpdatedAt`, entity etag, or per-entity revision).

Answering directly: **the field is `expectedRevision`, an integer, matching the
entity's `revision`** — the third of the three candidates ADR 1 offers. (ADR 1
delegates jointly to ADR 2 / ADR 3: ADR 2 defines the *token* — what a revision is,
who assigns it, how it reaches the wire; ADR 3 owns the *command contract* the field
sits in. Naming it here is the half this ADR owes.)

Why not the other two candidates ADR 1 lists:

- `expectedUpdatedAt` — a **clock**. Unreliable across peers, and per POD-279 finding
  3 "generic field-LWW has no clocks and can break aggregate invariants". `sessions`
  has no `updated_at` at all, so it cannot even be applied uniformly.
- entity etag — a content hash works, but costs a hash of the whole entity per compare
  and carries no ordering. `revision` is one integer, monotonic, and free to compute
  at the point the authority is already writing.

Note the epoch (D1) is **not** a candidate: it is *feed* identity and changes for
reasons that have nothing to do with an entity being edited.

**Why a token is needed at all.** ADR 1's default posture is "ONE home authority +
expected-revision / command-specific rejection or rebase". That posture is
unimplementable today: there is nothing to put in `expectedRevision`. `seq` cannot
serve — it is a *feed* position, global across entities; two clients editing different
issues have wildly different seqs with no bearing on either issue's staleness.

Byte-equality dedup against an in-memory baseline (`ChangeBaseline.upsertChanged`)
stays as-is: it is a *change-detection* mechanism (don't append a no-op), a
different job from concurrency control, and it works well. D3 adds a token; it does
not replace the baseline.

**Consequences.** POD-305 adds `revision` to the entity tables it owns via a drizzle
migration; the backfill is `revision = 1` for existing rows (`generate --custom`).
Wire projections gain the field per ADR 4's composition rules. ADR 1 owns *which*
entities take expected-revision and which take a command-specific rule; ADR 2 only
guarantees the token exists, is monotonic per entity, and is authority-assigned.

### D4 — Three version namespaces, never conflated

**Decide.** Three independent versions. Naming them separately is the decision; the
drift refresh on POD-359 called out the risk explicitly and this is the answer.

1. **`WIRE_VERSION`** — the protocol/framing version (`packages/protocol/src/version.ts`).
   Peer-to-peer compatibility. Sent on the WS URL (`/client?v=`). Bumped ONLY on a
   breaking framing change.
2. **Replica schema version** — the *client's local store* shape (IndexedDB object
   stores / mobile SQLite). Owned entirely by the client, and **ADR 6 owns the
   policy**: it mandates a bespoke `schema_version` with forward-only migrations and
   a loud downgrade guard. ADR 2's only claim here is the **floor**: because the
   replica is a cache of authority truth and D6 makes re-bootstrap cheap,
   *discard-and-re-bootstrap is always a legal recovery* — so a client is never
   obliged to migrate, and an unmigratable store is never a dead end. ADR 6 agrees on
   the fallback ("unknown future schema that cannot be migrated" → clear and proceed
   as a cold client). Migration is ADR 6's optimization to avoid a re-download;
   re-bootstrap is this ADR's guarantee that the optimization is always optional.
   **Subject to the outbox rule in D7 — a discard of the cache is never a discard of
   queued user work.**
3. **The server DB drizzle journal** — [spec:SP-4428]. **Server-internal. NEVER on the
   wire, never compared with a peer, never sent to a client.**

**Why the third one matters so much.** The temptation is to treat "the DB schema
changed" as "the protocol changed" and use one number. That is wrong in both
directions and would break both properties:

- A drizzle migration that adds an internal index or splits a table changes the
  journal and changes **nothing** on the wire. Bumping the wire version would force
  every client to update for a change they cannot observe.
- A wire change that reshapes a projection composed in code (ADR 4) may touch **no**
  table at all. The journal would not move, and stale clients would parse garbage.

The journal is a *migration ordering DAG for one database*. `WIRE_VERSION` is a
*compatibility contract between peers*. They have different owners, different
lifecycles, and different failure modes. The oplog already encodes the right instinct
— "the oplog speaks protocol, not DB rows" (`sync.ts:10`), payloads are wire shapes.
D4 makes that instinct a rule.

**Feature negotiation stays capability-based, not version-based.** The shipped `caps`
mechanism (`hello.caps: ['metadataDelta']`) is the correct pattern and is ratified:
additive features negotiate by capability; `WIRE_VERSION` moves only for breaking
framing changes. This is why the oplog shipped with "no `WIRE_VERSION` bump required"
(`oplog-read-path.md:82`) — a good outcome, and now a stated rule.

**Issues-pilot reconciliation (POD-797; fact, not verdict).**
CAP_ISSUES_NORMALIZED remains as additive client capability data, while the temporary
issues-normalized-wire server feature flag was deleted after the browser cut over. The
normalized issue kinds emit unconditionally. Capless clients still receive a session-free
legacy issue payload, registered as POD-309/POD-827 residue; POD-827 blocks making the
normalized projection the sole issue feed on hub-node installs.

**Ratify lenient consumer parsing as protocol law.** `sync.ts:62-118` — producers are
strict, consumers accept unknown entity kinds with `value: unknown`, ignore them, and
**advance the cursor past them**. The reasoning is not obvious and is hard-won: a
quarantined delta element is an *invisible cursor gap*, and healing via `changesSince`
returns the same unknown rows forever. This makes "a newer authority adds an entity
kind" a non-event for old replicas, which is what lets D2's single feed grow. It is
now a protocol rule, not an implementation detail: **new entity kinds are additive and
never bump `WIRE_VERSION`.**

**Fix the inconsistency — and note which way round it actually is.**
`packages/protocol/src/version.ts` ships two compatibility functions that disagree:
`isProtocolCompatible(a, b) => a === b` (equality) and `versionSupport()`
(a `[MIN_SUPPORTED_VERSION, WIRE_VERSION]` range returning `'ok' | 'too-old' |
'too-new'`).

The **range is the shipped behavior**: `versionSupport` is the live WS gate —
`wsServer.ts:277` rejects a mismatched peer with HTTP 426. `isProtocolCompatible` has
**no production callers at all** (only `version.test.ts` and version.ts's own
docstring, which points peers at it). So the equality function is the dead
aspirational one, and the docstring recommending it is actively misleading about what
the server does.

This ADR ratifies the **range** — it is both what ships and what is correct, since it
allows a rolling upgrade where server and client deploy separately (already true of
the PWA, whose bundle can lag the server across a redeploy). POD-305 deletes
`isProtocolCompatible` or reimplements it in terms of `versionSupport`, and fixes the
docstring. Today `MIN_SUPPORTED_VERSION === WIRE_VERSION === 1`, so the range is
*numerically* equality right now — which is exactly why this drifted unnoticed and why
it must be settled before the first bump makes the two functions disagree in
production.

### D5 — Tombstones are feed rows; retention is a **liveness** parameter, not a correctness one

**Decide.** Deletion replicates as an explicit `op: 'remove'` change row — a tombstone
in the feed, with a null payload. This ratifies the shipped shape.

Tombstones are **head-pruned with the rest of the log**. They are NOT retained
forever, and they do NOT need to be.

**Why this is safe — the load-bearing argument.** The usual tombstone-GC hazard is a
replica that misses the tombstone, keeps the entity forever, and never learns it was
deleted. Podium is immune *by construction*, and it is worth being precise about why:

1. Pruning is **head-only** (`DELETE FROM changes WHERE seq <= threshold`), so the
   retained range is always contiguous.
2. A replica whose cursor falls below `minAvailableSeq` cannot be served a delta —
   `readChangesSince` returns null → snapshot (`change-log.ts:144`).
3. The bootstrap snapshot is *positive state*: it lists what exists. A deleted entity
   is simply absent, so the replica drops it on install (D6).

Therefore a tombstone only has to survive long enough to be delivered to replicas
that are **still within the retention window**. Any replica that misses it is, by
definition, past the window, and gets the truth from a snapshot instead. Retention
tunes *how often clients re-bootstrap* — a cost/liveness knob. It cannot cause
divergence. **This property depends entirely on head-only pruning**; any future
"compact the log by dropping superseded rows" optimization breaks it, because it would
punch holes in the retained range while `minAvailableSeq` still claims contiguity. If
that optimization is ever wanted, it needs its own ADR.

**Decide the horizon and fix the drift.** The code says 3 days (`CHANGE_MAX_AGE_MS`);
the spec says 14 and reconciles the two budgets the opposite way ("whichever is
larger" vs the shipped `Math.max(rowCap, agedSeq)` = whichever deletes more). **The
code's reconciliation is correct** — the budgets are a *bound* on the log, and taking
whichever deletes more honors both bounds; "whichever is larger" honors neither. The
spec was wrong; **POD-770 corrected it** (`docs/spec/oplog-read-path.md` §2.1 now
states 20 000 rows / 3 days, whichever deletes more, and points here). POD-305 carries
the remaining code-side work — publishing `minAvailableSeq`.

The **horizon is now a published protocol parameter**, not an implementation constant:
the authority advertises `minAvailableSeq` so a replica can tell "I need to
re-bootstrap" *before* asking. 3 days is retained as the default. It is deliberately
short and that is fine: re-bootstrap is correct, cheap after D6, and the alternative —
a large log to serve rare long-offline clients — pays a permanent cost for an
exceptional case.

**Scope: this is the CHANGE FEED's retention, not the bulk plane's.** ADR 1's matrix
points at "retention/compaction ADR 2" for transcript **segments** as well. That is a
different policy on a different plane: segments are verbatim byte lakes synced by
offset cursors (`docs/spec/transcript-mirror.md`), not entities in the `changes` feed,
and their retention is a *product* question (how much history does backup keep) rather
than a protocol one (how long can a cursor heal). D5 governs the `changes` log only.
Bulk-plane retention stays with the transcript-lake spec and its backup/export
feature; ADR 7 owns the plane boundary. Recorded so the two ADRs do not point at each
other across a gap.

**Entity-level soft deletes are a different mechanism and stay that way.**
`sessions.deletedAt` / `issues.deletedAt` are *domain* state (an issue is deleted but
recoverable) and belong to ADR 1. A domain soft-delete is an `upsert` on the feed, not
a tombstone; a tombstone means "this entity is gone from your replica". Conflating
them would make "deleted" unrecoverable. Named here because the two mechanisms look
identical from a distance and are not.

### D6 — Bootstrap: chunked, buffered, atomically installed, through the **same** feed identity

**Decide.** Bootstrap is a **chunked stream of the same change shape**, not a
monolithic product-typed snapshot.

The authority reads its state at a definite `(feedId, epoch, seq)` and streams it as
ordered chunks of `upsert` rows — the same `MetadataChange` shape the delta path uses.
The replica:

1. Records `(feedId, epoch, snapshotSeq)` and opens a staging area.
2. Installs chunks as they arrive.
3. **Buffers concurrent deltas** with `seq > snapshotSeq` for the duration.
4. On the last chunk, **atomically** (D10): swap staging into place, apply the
   buffered deltas in order, commit the cursor.
5. A failure at any point before the commit discards staging and retries. There is no
   half-installed replica.

**Why chunked.** Three reasons, in order of importance:

- **Correctness under growth.** The monolithic snapshot is one tRPC reply holding
  every entity. On a real instance that is the whole world in one buffer, on both
  sides. It has already failed once in production in the analogous case — POD-181,
  "Replica localStorage quota exceeded on production data — ingest breaks, sessions
  invisible, spawn crashes" (P1). Bootstrap is the *recovery* path; a recovery path
  that gets less reliable as the system grows is not a recovery path.
- **It deletes a growing product type.** The shipped snapshot arm carries `sessions`,
  `issues`, `conversations`, `diagnostics`, `automations?`, `automationRuns?` — an
  array per entity kind, added forever, each one a wire change. Chunks of
  `MetadataChange` make a new entity kind **free** on the bootstrap path exactly as
  lenient parsing (D4) made it free on the delta path. Today the two paths disagree:
  new kinds are additive for deltas and breaking for snapshots. That asymmetry is a
  latent bug and D6 removes it.
- **One shape, one code path.** POD-350 states the principle this implements:
  *"Delta-first does NOT mean snapshot-free: bootstrap, cursor invalidation, and
  corruption recovery are snapshot paths through the same feed identity."* Bootstrap
  and delta stop being two ways to learn the truth and become one way at two rates.

**Chunked is not enough — bootstrap must be PACED. This is scar tissue, not caution.**
Podium has already shipped a chunked bootstrap and been taken down by it. The
transcript mirror (`docs/spec/transcript-mirror.md` §2.3, "Pacing (incident
amendment, 2026-07)") chunked correctly at 256 KB and drained back-to-back:

> the first live deploy enqueued a months-deep lake on daemon attach and drained it
> back-to-back — continuous 256 KB chunks pumped through the daemon WS, decoded and
> written with zero idle. The server sat at ~80% CPU, starved its own daemon-reply
> handling (`transcript mirror failed: timeout`), missed the systemd watchdog's 30 s
> sd_notify deadline and was SIGABRT'd into a **restart→re-bootstrap crash loop**.

Note the shape of that failure precisely, because it is the one D6 could reintroduce:
bootstrap starved the very connection that bootstrap depends on, and the restart
re-triggered the bootstrap. **A recovery path that consumes the whole loop turns one
slow client into an outage, and then repeats.** The mirror's fix is the precedent this
ADR adopts: an **inter-chunk delay** (mirror default 25 ms) and a **per-pass byte
budget** (mirror default 16 MB), so a big bootstrap deliberately spreads out. Its
design stance generalizes directly — swap the subject and it is our rule: **the
bootstrap must never own the loop.**

Entity bootstrap is warm data where transcripts are cold, so the *numbers* differ and
belong to POD-337's measured thresholds (`sync lag, outbox age + dead-letter count, gap-heal
time, bootstrap snapshot time, reconnect-storm behavior` — currently unfilled placeholders in the migration
ledger; this ADR does not invent them). The *requirement* is not negotiable: bootstrap
is paced and yields, and POD-306's conformance suite must include a reconnect storm —
N replicas bootstrapping at once must not starve the authority.

**Consequences.** `SyncChangesSinceResult`'s snapshot arm is replaced by a chunked
transfer; POD-308's temporary N/N-1 edge adapter covers the transition (and per the
migration ledger, that adapter has a deadline — deleted by Phase 7 at the latest,
registered in the deletion audit; the *negotiation mechanism* is permanent, the
adapter is not). Chunk size is an implementation tuning parameter, not a protocol
constant. There is precedent for the paging itself: `readChangesSince` already pages a
`LIMIT`ed read to `max`, because "a single truncated read would hand the caller rows
1..10000 while cursor() reports the true head — consumers would advance past the
missing tail and permanently skip it" (`change-log.ts:146`). Conversation
**diagnostics** are scan-level rather than per-entity (`oplog-read-path.md:96`) and do
not fit the change shape — they are not entity truth and move to a separate query
rather than being smuggled into bootstrap. **Bootstrap must be resumable-or-restartable
but is not required to be resumable in Phase 2**: a failed bootstrap restarts from
scratch. Resumable bootstrap is deferred (see Deferred, below).

### D7 — One healing ladder; every failure resolves *downward*

**Decide.** Exactly one ordered recovery ladder. Every detected inconsistency resolves
to a rung **below** it, never sideways, never in a loop:

| # | Detection | Response |
|---|---|---|
| 0 | Delta arrives, `feedId`/`epoch` match, `seq == cursor + 1` | Apply. The normal path. |
| 1 | **Gap** — `seq != cursor + 1` | Do not apply. `changesSince(cursor)`. |
| 2 | **Compacted** — `cursor < minAvailableSeq`, or authority returns "snapshot" | Re-bootstrap (D6). |
| 3 | **Malformed** — known-kind row fails validation, corrupt payload, id mismatch, non-contiguous reply | Do not apply, do not advance. Re-bootstrap. |
| 4 | **Epoch/feed mismatch** (D1) | Discard the replica entirely. Re-bootstrap. |
| 5 | **Local corruption** — replica store unreadable | Clear the store. Re-bootstrap as a cold client. |
| 6 | **Replica schema version bump** (D4) | Discard. Re-bootstrap. |

Rungs 2–6 all terminate at the same place: **re-bootstrap through the same feed
identity**. That is the whole design — one terminal recovery, reachable from every
failure, exercised on every cold start, and therefore never a rarely-tested emergency
path.

**THE OUTBOX SURVIVES EVERY RUNG. A discard of the cache is never a discard of queued
user work.** This is the most dangerous sentence in the ADR to get wrong, because the
danger is invisible: ADR 6 puts entity data, the cursor, the overlay **and the outbox**
in one transactional store (D10 requires exactly that), so "clear the store" reads as
one innocent operation and is in fact two — throwing away a *cache*, which is free,
and throwing away *the user's unsent writes*, which is data loss. ADR 3 D9 forbids
silently discarding user-authored work, and rungs 4–6 would do it by accident.

The distinction is ADR 1's, and it is not a nuance — it is a difference of *home*:
entities and cursor are **replica cache** (home: the authority; re-derivable at will),
while the outbox is **client-local** authored truth that exists *nowhere else*. Losing
the cache costs a re-download. Losing the outbox loses something the user typed.

So every rung reads: **discard the cache, re-bootstrap, keep the outbox.** After the
bootstrap installs, queued entries drain against the new truth (their `mutationId`
still dedupes; D11 still bounds their age; ADR 3's `expired`/`rejected` states still
apply). Two corollaries:

- **An epoch change (rung 4) does not invalidate the outbox.** A command is a request
  against an entity, not against a feed position, and D8's `mutationId` is minted by
  the client — it does not derive from the feed. What *may* be invalidated is an
  entry's `expectedRevision` precondition (D3), and the correct outcome of a stale
  precondition is an authority **rejection surfaced to the user** (ADR 3), never a
  silent drop at the replica. The replica does not get to decide the command is moot;
  that is arbitration, and D7's whole posture is that replicas never arbitrate.
- **If the outbox itself is unreadable** (rung 5, genuine corruption), it cannot be
  preserved — but its loss must be *surfaced*, never swallowed. That is the one case
  where user work is lost, and it must be loud.

POD-306's conformance suite must assert this directly: *offline writes queued →
force an epoch bump → reconnect → the queued writes still drain or surface, and none
vanish.* A suite that only checks entity convergence would pass while the outbox is
being silently eaten.

**Why the ladder must be strictly downward.** The loop hazard is real and already
documented in shipped code: heal via `changesSince` returns the same rows and "loops
forever" (`sync.ts` lenient-parsing note). A rung that resolves *sideways* — retrying
the same request that just failed — is an infinite loop. So rung 3 escalates to
re-bootstrap rather than retrying the heal.

**Ratify the shipped semantic validation.** `parseChangesSinceResult` (`sync.ts:187`)
already encodes rung 3, and its rules cite specific review rounds (#247 rounds 2/3):
an embedded wire id must match the change id; seqs must be contiguous from
`fromCursor`; an empty delta must not move the cursor; an explicit null cursor must
yield a snapshot, never a delta. **These are protocol law, not implementation
defensiveness. Do not relitigate them without reading the reasoning.** Each one is a
class of silent permanent divergence.

**Stale-visible, never blank.** A replica that cannot reach its authority keeps
serving its last-known state, marked stale. Disconnection is not data loss. This
ratifies `node-hub-sync.md` invariant 3 and `docs/offline-sync-architecture.md` §3,
and it is why rungs 2–6 must never blank the UI before the replacement state is
installed (D6's atomic swap is what makes that possible).

### D8 — Origin, causation and mutation identity ride the **envelope**, not the entity

**Decide.** Three distinct identities, none of them the same thing, all on the change
envelope and none in the entity payload:

- **`originId`** — *which peer authored this change.* Enables echo suppression and
  loop prevention.
- **`causationId`** — *which command caused this change.* Links a change back to the
  command that produced it (ADR 3 owns the command contract).
- **`mutationId`** — *the client-minted idempotency key of that command.* Already
  shipped (`applied_mutations`, `outbox-write-path.md` §2.1). Belongs to the command,
  and appears here only as what `causationId` resolves to.

All three are Podium-minted, immutable ids, which is the repo's standing identity rule
(`docs/spec/conversation-registry.md` §2) and not a new position:

> **every entity gets a Podium-generated, immutable, globally-unique ID at creation.
> Native/agent artifacts (session ids, file paths, cwds, repo paths) and human-facing
> attributes are EVIDENCE or LABELS, never identity.**

The registry's own identity audit already grades "queued message / mutation:
client-generated UUID — ✅ stable", and flags a counterexample worth remembering:
superagent messages key off a SQLite `AUTOINCREMENT` and are marked "⚠️ not sync-safe;
migrate when superagent joins the oplog". An autoincrement is a fine PK and a
catastrophic identity — two authorities mint the same one. D8's ids are minted, never
derived.

**Envelope, not entity** — POD-289 states it as "provenance served via envelope,
entities provenance-free", and this ADR ratifies it. Provenance is a fact about *how
truth arrived*, not a property of the truth. Putting `originId` in the entity payload
would (a) make byte-equality dedup fire on provenance churn, re-recording entities
whose *content* never changed — the exact class of bug the conversation projection
exists to fix (the 81MB/day churn fix, `change-log.ts:43`), and (b) make provenance
part of every wire projection, which ADR 4 forbids.

**Why now, with the hub deferred.** [spec:SP-0371] names "origin/causation fields on
changes and commands" as a required part of the preserved seam, and this is the
cheapest possible time to add it. The concrete payoff is immediate and local, not
speculative:

- **Echo suppression becomes principled.** Today's upstream mirror filters
  self-originated entities *by `machineId`* (`node-hub-sync.md` §2.3: "EXCLUDING those
  originating from this node itself (filtered by machineId... avoid echo
  duplicates)"). That is a domain field pressed into service as a routing field — it
  works only because machine identity happens to correlate with feed origin today.
  Per [spec:SP-15aa] machine identity is per-*instance*, so the correlation is
  already not guaranteed. `originId` is the field that actually means what the filter
  needs.
- **Optimistic overlay retirement gets exact.** "This change is my own write coming
  back" is `causationId` matching an outbox entry — not a heuristic value comparison.
  This is what makes POD-307's "optimistic spawn with client-minted ids and the
  reconciliation grace window" deterministic instead of timing-based.

Note that POD-309 retires `UpstreamSync`/`UpstreamForwarder`. D8 is not preserving
that code — it is preserving the *field*, which is the part that is expensive to add
later (it would mean a migration of every persisted change row).

### D9 — Backpressure: a slow replica is **demoted to resync**, never buffered without bound and never silently dropped

**Decide.** Each connection has a **bounded** outbound queue. On overflow the
authority stops sending deltas to that replica, marks the connection
`resync-required`, and tells it so. The replica's response is rung 2 of D7:
re-bootstrap.

The three options for a slow consumer are: buffer forever (OOM the authority — one
slow phone on a train takes down everyone's server), drop frames silently (permanent
divergence — the worst outcome, and today's `c.send(delta)` has no answer at all), or
**deliberately invalidate the cursor**. Only the third is both safe and bounded.

**Why "just skip a frame" is not on the list.** Order *is* the correctness property,
and the shipped funnel says so (`funnel.ts:45`):

> metadataDelta emission is ONE seq-ordered pipe (#256): every appended batch enters
> `queueDelta` in append order, coalesces at microtask level (a synchronous burst
> emits as one batch), and **NEVER reorders: the client gap rule (seq !== cursor+1 →
> heal) turns any reorder into a heal storm.**

A dropped frame is not a lost update; it is a permanent lie, because the client's next
cursor advance certifies data it never received. Demotion to resync is the only way to
shed load without lying.

**Ratify pipe-before-bus while we are here**, because it is the same invariant and it
is one line from being silently broken (`funnel.ts:54`): the ledger's `onAppended`
enqueues the delta *before* emitting on the bus, since "a reentrant bus listener that
commits again re-enters this bridge with LATER seqs before the outer batch would have
queued — bus-first therefore delivered [N-1, N+1, N] and delta clients' cursors
advanced past N without ever healing the gap." Ordering at the emission seam is
protocol, not implementation detail.

**Why this is cheap rather than drastic.** Because of D6 and D7, "resync required" is
not an emergency — it is the same path taken by every cold start, every quota clear,
every epoch bump. It is the most-tested path in the system. Backpressure resolves to
*discard the replica's position and give it the truth again*, which is exactly what
the protocol is already best at. The authority's memory becomes bounded by
`connections × queue_bound` instead of by the slowest client's connection.

This makes the D5 retention argument load-bearing in a second place: a short log and a
cheap bootstrap are what let the authority treat "you are too slow" as a shrug.

**Consequences.** POD-305 implements the bound (frames or bytes — bytes, since one
`IssueWire` batch dwarfs one `SessionMeta`). The `resync-required` signal is a new
control message (ADR 7 classifies it). POD-306's conformance suite must include a slow
consumer, and this ADR requires it to assert *convergence*, not merely survival.

### D10 — Entity + cursor + outbox commit in **one** transaction, on both sides

**Decide.** On **both** sides of every hop, the state that must agree commits together.

**Authority side** — already shipped and hereby ratified: `Ledger.commit()` runs the
entity write and the change append in one `transact()` span, and it actively refuses
an async `write()` because a thenable "would smuggle a Promise past transact()'s
thenable check (it's wrapped in this object, not returned directly): the change row
would commit now while the entity write ran later, OUTSIDE the transaction — exactly
the torn state commit() exists to prevent" (`ledger.ts:122`). This is [spec:SP-3fe2]'s "tables as truth + transactional change
log" realized, and it is why the feed can never disagree with the tables.

Corollary, also shipped and now named: **durable messages may only be produced by the
funnel's publish tail** — oplog append *before* fan-out — so `sync.changesSince` never
has a hole. `message-class.ts` enforces this at the type level via `LiveServerMessage`
(durable messages fail the raw fan-out helper's type). Type-enforced is the right
strength for this invariant; a comment would have rotted.

**Replica side** — the new requirement. Entity data, the cursor `(feedId, epoch, seq)`,
and outbox state persist in ONE transaction. A crash mid-transaction leaves the
replica at its previous consistent point.

**Why this replaces the shipped ordering rule.** Today's invariant is *cursor-after-
data* (`thin-client-replica.md` invariant 3: "persist cursor AFTER the entities it
covers (a crash between = re-apply idempotent upserts, never gaps)"). That is a sound
*workaround for non-transactional storage* — it deliberately trades a duplicate-apply
window for a gap window, because duplicate upserts are idempotent and gaps are
forever. It was the right call for localStorage.

But it is strictly weaker than a transaction, and ADR 6 makes transactions available
(transactional IndexedDB on web, SQLite on mobile). Under D10 the crash window closes
entirely rather than being aimed at the survivable side. Critically, cursor-after-data
does *not* extend to the outbox: a crash between "entity applied" and "outbox entry
retired" either loses a user's queued write or replays it, and neither is idempotent
at the domain level.

**Cursor-after-data survives as the explicitly degraded fallback**, and only where
transactions genuinely do not exist (ADR 6's constrained fallback). Degraded mode must
be *surfaced*, not silent — POD-307 already requires "recover without data loss or
with explicit, surfaced degradation".

**Scar tissue this ADR must not tidy away.** Whatever the storage, applying a change
must express *field removal* correctly. The replica's `replaceContents` assigns
`undefined` rather than `delete`-ing keys, because TanStack DB change proxies "record
ASSIGNMENTS but ignore `delete draft[k]` — so a field that goes present→absent (an
issue's `deferUntil` cleared on unsnooze, or any optional nulled) can't be removed by
deletion; the stale value would survive and the row never reconciles"
(`replica/replica.ts:242`, incident
POD-170; the migration ledger's §7 scar registry lists it, with POD-378 carrying the
regression test). D6's atomic install and any storage swap under ADR 6 inherit this
obligation: **present→absent is a change like any other, and a "clean" rewrite that
loses it reintroduces a shipped incident.**

**The ordering rule that remains, in every mode:** the cursor must never be ahead of
the data it claims. Transaction or fallback, that is the invariant; the transaction is
just the way to get it without a window.

### D11 — Dedupe horizon vs receipt retention: an expired receipt is a **rejection**, not a replay

**Decide.** Three horizons exist and they are now stated in one place with their
relationship made explicit — POD-306 asks for exactly this reconciliation:

| Horizon | Value | Owner |
|---|---|---|
| Change retention | 20k rows / **3 days**, whichever deletes more (`change-log.ts:36-37`) | **ADR 2** (D5) — it is the feed's |
| Receipt retention (`applied_mutations`) | **30 days** (`service.ts:84`) | **ADR 2** — it is the dedupe horizon of the feed's write path |
| Outbox entry max age | `OUTBOX_MAX_AGE_MS` + `SKEW_MARGIN_MS` — **value not restated here** | **ADR 3** (D10) — it owns the outbox |

**The rule this ADR owns: `outbox max age + skew margin` < `receipt retention`.** An
outbox entry must never outlive the receipt that would dedupe it, or it replays as a
fresh command. ADR 3 D10's values satisfy it with margin, and its lint invariant
imports `APPLIED_MUTATIONS_MAX_AGE_MS` rather than hard-coding it — so the guard
tracks the constant instead of rotting into a comment.

**One number, one owner.** An earlier draft of this ADR picked its own value for the
outbox horizon. That was an over-reach: ADR 3 owns the outbox lifecycle, so it owns
the outbox's horizon, and it has specified the knob better than this ADR did — adding
an explicit skew margin and making the inequality a lint/unit invariant that *imports*
the receipt constant rather than a hard-coded sentence in a document. (No superseded
value is restated here, deliberately: a number in a durable record gets grepped out of
context and believed, and ADR 3 D10 is the only place the outbox horizon lives.)
**ADR 2 therefore defers the value to ADR 3 D10 and retains only the constraint and
the two feed-side numbers it genuinely owns.** What this ADR contributes is the
*reason* the inequality is not merely tidy — see below — and the third number
(3-day change retention) that ADR 3's table needs but cannot derive.

**Why this is the decision.** The shipped invariant is a shrug:
`outbox-write-path.md` invariant 1 — "a replay after pruning re-applies — acceptable
for these mutation types, all user-visible and idempotent-ish at the domain level".
*Idempotent-ish* is not a property. The covered procs include `sessions.sendText`,
where a replay **double-types into the PTY** — the spec names this as the most
critical case and then permits it beyond 30 days.

Note the horizons currently order *safely* — receipts (30d) outlive the change log
(3d) — so a client offline long enough to lose its receipts has already been forced to
re-bootstrap its reads. But re-bootstrapping reads says nothing about a queued write:
the outbox is durable and independent, and today nothing stops a 31-day-old queued
`sendText` from draining into a live agent's terminal.

**This hazard is not hypothetical — the shipped outbox already works around it.**
`packages/client-core/src/outbox.ts:37` splits awaiting-truth entries into a separate
storage home for exactly this reason:

> an OLD build (PWA cache rollback) reads this collection and drains EVERY row it
> finds — it predates the `state` field, so an awaiting-marked row left here would be
> replayed as a queued mutation, **resurrecting stale renames/archives past the
> server's dedup retention**.

That is a real defence, against a real replay-past-the-horizon, written by someone who
hit it. It is also *ad hoc*: it protects one state transition on one client from one
rollback scenario. D11 makes the guarantee structural — an entry that could outlive its
receipt does not get to send, whatever route it took to the queue.

So: an outbox entry older than its max age **expires**. It does not send. It surfaces
to the user as an expired write with recovery actions (retry / edit / discard), per
POD-306's "poison handling must never silently discard user-authored work". A
two-week-old queued message is not something to deliver silently to a running agent
anyway — the world has moved on, and the user is the only one who can say whether it
still means anything. Expiry is a *rejection surfaced*, never a silent drop; D7's
outbox rule says the same thing from the other direction.

**Consequences.** The authority MAY reject a command whose `mutationId` predates its
receipt horizon; expiry at the replica means it rarely has to. `expired` is already in
POD-306's required outbox state list, and ADR 3 D9 defines the state machine it sits
in — D11 supplies only the *reason* the bound must exist and the feed-side numbers it
is measured against.

**The ownership cut, stated once so it is not re-litigated:** ADR 3 owns the outbox —
its states, its horizon, its skew margin, and the lint invariant that enforces the
inequality. ADR 2 owns the feed — change retention and receipt retention — and owns
*why* the inequality is a correctness rule rather than a tidy-up. Neither ADR gets to
restate the other's number; both must reference it.

---

## Consequences

**For POD-305 (Authority):** mint and persist `feedId`/`epoch`, and bump the epoch on
restore (the [spec:SP-4428] backup-restore runbook is now part of this contract); add
`revision` to entity tables via a drizzle migration; publish `minAvailableSeq`; add
`originId`/`causationId` to change rows; implement the bounded send queue and the
`resync-required` signal; correct the retention spec drift; unify
`isProtocolCompatible` with `versionSupport`.

**For POD-306 (Replica + Outbox):** cursor becomes the triple; implement the D7 ladder
with re-bootstrap as the single terminal rung; chunked bootstrap install with delta
buffering and atomic swap; outbox expiry per ADR 3 D10's horizon, with surfaced
recovery, and **the outbox preserved across every discard rung**. The
conformance suite gains: epoch bump mid-session, bootstrap interrupted mid-chunk,
slow-consumer demotion (asserting convergence, not just survival), and a receipt-pruned
replay.

**For POD-307 (clients):** one transaction spanning entity + cursor + outbox;
replica-schema-version bump discards rather than migrates; cursor-after-data only as
surfaced degraded mode.

**For POD-289 (phase gate):** the acceptance criterion "feed epoch, cursor vs
revision, tombstones/retention/compaction, chunked bootstrap snapshot with delta buffering,
reset/gap healing, transactional entity+cursor+outbox persistence, slow-client
backpressure" maps 1:1 onto D1–D11.

**Wire compatibility.** D1 (epoch), D3 (revision), D6 (chunked bootstrap) and D8
(provenance) all change the wire. Per D4 these are: additive fields (no bump) plus one
breaking change to the bootstrap reply (bump, or negotiate by capability and let
POD-308's expiring N/N-1 edge adapter carry the transition). Prefer the capability —
it is the shipped pattern and it kept the oplog rollout at zero breakage.

## Deferred (explicitly not decided here)

- **Resumable bootstrap.** A failed bootstrap restarts. Revisit if bootstrap payloads
  grow enough that a phone on a bad connection cannot finish one — the trigger is
  measured, not guessed.
- **Log compaction beyond head-pruning.** Would break D5's safety argument; needs its
  own ADR.
- ~~**Per-client feed scoping.** Not needed while single-tenant-shaped. Requires
  watermarks (D2); the trigger is multi-tenancy or a must-not-see entity kind.~~
  **STRUCK 2026-07-29 (POD-359 reconciliation) — its own stated trigger fired.** Private-by-
  default (the human decision in `docs/multi-user-readiness.md`) is a must-not-see entity set,
  so this is no longer deferred: it lands in
  [Amendment 1](0002-sync-protocol-amendment-1.md) D12 (per-principal feed), D13 (watermarks —
  supplied exactly as this bullet demanded), D14 (`evict` / `rescope`), D15 (scoped bootstrap)
  and D17 (Phase 2, **before** the POD-308 cutover). Policy is ADR 9 and ADR 1's amendment.
- **`machinesChanged` / `approvalsChanged` / `worktreesChanged` as durable entity
  kinds.** The code flags these as candidates; ADR 7 owns the classification.
- **Node↔hub replication.** Parked in POD-353 per [spec:SP-0371]. D1's `feedId` and
  D8's `originId` are the seam; nothing here builds the hop.
- **Per-field LWW / CRDTs.** ADR 1 owns conflict rules. `changes.event_time` is
  written on every append and already load-bearing for D5's age budget
  (`sync-repository.ts:94`); it remains unused **for arbitration**, which is what
  `oplog-read-path.md` reserved it for ("reserved for P3 LWW arbitration"). Nothing
  here spends that reservation.

## References

- [spec:SP-3fe2] strangler rebuild · [spec:SP-0371] hub deferred · [spec:SP-4428] drizzle-kit · [spec:SP-15aa] instance identity
- `docs/offline-sync-architecture.md` §5 · `docs/spec/oplog-read-path.md` · `docs/spec/outbox-write-path.md` · `docs/spec/thin-client-replica.md` · `docs/spec/node-hub-sync.md`
- `packages/sync/src/ledger.ts` · `packages/sync/src/change-log.ts` · `packages/protocol/src/messages/sync.ts` · `packages/protocol/src/messages/message-class.ts` · `packages/protocol/src/version.ts` · `packages/client-core/src/replica/replica.ts`
- POD-181 (localStorage quota incident) · POD-289 / POD-305 / POD-306 / POD-307 / POD-308 / POD-309 / POD-353
