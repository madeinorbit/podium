# arms/mobx/ — the MobX arm

This folder holds the tests and demo mounts for the round-three MobX pool.
The product data layer lives in `@podium/client-graph` (`packages/client-graph/src`).
The prototype bootstrap/mount adapter is `pool/arm.ts`; the product enumeration
module is `src/enumerate.ts` in that package. The frozen
round-two arm (POD-4447) that used to share this folder was deleted by
POD-4749; the pool never imported it.

## Round three: the pool (`pool/`)

Built on the declared schema (`@podium/client-graph/shared/schema`, L1a), fed row by row
by the kernel feed (`@podium/client-graph/shared/row-source`, `overlaid` mode), handing
each row its L1b `RowView` (`@podium/client-graph/shared/row-view`). Phase a1 (POD-4565)
holds the tables and the row views; Ma2 (POD-4566) maintains every declared
relation; Ma3 (POD-4567) keeps cold rows out until something reads them;
Mb1 (POD-4569) builds the visible collection and its order; Mb2 (POD-4570)
groups it with closed folds and windows the lists; roll-ups (Mb3) come next.

### Idiom

- **Tables from the schema** (`@podium/client-graph/tables`): one shallow `ObservableMap`
  per schema entity — issue, session, worktree, repo — mapping the key to the
  BORROWED row object the feed handed out (never a copy; `deep: false` is
  `observable.ref` per slot). A derivation reading `table.get(id)` subscribes
  to that one slot.
- **Models on first access** (`@podium/client-graph/models`, `MobxPool.model`): ingest
  builds no model; the first read of a row builds its model (Linear's
  "observable on first access"), cached per id, dropped when the row leaves.
  A model holds no row: it reads its slot on every access, so it cannot go
  stale. Every declared field is a getter installed from the schema
  (`installFields`); `FEED_SPELLING` (in `@podium/client-graph/shared/repo-from-lane`,
  POD-4695) names the one field the feed spells
  differently (a repo's `path` is its lanes' `repoPath`).
- **Derived values as cached groups on the model** (`@podium/client-graph/models`,
  `@podium/client-graph/views`): each model computes its values in named cached groups
  (the issue's own-row standing, repo target and display parts, origin
  chain, activity, visibility, nesting, roll-ups), built on first reactive
  read and dropped when unobserved (`@podium/client-graph/cached`), so construction
  builds none and first paint builds only what the list draws. A part reads
  either its own row or a relation target's fields, never both, so a rename
  re-runs neither its neighbours nor its origin. Relations resolve through
  the engine (`inputs.relations.one/many`), never in a part (M3 F2; the lint
  refuses `views.ts` importing `relations.ts`). Objects compare
  structurally (`computedStruct`), so an unchanged part or view keeps its
  identity.
