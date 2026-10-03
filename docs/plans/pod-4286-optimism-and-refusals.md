# POD-4286 — Optimism and refused changes: one rule (design spec, POD-5426)

**Status:** design for operator review. No product code changes with this document.
**Date:** 2026-10-03. **Base:** `integrate/4286-pilot` at `70f3c661f4`. Every `file:line` is at that
commit.
**Inputs:** POD-5417 review findings 13 and 19 (`docs/reviews/pod-4286-mobx-architecture-review.md`),
POD-5415 (a refused rename blocks later changes to the same issue) and its queue proof (POD-4978,
`docs/measurements/POD-4978-mobile-actions.md` and the attached `mobile-queue-audit.json`), and the
operator's direction of 2026-10-03: refused changes follow ONE sync-system rule, best practice as in
Linear and Replicache.

**Evidence labels.** **READ** = from code or docs in this tree. **RUN** = measured (only the POD-4978
queue audit, which was run on `ccce76d346` by that issue, not by me). **EXT** = published behaviour of
Linear or Replicache, quoted from their public descriptions. **INFERRED** = follows from read code but
was not traced end to end.

---

## 0. Summary

**The rule.** The server decides. Every change the user makes is shown at once and recorded as a
durable queued command. Each change waits only for an answer about the changes before it on the same
thing. A **definitive answer** (accepted or refused) lets the next change go. Only an **unknown
outcome** (in flight, network failure, server error) holds it. A refused change is removed from what
the screen shows: the row goes back to the accepted state with every later pending change still
applied on top. If the user typed words, those words are kept and can be recovered. Nothing waits
behind a refusal, and the server refuses a later change that no longer makes sense by itself.

This is exactly Replicache's push rule and Linear's rollback rule (section 2).

**What changes, in four pieces:**

1. **Queue rule (fixes POD-5415 for old and new screens alike).** A parked (refused or expired) entry
   stops holding its partition, for every command. `OUTBOX_PARKED_YIELDS_PARTITION` is deleted. A
   retried or edited entry goes to the back of its partition. This needs an ADR 3 D12 amendment.
2. **Server prerequisite.** Every refusal of a state precondition is a typed answer (409 or 412), never
   a bare `Error`. Today "already deleted", "not deleted" and "shipping stage" throw a bare `Error`,
   which the client treats as a temporary failure and retries for 14 days. That holds the partition
   just as a parked rename does, under the old rule and the new one alike.
3. **One pending set, projected by the pool.** The legacy ledger stays the only owner of the pending
   set and its life cycle, but it is made keyed: it reports which rows' pending changes moved. The pool
   applies one row's pending changes at write time and stores the result, so reads are plain. The
   pool's own unused write stack (`write/*`, `write-contract.ts`, `receipts.ts`, 1,448 lines) is
   deleted, not wired.
4. **Keyed inputs, then the legacy publish off.** The 13 pool adapters on `runtime.subscribe` move to
   keyed inputs: pending rows, local keys, discovery rows, drafts per session, a cursor signal. The
   legacy snapshot's whole-array fold becomes lazy, so it costs nothing while no legacy screen reads it.
   It is deleted with the last legacy screen (F4).

**Decisions asked of the operator** are in section 10. The main one: the coordinator recommended
"the pool owns optimism". I recommend a narrower version: the pool owns the **projection** (how a
pending change looks on a model), and the pending set keeps **one** implementation, the ledger's.
Wiring the pool's `write/*` instead would create a second pending set with less coverage (section 5).

---

## 1. Current flow (READ unless marked)

### 1.1 Where a click goes

A stage change, rename, tuck or read on any screen, legacy or pool:

1. A store action calls `runtime.enqueueOverlayed` (`client-core/src/engine/optimism.ts:952`). It mints
   the `mutationId`, records a fingerprint of the row as `baseline`, sets `chained` if an entry for the
   same row is already pending, and **paints before the durable commit**. If the enqueue throws, it
   unpaints (`:1016`).
2. The kernel `Outbox` (`packages/sync/src/outbox/outbox.ts`, through `client-core/src/engine/kernel-outbox.ts`)
   stores the record durably: `mutationId`, `command`, `input`, `partitionKey` (for example
   `issue:<id>`), optional `collapseKey`, `attribution{actor,onBehalfOf}`, `state`, `queuedAt`,
   `attempts` (`sync/src/outbox/records.ts:240`).
3. The ledger has no stored copy of the queue. `overlaysFor` derives the pending overlays fresh from
   `outbox.pending()` each pass, in this order: spawn placeholders, awaiting-truth, queued FIFO,
   painted-but-unqueued (`optimism.ts:508-538`). The comment states the design: "the outbox itself is
   the queued-overlay state, never a second copy".