- **Roll-ups re-compose from cached child values** (POD-4568). A part over
  a collection reads the bucket once (`sessionIds`, its own computed) and
  each member's CACHED value, a computed on the member's model
  (`SessionModel.activityMs`), never the member's row: one session's
  `lastActiveAt` re-runs that session's computed (one row read) and the
  issue's `activityAt` over cached siblings. A value that needs a member
  only sometimes asks for it only then (a draft's title reads its first
  member; a non-draft's never does). A member model built earlier is taken
  from the identity memo without a presence read; it reads its own slot, so
  a removed member answers null (the bucket that listed it has moved).
- **Locals as tracked state**: the selection is a one-entry observable map
  (`selection.has(id)`), so a click re-derives exactly two views; the clock
  is a set of deadlines (`@podium/client-graph/clock`): a rule asks "has `t` passed", and
  a tick wakes only the rows whose deadline it crosses.
- **Enforcement configured AND asserted** (`harness/src/mobx-enforce.ts`):
  all four MobX flags on; every pool test installs
  `harness/src/mobx-trap.ts`, which throws on any `console.warn` and fails
  the test on any recorded warning. No `keepAlive`. Out-of-reaction reads
  (`snapshot()`) go through `tracked`, a transient reaction. The product
  pool never configures MobX.
- **Relations from the schema** (`@podium/client-graph/relations`, Ma2): the engine reads
  `schema[entity].relations` at construction and names no relation. Each
  single-valued relation (`belongsTo`, `prefix`, outgoing `edge`) is a link
  with an observable `forward` map (source → target key, members only) and
  observable `buckets` (target key → an observable SET of member ids: its
  inverse collection, UNORDERED). Ingest tells the engine of every table
  write; it re-resolves only links whose declared inputs moved (key/path/edge
  field and every `where` field), detaches then attaches, and the action's
  one `flush` applies each touched bucket's NET moves once: one element added
  or deleted per edge moved, whatever the bucket's size (M3 F1; the round-
  three a-phase copied and sorted the whole bucket, 4,575 elements for one
  new issue on the live export). An order a reader needs is applied at view
  time (`sessionIds` sorts its members). The `prefix` link keeps an ancestor
  index (`under`) so a new root takes its sessions without a scan, and a
  removed root hands them to the next-longest root. The session resume-twin
  collapse is declared in the schema (`session.collapse`,
  `collapseLosers`); a collapsed row contributes no edge. Derivations read
  buckets only through the shared `RelationReader` (`one`: one read; `many`:
  one per member, unordered; `size`: free). Adding a relation to the schema needs no
  code here (`relations.test.ts`, the fixture-schema test).

- **Residency from the schema** (`@podium/client-graph/residency`, Ma3): a row the
  schema's `cold` spec lets stay out (a closed issue; a session of one) is
  never put in a table. A plain registry holds its id, the relation engine
  links it, and its relation slots live in plain twins until it is resident.
  A derivation that reaches it through a lazy relation gets `loading`
  (`ViewInputs.loading`, `RowView.loading`, `MobxPool.resident`,
  `MobxPool.lazyMany`) and queues it; one 50 ms window loads every queued
  row by id through the feed (`RowSource.row`) in ONE action
  (`MobxPool.hydrate`, which reports how many rows it installed). An update
  that makes a row itself not cold (a reopen) installs it and the sessions
  that inherited coldness from it at once. A resident row never goes cold
  except on `replace`, which re-partitions.

- **Visible collection and order** (`pool/worklist/visible.ts`, Mb1): R-VIS
  (slice spec §3, executable in the oracle) as parts read off each issue's
  model, hot or cold: own-row standing, R2+R3 members, retention against the
  clock's deadlines, the flat pass, the rescue read down `children`
  (`keeps`/`keptBelow`), and nesting (nearest present ancestor, the started-by
  fallback). A cold issue is hidden by the complete rule (POD-4745), so its
  presence is answered from a declared summary (`HIDDEN_ISSUE_FIELDS`: its raw
  parent for the nesting walk, and whether it is excluded), never from its row
  or its sessions' (POD-4753); startup reads no row by id. A row not in memory
  answers `LOADING` through the one reader (`MobxPool.row`) and is loaded only
  when drawn, in the 50 ms window's batch.
  The set of visible ids is MAINTAINED by one filing reaction per resident
  issue (`VisibleCollection.track`: taken when the row enters the table,
  released when it leaves, first run when the action ends), each filing its
  row's placement and rank wherever it belongs; afterwards it re-files the
  row when its filing changes, and only then. The order is the maintained
  rank-ordered lane; the groups file each row the same way. A cold row is
  never tracked and files nothing. A cold visible row is drawn as a
  placeholder outside `RowShell` until its load lands.