4. **Legacy screens:** `publishReplica` (`runtime.ts:1539-1580`) rebuilds whole lists per batch. If
   sessions, user states, machines or repos changed, it rebuilds `sessionViews` and repaints every
   session. If either issue kind changed, it folds the ledger over the whole issue array
   (`recomputeFor`, `foldStable`, `optimism.ts:575-600, 847`).
5. **Pool screens:** the row source runs in `overlaid` mode, the only production mode
   (`client-graph/src/runtime-pool.ts:127`). It wakes on that same whole publish
   (`shared/row-source.ts:1252`), then `readPending()` (`:518-526`) builds four whole maps through
   `pendingByRow` (`optimism.ts:544`). For each addressed or pending row it applies that row's overlays
   with the ledger's own per-row fold, `foldRowOverlays` (`client-core/src/engine/overlay.ts:942`), and
   emits the row only if it moved (`row-source.ts:1121-1148`). Then `pool.apply`.
6. The drain sends `{...input, mutationId}` (`kernel-outbox.ts:144`). The server dedupes by
   `mutationId` through `ctx.withMutation` (`command-ctx.ts:256`). Receipts are kept 30 days.
7. **Accepted:** `mutationApplied` (`optimism.ts:862`) moves the overlay to `awaitingTruth` until the
   echo covers it, or 60 s pass (`AWAITING_TRUTH_TTL_MS`, `:151`), or the row moves past its baseline.
8. **Refused:** the client classifies the answer (`client-core/src/outbox.ts:251`): 401/403 →
   `unauthorized`, 404 → `target-not-found` (merged into `unauthorized` so no existence oracle leaks,
   `sync/src/outbox/reasons.ts:82`), 409 → `conflict`, 412 → `confirmation-required`, 400 → `invalid`.
   **Anything else, including 500, is transient** and is retried with backoff (1 s doubling to 60 s)
   until the 14-day age limit. A definitive refusal goes `rejected → dead-letter` (parked) with zero
   retries (`outbox.ts:750`). `mutationDropped` (`optimism.ts:913`) removes the paint. Rollback is not
   an inverse operation: the entry is no longer pending, so the next fold stops applying it.
9. **Park or snap back.** `shouldParkDeadLetter` (`engine/wiring.ts:390`) parks only when the input
   holds authored text: "A refused stage click, tuck, or pin just snaps back — Linear-shaped." Otherwise
   the entry is discarded automatically with a toast (`kernel-outbox.ts:100-111, 393-408`). The parked
   entry keeps the author's input verbatim. The recovery chip offers retry, edit and discard
   (`apps/web/src/features/machines/OutboxRecovery.tsx:242-307`). By design it **never reads the
   target**, so a refusal caused by lost access cannot leak the target's content
   (`docs/design/outbox-dead-letter-recovery.md` §3).

### 1.2 The partition rule that causes POD-5415