- **Groups and closed folds** (`pool/worklist/groups.ts`, Mb2): R-GROUP over
  the order. Each node carries a `placement` (`computedStruct`: pinned, group
  key and label, fold verdict, fold stamp) read from the own row, hot or cold;
  one `layout` computed over the order and the visible placements (the
  snapshot's `SliceOrder`, no selection) re-runs only when either moves; one
  `GroupNode` per key holds its lanes as shallow-compared computeds with the
  R-GROUP 5 latch applied. The rebuild groups its own views with L1b's
  `groupKeyOf` / `compareClosedFold` instead.
- **Lists** (`pool/react/list.tsx`, `pool/native/list.tsx`, Mb2): the web list
  windows with `@tanstack/react-virtual` (56 px rows, 40 px headers; every item
  when the container has no height, i.e. the happy-dom count lane); the native
  list is a `SectionList`. The list observes the grouped ids, a header its own
  group's lanes, a slot its row's presence, the row its `view`.

### The enumeration module

`@podium/client-graph/enumerate` is the ONE module that walks a whole table
(`fence.json` `enumeration`; the lint's `no-table-walk` refuses a walk
anywhere else in `pool/`): `reseed` (a `replace`). The from-scratch checks
the gates hold the pool to live in the harness
(`harness/src/adapters/mobx-rebuild.ts`, POD-4945), never in product:
`scanRelations` (the declared resolvers over whole tables) and
`diffRelations` (the live engine against that scan, for the relation tests
and the gate), plus the gate's residency walks: `knownTables` (every row
the pool knows, cold ones from the feed) and `diffResidency` (the hot/cold
partition against the feed), and `rebuildSnapshot` / `rebuildViews` (the
slice recomputed from scratch).

### Write path (phase c: optimism on the model, Mc1/Mc2)

`pool/write/` holds the pending display beside the pool; the kernel stays the
transport, the durable queue and the authority on outcomes, and the pool's
tables go on holding BORROWED server rows, never a copy.

- **Where pending lives.** An observable map of per-row overlays
  (`write.overlays`: the newest pending value per editable field —
  title/stage/readAt only, never a full row), mirrored from the reference
  pending log (`@podium/client-graph/shared/write-contract` `createPendingLog`, re-exported
  by `pool/write/pending.ts`; the arm owns no log of its own). It is overlaid
  at the row-reader boundary (`pool.inputs.issue`,
  `pool.visibleInputs.issueRow` / `loadedIssue`) plus the
  read cursor (`pool.visibleInputs.issueRead`, so a pending mark-read flips
  the unread/decay verdicts at once, exactly as the overlaid row flips the
  rebuild's): no pending edit returns the server object unchanged
  (identity-preserving, idle layer invisible); with one a transient
  `{...server, ...pending}` is returned (never stored, so the copy sweep
  never sees it).
- **What the kernel still owns.** The command (`commandFor`: title/stage ride
  `issues.update`, `readAt` rides `issues.markRead`), the queue and its
  persistence, the receipt (`accepted` = outbox `applied`, L3b), the echo
  (the server row, recognised by value: exact for title/stage, the server's
  own stamp for `readAt`), the refusal (parked or discarded) and the collapse
  (mark-read supersede). The arm never reads the kernel's fold (W12): its
  feed runs in `truth` mode, server rows only.
- **The loop.** `edit` paints in one action and sends without awaiting;
  `handleAccepted` records the receipt (the entry stays until its echo
  confirms every field — dropping on receipt alone would flicker); the echo
  arrives as an ordinary feed row and settles with zero extra commits when
  its values equal the pending ones (no equal rewrite, PITFALL); a remote on
  a pending row keeps the local value and takes the rest; `reject` rewinds
  from the log and surfaces the error; `handleSuperseded` drops a collapsed
  mark-read without repainting; `expire` drops receipted edits past the TTL;
  a duplicate receipt is a no-op. `bootstrap` re-applies the outbox's pending
  entries on creation under their own mutation ids without re-sending, over
  the feed's server rows (the reference oracle's reload rebuild reads the
  same rows, so the two resolutions agree exactly), so pending edits survive
  a principal-preserving rebuild.
- **The rebuild is optimism-aware.** The harness-owned `rebuildFromScratch`
  (`harness/src/adapters/mobx-rebuild.ts`) overlays the pending
  display onto the feed's server rows before deriving, so a gate with pending
  edits outstanding compares pending with pending — never with server truth.