The drain is FIFO within a partition and concurrent across partitions. A partition stops at its first
entry that is not `queued`, is backing off, **or is parked** (`outbox.ts:599-656`). The one exception is
`yieldsWhenParked` (`:1199`), configured by `OUTBOX_PARKED_YIELDS_PARTITION` (`engine/wiring.ts:661`),
which holds only `sessions.sendText` and `sessions.resumeAndSend` (POD-4762: "a chat message that
visibly failed does not hold the next one the user writes").

This is written policy, not an accident. ADR 3 D12 (`docs/adr/0003-command-security.md:416-433`) ends:
"A blocked / dead-lettered entry blocks **only its partition** until recovery or cancel." The same ADR
also says, at D10, "Validation poison: Dead-letter … **never wedge the partition**." Those two
sentences disagree. The code follows D12, and the lifecycle conformance table pins it ("a parked head
blocks only its own partition, on every later pass", `docs/design/outbox-lifecycle-state-machine.md:78`).

**The queue proof (RUN by POD-4978 on `ccce76d346`, synthetic, shared profile):**

| Time (UTC) | Record | State |
|---|---|---|
| 15:26:36.121 | `issues.update` rename A, partition `issue:iss_90f8…` | sent, refused at .158, parked (`dead-letter`) by .203 |
| 15:26:36.327 | `issues.markRead`, same partition (mission open after the refusal) | `queued`, attempts 0 |
| 15:26:43.222 | `issues.update` rename B, same partition | `queued`, attempts 0, still at 15:26:48.130 |

The banner read "1 change needing review and 2 queued". The read receipt and the second rename are
painted as pending and are never sent until the user deals with rename A. A drain delay cannot clear
it: only the user's retry or discard can.

### 1.3 A second wedge with the same effect (READ)

The server throws a bare `Error`, which reaches the client as a 500, for state preconditions:

- `prepareSoftDelete`: `issue … is already deleted` (`apps/server/src/modules/issues/service/crud.ts:1457`)
- `prepareRestore`: `issue … is not deleted` (`:1596`)
- `update`: `shipping stage is system-owned …` (`:1109`; the same refusal at `:929`, `:1828` and `:1851`)

Only `IssueNotFound` is mapped to a typed code (`issues/trpc.ts:74-78`). A 500 is transient on the
client, so such an entry retries for 14 days **and holds its partition the whole time**. That happens
today, independent of the parked-entry rule. `not-found.ts:13-26` records the same class for read
receipts, already fixed there.

Also READ: `crud.update` throws only for a missing row and does not check `deletedAt`, so an update to a
soft-deleted issue succeeds (`crud.ts:1099`). And the client never sends `expectedRevision`
(`kernel-outbox.ts:144` sends only input plus `mutationId`; the server accepts an omitted revision,
`authority-arbitration.ts:88`). So no issue write has a version precondition in practice.

INFERRED, verify before relying on it: when a non-authored refusal is discarded automatically, the drain
stops that partition first and nothing in the discard path starts a new drain. Later entries for the
same issue then wait for the next unrelated drain trigger.

### 1.4 Two optimism systems (finding 19)

- **In production:** the ledger above, delivered to pool screens by the `overlaid` row source.
- **Unused:** the pool's own stack: `write/edit.ts` 480, `write/overlay.ts` 88, `write/pending.ts` 13,
  `write/create.ts` 51, `shared/write-contract.ts` 566, `shared/receipts.ts` 250 = **1,448 lines**.
  - Its only caller is the worklist prototype harness (`createWritableWorklistPool`, used by
    `packages/worklist-proto/arms/mobx/pool/write/arm.ts:22`).
  - Nothing in `apps/` creates a writable pool. `createRuntimeWorklistPool` passes no `writes`, so
    `IssueModel.update` (`models.ts:637-639`) and the generated setters throw in production
    (`pool.ts:762-767`).
  - It costs the hot reader anyway: `pool.row` checks `writes?.pending(...)` on every read
    (`pool.ts:670-672`), and `readCursor` does the same (`:704-710`). In production that is one
    short-circuit, but it is a second branch in the one reader.
  - It reuses the same outbox (`receipts.ts:220-239` calls `runtime.enqueueOverlayed`), so the ledger
    would paint underneath it. Its scope is issues only, three fields (`title`, `stage`, `readAt`), and
    cold rows cannot be edited.

### 1.5 The legacy publish (finding 13)

Entity rows reach the pool row by row, but **13 production adapters** subscribe to the runtime's
whole-snapshot publish (`ClientRuntime.subscribe`, `runtime.ts:656`). It fires once per apply batch, and
each adapter re-reads its slice of `getSnapshot()`:

| # | Adapter (`packages/client-graph/src/…`) | Reads | Keyed input that replaces it |
|---|---|---|---|
| 1 | `shared/row-source.ts:1252` | ledger (4 whole maps), discovery `repos` | pending-rows event; discovery rows |
| 2 | `shared/engine-locals.ts:19` | `selectedIssueId`, `coarseNow` | local-key event |
| 3 | `header-source.ts:77` | machines, repos (whole array on identity change), window, `outboxSize` | machine by id, discovery row, local keys, outbox count |
| 4 | `session-pane-source.ts:32` | window keys, `pendingSpawnIds` | local keys; pending-rows event (spawn) |
| 5 | `shell-source.ts:42` | 9 window keys (structural compare per publish), approvals, file tabs, workspaces | local keys; approval, tab and workspace by id |
| 6 | `command-launch-source.ts:55` | repos (a change re-links ALL resident sessions), machines, window | discovery row; machine by id; local keys |
| 7 | `mobile-inbox-source.ts:27` | nothing; a wake-up to re-read the cursor | cursor signal |
| 8 | `chat-context-source.ts:27` | `drafts[sessionId]`, window | draft-per-session event; local keys |
| 9 | `superagent.ts:74` | `superThreads` (full rebuild), window; counts all sessions while booting | thread by id; local keys; a booted latch |
| 10 | `settings-source.ts:25` | machines, repos (full rebuild), `settingsTab` | machine by id; discovery row; local key |
| 11 | `mobile-settings.ts:71` | lengths of the overlaid issue list and conversations, cursor | count and cursor signals |
| 12 | `mobile-session-context.ts:125` | `pendingSpawnPrompts`, cursor | pending-rows event (spawn); cursor signal |
| 13 | `issue-board-source.ts:89` | `openIssueId` | local-key event |

While any of them is subscribed, the runtime must keep publishing, and each publish rebuilds whole
arrays (step 4 in 1.1). No switch turns that off.

---

## 2. What Linear and Replicache do (EXT)

**Replicache** (`doc.replicache.dev/reference/server-push`):

- "If a mutation is invalid or cannot be handled, the server must still mark the mutation as processed
  by updating the `lastMutationID`." Otherwise "the client retries endlessly and becomes blocked".
- A *temporary* error may halt processing without advancing, which holds later mutations from that
  client until a retry.
- The client keeps pending mutations and, on each pull, re-runs them on top of the new server state
  (rebase). A refused mutation's effect therefore simply disappears.

**Linear** (public reverse-engineering, `github.com/wzhudev/reverse-linear-sync-engine`):

- A property change updates the in-memory model at once and records the changed property and its old
  value. A transaction is queued and sent in batches.
- "When the server rejects a mutation, the transaction will trigger its `rollback` method … and be
  removed from the `executingTransaction` queue." Later transactions are not held.
- Sent transactions stay as "completed but unsynced" until the matching delta arrives, then local
  models take the server's values.

**Common shape:** temporary failures hold order; a definitive refusal is final for that one change and
never blocks the next. Pending changes are re-applied on the latest accepted state. The server is the
only judge of whether a later change still makes sense. The client never guesses dependencies.

Podium already matches this shape everywhere except the parked-entry rule (1.2) and the untyped server
refusals (1.3). The ledger's "stop applying" rollback is Replicache's rebase. The awaiting-truth stage
is Linear's "completed but unsynced". The snap-back for stage, tuck and pin is Linear's rollback.

---

## 3. The rule, stated for the code

> **R1.** An outbox entry holds its partition only while its outcome is **unknown**: `sending`, or
> `queued` after a transient failure (backing off). A **definitive** outcome (`applied`, `rejected`,
> `expired`, `cancelled`) releases the partition at once. This holds for every command.
>
> **R2.** A refused or expired entry leaves the pending set in the same action that records the
> refusal, so the screen shows the accepted state plus every remaining pending change, in queue order.
> If the input holds authored text, the entry is parked with the input verbatim (unchanged policy).
> Otherwise it snaps back with a toast (unchanged policy).
>
> **R3.** Recovery is a **new act by the user, at the time of recovery**. Retry and edit put the entry
> at the **back** of its partition, behind everything already queued. Edit mints a new id (as today).
> Retry keeps the id only where D11.4 allows it (unchanged), but takes a new position.
>
> **R4.** The server answers every precondition refusal with a typed code. Only a genuine fault may
> surface as a 500. Then "the server refuses dependants itself" holds: a later change that no longer
> makes sense after an earlier refusal gets its own definitive refusal, and R1 releases it.
>
> **R5.** Commands are intents re-applied on the accepted state, not deltas against the optimistic
> state. Issue patches already set absolute values. Per-contract `expectedRevision` (ADR 3 D13) stays
> available for a contract that needs it. This spec does not turn it on.

Why R1 is safe: ordering exists so that two of the user's intents on one thing land in the order they
were made. A refused entry will never land in its original position. R3 sends any retry to the back,
so letting the next entry go cannot reorder anything that will actually apply. An expired entry may
have landed with only its answer lost (D11). Either way, sending the next entry after it keeps the
user's order.

Why R3 matters under R1: today a retried entry keeps its record position (`outbox.ts:999-1030`
transitions it in place). Under the old rule nothing behind it had been sent, so the position was
harmless. Under R1, entries queued behind it but not yet sent (offline) would go **after** the retry,
and an older intent would overwrite the user's newer one. Moving the retry to the back keeps the
user's actual order: the retry is the latest act.

What R1 changes for POD-5415's sequence: rename A is refused and parked. The read receipt and rename B
send at once. The banner reads "1 change needing review" and nothing is queued behind it. Rename A's
text stays recoverable. If the user retries it after rename B landed, A wins, because that is what the
user did last.

---

## 4. Target design

### 4.1 The queue (owner unchanged)

The kernel `Outbox` stays the only durable queue and the only place commands enter. That is the
"one mutation owner" rule. Changes:

- `outbox.ts` partition scan (`:599-656`): a parked entry no longer stops the scan, for every command.
  `yieldsWhenParked`, the `parkedYieldsPartition` port field (`ports.ts:303`) and
  `OUTBOX_PARKED_YIELDS_PARTITION` (`wiring.ts:661`, `kernel-outbox.ts:47, 570`) are deleted.
- `retry` and `edit` move the record to the back of its partition (R3). Edit already creates a new
  record. Retry needs a re-order, done in the same durable span as the transition.
- Any transition that releases a partition (park, discard, cancel, automatic discard) triggers a drain.
  This closes the INFERRED gap in 1.3.
- The conformance row "a parked head blocks only its own partition, on every later pass" is replaced by
  "a parked head blocks nothing; a backing-off head blocks its partition; a retried entry drains after
  every entry queued before the retry".

### 4.2 The pending set (one implementation, made keyed)

The ledger already has the complete pending life cycle:

- painted before commit, and unpainted if the commit fails;
- spawn placeholders and their grace period;
- queued, awaiting truth, and coverage by the echo;
- the "moved past baseline" rule;
- per-user absent rows;
- principal scoping by construction (`optimism.ts:29, 450`).

The pool's `write/*` re-implements a subset of that (section 5). The target keeps the ledger as the
**only** pending set and changes two things:

1. **A per-row index**, maintained on every pending change (paint, enqueue, transition, retire, spawn
   grace, awaiting-truth expiry), instead of `overlaysFor` rebuilding all overlays for an entity and
   `pendingByRow` rebuilding a whole map per call. `overlaysForRow(entity, id)` is O(that row's
   entries).
2. **A keyed event**, `onPendingRows(changes: {entity, id}[])`, emitted once per action with the rows
   whose pending list changed. Writes from another tab on the same store arrive through the outbox's
   existing rebase notification and produce the same event.

The whole-array fold (`recomputeFor`, `foldStable`, `recomputeSessions` painting) stays only as the
legacy screens' projection. It becomes lazy (4.5) and is deleted at F4.

### 4.3 The projection (owned by the pool)

The pool owns how a pending change looks on a model:

- The row source keeps the server row (`truth`) and the visible row. On a truth change for row X, or a
  pending-rows event naming X, it computes `visible = foldRowOverlays(truth, overlaysForRow(X))`, the
  same per-row fold it uses today (`row-source.ts:428`). It stores that in the table in one action. With
  no pending entries, `visible` is the truth object itself, so identity is kept end to end.
- Reads are plain table reads. `pool.row` and `readCursor` lose the `writes?.pending` branch, and
  optimism no longer needs the overlay Proxy (`shared/overlay-row.ts`; that file's other users belong to
  POD-5416). A pending change costs one allocation when it changes, not one per read.
- This is Linear's "mutate the model, record the transaction" in effect: the click paints the model in
  the same action that records the durable command, and rollback is automatic. What differs from
  Linear is how rollback works. Linear keeps old values and runs an inverse. Here the row is recomputed
  from truth and the remaining pending list, which is Replicache's rebase. Recomputing needs no stored
  "prior" values, so a refusal in the middle of a chain cannot restore a stale value.
- Write entry point: screens keep calling the runtime's command actions (`use-pool-unified-work.ts`
  and the store actions), the single entry point. Model setters (`issue.title = …`) are API style, not
  semantics. Section 10, D3.

### 4.4 Refusal on screen

- A refused change disappears from the row in the same action that records the refusal (R2).
- Authored text: the existing recovery chip lists it ("N changes didn't sync — Review or discard each
  one"). Retry, edit and discard follow R3. The surface keeps its two security rules: it never reads the
  target, and its affordances come from the reason code only.
- No authored text: snaps back with the existing toast.
- The "N queued" half of the POD-5415 banner can no longer occur from a refusal. It can still appear
  while offline or backing off, which is correct.

### 4.5 Keyed inputs and switching the legacy publish off

Each adapter in 1.5 moves to keyed inputs from the one producer that already owns the value:

| Input | Producer | Shape | Adapters |
|---|---|---|---|
| Pending rows | ledger (4.2) | `onPendingRows([{entity,id}])` | 1, 4, 12 |
| Local keys | the runtime's single locals writer | `onLocals(changedKeys)` plus `readLocal(key)` | 2, 3, 4, 5, 6, 8, 9, 10, 13 |
| Discovery | the discovery producer | machine by id, repo by `[machineId, path]`, upsert and remove | 1, 3, 6, 10 |
| Window lists | runtime | approval, file tab, workspace, super-thread by id | 5, 9 |
| Drafts | draft ledger | `onDraft(sessionId)` | 8 |
| Cursor and counts | replica, outbox | cursor-moved signal; outbox size | 3, 7, 11, 12 |

Each adapter then wakes only for its own keys. That fixes finding 13's two whole-history adapters too:
chat context reads the pool's tables and residency, and `issueExit` copies `session-exit-source.ts`'s
per-id demanded set.

**Switching off.** The legacy snapshot becomes lazy. `publishReplica` records which kinds changed and
bumps a version. The folded `issueProjections`, the rebuilt `sessionViews` and the ledger fold are
computed on `getSnapshot()` read, memoized by version, not eagerly per batch. With pool screens on and no
legacy reader mounted, no whole-array work runs. Subscribers still get a notification, which costs one
call per subscriber. When an adapter moves to keyed inputs it unsubscribes from `runtime.subscribe`. When
the last legacy screen is deleted (F4), the fold, `readChanged` and the snapshot store go with it.

---

## 5. Evaluation of the coordinator's recommendation

| Point | Verdict | Why |
|---|---|---|
| (1) The pool owns optimism (Linear's shape) | **Agree, narrowed** | Optimism has two parts. The **projection** (how a pending change looks on the model, applied at write time) moves to the pool. The **pending set** keeps one implementation, the ledger's, made keyed. Wiring `write/*` instead would give two pending sets over one queue. `write/*` covers 1 entity and 3 fields, against the ledger's 27 queued command kinds, spawn placeholders and per-user rows. It also captures "prior" values the ledger does not need, and it relies on the ledger's dead-letter parking for kept content anyway. Wired as is, it runs on the `overlaid` feed (`write-contract.ts:11-19` requires truth), so both would paint and a refusal would rewind twice (INFERRED). And the coverage rules would live in two places, free to drift. Once legacy screens are gone, the ledger can move next to the pool as a packaging step. Its rules stay the same. |
| (2) Server authoritative; refused change rolled back with content kept; nothing waits; later changes re-applied on the accepted state; the server refuses dependants itself; replaces `OUTBOX_PARKED_YIELDS_PARTITION` | **Agree, with two additions** | R1–R5 are this rule. Rollback, kept content and re-application on the accepted state already work (1.1 steps 8-9). Only the partition hold changes. Additions: (a) "the server refuses dependants itself" is **not true today** for delete-of-deleted, restore-of-not-deleted and the shipping stage, which return 500 and wedge (1.3). R4 is a prerequisite. (b) Retry must move to the back (R3). Without that, R1 lets an older intent overwrite a newer one. |
| (3) Overlays, locals and discovery reach the pool as keyed inputs; the legacy publish is switched off path by path | **Agree** | Section 4.5. Adding the lazy legacy snapshot means "off" needs no per-path switch matrix: whole-array work stops when nothing reads it. |

**Rejected alternatives:**

- **Keep holding, but explain the wait better** (POD-5415's question). The wait itself is the defect.
  It contradicts ADR 3 D10, and neither reference system does it.
- **Widen `OUTBOX_PARKED_YIELDS_PARTITION` to more commands.** That makes two rules out of one, and every
  new command needs a decision. R1 has no list.
- **Cascade-refuse later entries on the client.** The client would be guessing dependencies the server
  already judges. Replicache and Linear never do this.
- **Turn on `expectedRevision` for all issue writes.** That turns every concurrent edit by another
  person into a parked conflict. Issue patches set absolute values, so re-applying them is correct (R5).

---

## 6. How the standing rules hold (epic plan §4)

| Rule | How it holds |
|---|---|
| **One mutation owner** | Commands enter only through the runtime's command actions into the kernel `Outbox`. The pending set is derived from that queue (the ledger), never a second queue. The pool computes a projection and never writes the replica or queues commands. Deleting `write/*` removes the only code that could have become a second owner. |
| **No lost semantics: optimistic edits** | Same paint-before-commit, now per row. |
| **… rejection and rollback** | Unchanged mechanism ("stop applying"). R1 only stops later entries from waiting. |
| **… evict vs delete** | An evicted row leaves the table. Its pending entries stay in the outbox (ADR 3 D9.5) and are not painted while the row is absent. A delete stays a pending `remove` overlay until truth covers it. |
| **… readmission** | A refused delete or tuck stops applying its `remove` overlay, so the row returns in the same action. |
| **… atomic rescope** | A rescope arrives as one batch. The row source recomputes every row in it with its pending list in one action. |
| **… offline hydration** | The pending set is rebuilt from the durable outbox at boot, as today (`overlaysFor` reads `outbox.pending()`). Painted-but-unqueued entries are not durable, as today. |
| **… principal isolation** | Unchanged. One `Outbox` per principal, filtered by `onBehalfOf` (`outbox.ts:371, 502, 1148`). One ledger per runtime. The pool is keyed by runtime in `host/pool-host.ts:46` ("weak keys never retain a departed principal"). A principal switch destroys the runtime and its pool together. R1 and R3 act inside `mine()` only. |
| **… draft-ledger policy** | Untouched. Drafts are not outbox commands. They keep rev arbitration and "a dirty local draft always wins locally". The only change is a per-session event for adapter 8. Chat sends were the one `PARKED_YIELDS` case. R1 now covers them, with the same 2-minute give-up window (`CHAT_SEND_MAX_AGE_MS`) and the same D11.4 id rule. |
| **Ordinary deltas must not scan the world** | Pending lookups become O(row's entries). Adapters wake per key. The legacy fold runs only when read. |

---

## 7. Migration order

Each step ships alone, with focused tests, a before/after count, and a revert path. Steps 1-2 do not
depend on the pool and fix POD-5415 for every screen.

| Step | What | Paths touched | Gate |
|---|---|---|---|
| **0** | Server: typed refusals for every precondition in issue commands (`crud.ts:929, 1109, 1457, 1596, 1828, 1851`, plus an audit of `throw new Error` reachable from `routerFromCommands`). Decide whether an update to a soft-deleted issue is refused. | server issues module | A test per precondition asserting a typed code, and that the client classifies it as definitive. Legacy control: the bare-`Error` arm retries. |
| **1** | Outbox: R1 for all commands, R3 retry to the back, drain on release. Delete `OUTBOX_PARKED_YIELDS_PARTITION` and `parkedYieldsPartition`. Amend ADR 3 D12 and the conformance table. | `packages/sync/src/outbox`, `kernel-outbox.ts`, `wiring.ts`, ADR 3 | POD-5415's sequence as a kernel test. Legacy arm (hold) must fail it. Retry-after-newer-landed ordering test. Existing chat-send yield tests still pass unchanged. |
| **2** | Recovery copy: drop the "queued behind" wording if any. Confirm the chip renders retry position correctly. | `OutboxRecovery.tsx`, mobile twin | POD-4978's phone sequence re-run: "1 change needing review", 0 queued. |
| **3** | Ledger: per-row index and `onPendingRows`. Row source reads `overlaysForRow` on the keyed event instead of `readPending()` whole maps. Still `overlaid` mode, still on the publish for discovery. | `optimism.ts`, `row-source.ts` | Per-change meter: a stage click costs O(1) pending lookups at 1x and 4x. Differential test: same emitted rows as `readPending()` over a scripted sequence that includes a refusal mid-chain. |
| **4** | Pool projection materialised at write time; delete the `writes?.pending` branch and the optimism use of the overlay Proxy. Delete `write/*`, `write-contract.ts`, `receipts.ts`, `WriteSeam`, `pool.edit`, `IssueModel.update` and the generated setters (or keep thin setters, per D3). | `client-graph` pool, models, row source; worklist-proto harness | Proxy count 0 for pending rows; row identity stable across reads. The harness's write arm drives writes through runtime commands. |
| **5** | Local keys: `onLocals` / `readLocal` from the runtime's locals writer. Move adapters 2, 13, then 5, 3, 6, 10, 9, 8 (window parts). Each unsubscribes once its last snapshot read is gone. | runtime locals; listed sources | Per adapter: no wake on an unrelated local or kernel batch. |
| **6** | Discovery and window lists by id. Move adapters 1 (discovery lanes), 3, 6, 10, 5, 9. | discovery producer; listed sources | One repo change wakes only that repo's rows; command-launch no longer re-links all resident sessions. |
| **7** | Drafts per session (8), cursor and count signals (7, 11, 12), spawn placeholders through pending rows (4, 12). Chat context reads pool tables and residency; `issueExit` uses a per-id demanded set. | draft ledger, replica, sources | Kernel batch that touches no demanded key: 0 adapter work. |
| **8** | Lazy legacy snapshot: fold and `sessionViews` computed on read. | `runtime.ts` `publishReplica`, `replica-binding.ts` | With pool screens on and no legacy screen mounted: zero whole-array folds per batch (counter). Legacy screens unchanged (their tests). |
| **9 (F4)** | Delete the ledger's whole-array fold, `readChanged`, the snapshot store and `runtime.subscribe`, once no legacy screen remains. | client-core engine | Part of F4. |

Steps 5-7 are ordered by how many whole-array reads each removes: locals first (9 adapters), discovery
next (4 adapters, including the all-sessions re-link), then the rest. Within a step, each adapter is one
small change.

---

## 8. What is deleted

| What | Lines / place | Step |
|---|---|---|
| `OUTBOX_PARKED_YIELDS_PARTITION`, `parkedYieldsPartition`, `yieldsWhenParked` | `wiring.ts:658-664`, `ports.ts:303`, `outbox.ts:1197-1201` and its call sites | 1 |
| ADR 3 D12's "blocks only its partition until recovery or cancel" | ADR 3, conformance table row | 1 |
| Pool write stack | `write/edit.ts` 480, `write/overlay.ts` 88, `write/pending.ts` 13, `write/create.ts` 51, `shared/write-contract.ts` 566, `shared/receipts.ts` 250 = **1,448** | 4 |
| Write seam in the reader | `WriteSeam` (`pool.ts:185-192`), `writes?.pending` in `pool.row` and `readCursor`, `pool.edit`, `observePending`, `createWritableWorklistPool`, `IssueModel.update` and setters | 4 |
| Harness writable arm | `worklist-proto/arms/mobx/pool/write/*`, `harness/src/writable-arm.ts`, `harness/web/entries/mobx-write.ts` and `mobx-pending.ts` (re-pointed to runtime commands, or deleted if nothing measures through them) | 4 |
| Optimism's use of the overlay Proxy | `pool.ts:672` | 4 |
| `readPending()` whole-map pass, `pendingByRow` map rebuild | `row-source.ts:518-526`, `optimism.ts:544` | 3 |
| 13 `runtime.subscribe` subscriptions | section 1.5 | 5-7 |
| Eager legacy fold per batch | `runtime.ts:1539-1580` (made lazy) | 8 |
| Ledger whole-array fold, snapshot store, `runtime.subscribe` | client-core engine | 9 (F4) |

---

## 9. Risks

1. **Order-sensitive intents re-applied on a different base.** A reorder computes fractional keys
   against the displayed order, which includes pending moves (`planReorderKeys`). If an earlier
   reorder is refused, a later one lands on the accepted order. The result is a valid order but may not
   be the exact one the user saw. Replicache has the same property. The refused reorder already snaps
   back today. Mitigation: none needed beyond a test that the result is a valid order.
2. **An older retry overwrites a newer landed value.** Under R3, if rename A is retried after rename B
   landed, A wins. That is the user's latest act. The recovery chip cannot show the current value,
   because it never reads the target (a security rule). Accepted, and stated in the copy if the
   operator wants it (D2).
3. **Step 0 is a real prerequisite.** Shipping step 1 without it changes nothing for the 500 cases: they
   still hold their partition as transient. With R1 the hold now looks inconsistent: refused entries
   release, 500s hold. Step 0 first.
4. **Update of a soft-deleted issue succeeds on the server.** This is not a refusal problem, but it is a
   dependent-change hazard: delete accepted, then a queued update lands on the deleted row. Step 0 asks
   for a decision.
5. **Harness evidence built on the writable arm.** `work-per-change.test.tsx`, `tracking-counts` and the
   `mobx-write`/`mobx-pending` entries drive edits through `write/*`. Step 4 must re-point them to
   runtime commands in the same change, or the per-change meter loses its write coverage. Re-record the
   tracking-counts baseline in that change.
6. **Overlap with POD-5416** (overlay Proxy). Step 4 removes optimism's use of the Proxy. POD-5416 owns
   the other uses. Land order: whichever is first; the second rebases. Mail POD-5416 when step 4 starts.
7. **The compatibility queue** (`client-core/src/outbox.ts`, one global FIFO) is still selected when no
   `createOutboxFn` is injected (`wiring.ts:835`). If any production path still uses it, it needs R1 too,
   or it should be deleted. READ: web (`AppShell.tsx:341`) and mobile (`MobileClientProvider.tsx:799`) inject the kernel `Outbox`. The fallback is reached only where nothing is injected; delete it or give it R1 in step 1.
8. **Lazy legacy snapshot and `useSyncExternalStore`.** `getSnapshot()` must return the same object
   until the version changes, or React loops. Memoizing by version does that. Test it with a legacy
   screen mounted.
9. **ADR amendment.** R1 changes a written ADR decision and its conformance row. It needs operator
   sign-off as an ADR 3 amendment, not only this spec.

---

## 10. Decisions for the operator

- **D1. Adopt R1–R5 and amend ADR 3 D12** (a parked entry releases its partition, for every command;
  retry goes to the back; typed server refusals are required). Recommended: **yes**. This closes
  POD-5415 and makes `OUTBOX_PARKED_YIELDS_PARTITION` unnecessary.
- **D2. One pending set (the ledger, made keyed), projection in the pool, delete `write/*`.**
  Recommended: **yes**. This is the narrowed form of the coordinator's point (1). The alternative,
  wiring `write/*` and retiring the ledger fold, first rebuilds, in a second place, the coverage for the 25 queued command kinds it does not handle
  (27 in `OutboxKinds`, `wiring.ts:54-151`; `write/*` handles `issueUpdate` and `issueMarkRead`).
- **D3. Model setters as the write entry point** (`issue.title = …` calling the runtime command).
  Recommended: **not now**. They change no semantics. Screens already call the commands. Add them later
  if screen code would read better.

---

## 11. Evidence index

- Queue proof: POD-4978 artifact 3 (`mobile-queue-audit.json`), and `docs/measurements/POD-4978-mobile-actions.md` lines 126-147 at `c391e95d73`.
- Review findings: `docs/reviews/pod-4286-mobx-architecture-review.md` §13, §19, "Against Linear's client model".
- Outbox policy: `docs/adr/0003-command-security.md` D9-D13; `docs/design/outbox-dead-letter-recovery.md`; `docs/design/outbox-lifecycle-state-machine.md`.
- External: Replicache server push reference (`doc.replicache.dev/reference/server-push`); Linear sync engine reverse-engineering (`github.com/wzhudev/reverse-linear-sync-engine`).