- **The gate adapter** (`shared/src/gen/arm-edits.ts`, shared with the hand
  arm's Hc2): generated edits call the live arm's `write.edit` while its
  transport invokes the same runtime action, so the kernel mints the mutation
  id and the runner learns it from the outbox as before; outcomes and
  `pending()` entries are translated between kernel and arm ids for receipts,
  rejections and bootstrap across reloads.

Tests: `pool/write/edit.test.tsx` (paint, rewind, order, mark-read,
stacking), `pool/write/settle.test.tsx` (echo zero-commit, remote-on-pending
one commit, duplicate no-op, rebuild and bootstrap re-apply),
`pool/write/gate-truth.test.ts` (L4b on the truth feed with arm edits: the
whole-snapshot shared write oracle, complete-or-fail per-seed rows, plus the
(a)/(c) write-path plants on fixed sequences, the visibility plants (i)/(ii)
and the late-remote plant (iii)), `pool/write/gate-with-
edits.test.ts` (the phase-a/b gate still passes with the layer attached but
idle).

### Stats (what each counter counts)

The product pool keeps no counters (POD-4945): the arm contract's
`ArmStats` are satisfied with zeros by the harness adapter, and every
number below is counted from outside.

- `rowsDerived`, `rollupsDerived`, `indexUpdates`, `notifications` — the
  contract's counters, all zero from this arm. Per-change work is measured
  by the harness instead: the work meter and the borrowed-row counts
  (`harness/src/work-per-change.test.tsx`), and the fence's commit/read
  budgets per scenario.
- `bucketElements` (M3 F1) — relation bucket ELEMENTS touched: one per
  member added to or deleted from a bucket. Counted outside the pool, never
  by it: `relations.test.ts` "bucket upkeep is proportional to the change"
  patches MobX's `ObservableSet` prototype (and plain `Set`/`Map`) around
  the push and asserts that count (4,000-member buckets, 1 per insert and
  per delete).
- Tracking objects — `pool/tracking-counts.test.ts`: a MobX census
  (`harness/src/mobx-census.ts`) traps MobX's own classes, so every
  computed, reaction, observable value, atom, map, set, array and observable
  object the pool builds is counted from outside and held to
  `harness/src/tracking-counts.baseline.json`.
- Loads — counted by the feed, not the pool: tests wrap `RowSource.row`
  and count per-row reads; the harness drain observes the load window from
  outside (an armed window means loads are pending;
  `harness/src/adapters/mobx-pool.ts`).
- Reads are never counted by the arm: every table read goes through
  `reads.wrapTables`, every relation read through `reads.wrapRelations`, and
  the enumeration records each id it walks with `reads.touch`.

### Gates (a phase, POD-4568)

- **Correctness (L4b)**, `pool/gate.test.ts`: rebuild-only (`oracleEvery:
  0`; the oracle compares order and roll-ups, Mb4's). Defaults are 3 seeds x
  200 steps; the gate of record is 20 x 300, run from the repo root:
  `POD_POOL_GATE_SEEDS=20 POD_POOL_GATE_STEPS=300 bun scripts/test-heavy.ts
  -- bash -c "bun --bun ./node_modules/vitest/vitest.mjs run --config
  vitest.unit.config.ts --project node
  packages/worklist-proto/arms/mobx/pool/gate.test.ts"` (heavy lease only;
  `test:file` inside `test-heavy` would also hold a focused slot for hours).
  Each seed also runs four planted arms, and each must fail on every seed:
  removal-deaf (caught by the rebuild), cold-deaf and relink-skipped (by
  the per-step checks), and promote-skipped for sessions (by the
  full-residency checkpoint alone).
- **Bucket work (M3 F1)**, `pool/relations.test.ts` "bucket upkeep is
  proportional to the change": 1 element per edge in 4,000-member buckets,
  COUNTED OUTSIDE THE POOL (M3 G1): the test patches MobX's `ObservableSet`
  prototype (`add`, `delete`, `values`, which every iteration goes through)
  and `Array.prototype.sort`/`toSorted` around the push, and asserts that
  count; `bucketElements` must then equal it. The pool's own counter alone is
  not evidence: a copy-and-sort that does not report itself leaves it at 1.
  PLAIN SETS AND MAPS TOO (M3 G3): the prefix index is a map of plain `Set`s,
  so the test also patches `Set` and `Map` (writes, deletes, every iterator,
  `forEach`) and `Array.from`, skipping calls MobX makes on its own sets.
  That count must stay under the change's own bookkeeping (16) plus two per
  ancestor path of the row, plus one: an unsorted copy of one prefix set
  (8,003 elements per new session) fails it.
  AND NO SET IS SWAPPED (M3 G4): a copy no patched method makes
  (`set.union(new Set())`, `structuredClone(set)`) is caught by identity: no
  set the engine holds (`under`, `buckets`, `coldBuckets`, collapse
  `groups`) may be a different object after one edge.
  M3's probe (`harness/review/m3-shape-probes.test.tsx`, with
  `M3_LIVE_EXPORT`) prints the same count on the live export.
- **Fence steps #1-#4**, `pool/counts.test.tsx`: the shared
  `assertCommits` (#1-#3), `assertReads` and `assertNoCopies`, no parity.
- **Every fence step #1-#10 with parity**, `harness/src/fences.test.tsx`:
  the pool is on the roster (`harness/src/roster.ts`, POD-4572) with no
  allowances (POD-4671 fixed: parity holds exactly, so the named exception
  is gone with it; POD-4674 `activityAt` and POD-4678 #10 reads likewise
  need none).
- **The console trap** (M3 N3): `installMobxWarnTrap({ errors: true })` also
  fails a test on any `console.error` (MobX reports a throw inside a reaction
  there); the native lane runs under it. The browser driver fails a candidate
  arm's run on any console warning or error (`run.ts`; proof plants
  `--console-plant warn|reaction`). The production pages compile MobX's
  enforcement warnings out, so enforcement proper is asserted in the count
  lanes.
  A STEP COUNTS ITS OWN LOADS (M3 G2): the handle's `settleLoads()` flushes
  the arm's redraws and lands what they queued until nothing is queued, and
  the shared fence (`runFenceStep`) awaits it inside each step before the
  reads are sampled; `pendingLoads()` lets it refuse a step that leaves one.
  It finds the feeds by `feeds.flush`'s identity and refuses any other
  flush (N9), so a wrapper cannot switch the lazy-arm refusal off.
  M3's cold-issue plant fails #2 there (2,839 reads, budget 3).
- Numbers: `docs/measurements/POD-4568-a.md`.

### How to add a field

1. Declare it in `@podium/client-graph/shared/schema` (coordinator: the schema is shared).
   The model gets its getter from the schema; `pool/models.test.ts` reads it
   off a model with no edit. If the feed spells it differently, add it to
   `FEED_SPELLING` in `@podium/client-graph/shared/repo-from-lane`.
2. If a row view shows it: `@podium/client-graph/shared/row-view` (coordinator), then
   compute it in the part whose inputs it reads (`@podium/client-graph/views`: own-row
   fields in `ownPartOf`; a new relation hop as a target part that reads
   `inputs.relations.one(...)`, never the own row, plus a part that reads
   the target's fields) and assemble it in `buildRowView`. A new part is a new
   computed on `IssueModel` and a new getter in `directParts`, which the
   rebuild uses, so the correctness gate (`pool/gate.test.ts`) holds the two
   together.
3. Never read a row in `view` itself, and never read a target in a part
   that also reads the own row: that is how a rename starts charging reads
   to its neighbours (`pool/counts.test.tsx` fails the budget).
4. A field over a collection (a roll-up): put each member's contribution in
   a computed on the MEMBER's model, add it to `ViewInputs` (the rebuild
   computes the same function directly), and walk the cached member list
   (`sessionIds`), never the relation or the member rows, in the parent's
   part. Reading member rows re-reads the whole family on every member's
   change (POD-4568: #2 read 4 rows against a budget of 3).

