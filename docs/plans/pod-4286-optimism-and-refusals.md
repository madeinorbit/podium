# POD-4286 — Optimism and refused changes: one rule (design spec, POD-5426)

**Status:** spec for the decided target. The operator decided on 2026-10-03 (pinned comment on POD-5426):
follow the coordinator's recommendation, Linear's shape. This document writes that target down with
its migration order, the standing rules, what is deleted, and the risks. It does not re-argue the
direction. No product code changes with this document.
**Date:** 2026-10-03. **Base:** `integrate/4286-pilot` at `70f3c661f4`. Every `file:line` is at that
commit.
**Inputs:** POD-5417 review findings 13 and 19 (`docs/reviews/pod-4286-mobx-architecture-review.md`),
POD-5415 (a refused rename blocks later changes to the same issue) and its queue proof (POD-4978,
`docs/measurements/POD-4978-mobile-actions.md` and the attached `mobile-queue-audit.json`), and the
operator's direction: refused changes follow ONE sync-system rule, best practice as in Linear and
Replicache.

**Evidence labels.** **READ** = from code or docs in this tree. **RUN** = measured (only the POD-4978
queue audit, which was run on `ccce76d346` by that issue, not by me). **EXT** = published behaviour of
Linear or Replicache, quoted from their public descriptions. **INFERRED** = follows from read code but
was not traced end to end.

---

## 0. Summary

**The decision.**

1. **The pool owns optimism.** A change mutates the model and records a transaction.
2. **The server is authoritative.** A refused change is rolled back and shown with its content kept and
   recoverable. Nothing waits behind it. Later changes are re-applied on the accepted state, and the
   server refuses dependants itself. This replaces `OUTBOX_PARKED_YIELDS_PARTITION`.
3. **Overlays, locals and discovery reach the pool as keyed inputs.** The legacy publish is switched off
   path by path.

**The rule, in one sentence.** A change waits only while the answer about an earlier change to the
same thing is **unknown**; a **definitive** answer (accepted or refused) lets the next one go. That is
Replicache's push rule and Linear's rollback (section 2). Section 3 states it for the code as R1–R5.

**The target, in four pieces:**

1. **Queue rule.** A parked (refused or expired) outbox entry stops holding its partition, for every
   command. `OUTBOX_PARKED_YIELDS_PARTITION` is deleted. Retry and edit go to the back of the partition.
   This needs an ADR 3 D12 amendment. It fixes POD-5415 for old and new screens alike, before any pool
   work.
2. **Server prerequisite.** Every precondition refusal is a typed answer (409/412), never a bare
   `Error`. Today "already deleted", "not deleted" and "shipping stage" surface as 500. The client
   retries a 500 for 14 days while holding the partition. Without this, "the server refuses dependants
   itself" is not true.
3. **The pool's transaction layer** (Linear's shape):
   - **Change:** a change to a model (`issue.title = …`, `pool.mutate(…)`) writes the new visible row
     and records a transaction in the same MobX action. The transaction is the durable outbox record,
     and the pool's log is an in-memory index over the outbox.
   - **Rollback:** one mechanism, rebase. A model's visible row is its server row with its remaining
     transactions re-applied in queue order. Refusal, expiry and arriving truth all trigger it.
   - **Reads:** plain. No read-time overlay, no Proxy, no per-read pending check.
   - **Code:** the pool's `write/*` stack is the starting code. It is grown to every queued command kind,
     spawn placeholders and per-user rows. The legacy ledger (`optimism.ts`, 1,273 lines) keeps painting
     legacy screens only, from the same outbox records, until F4 deletes it.
4. **Keyed inputs, then the legacy publish off.** The 13 pool adapters on `runtime.subscribe` move to
   keyed inputs: local keys, discovery rows, window lists by id, drafts per session, cursor and count
   signals. Pending rows need no input, because the pool owns them. The legacy snapshot's whole-array
   fold becomes lazy, then is deleted with the last legacy screen.

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
| 1 | `shared/row-source.ts:1252` | ledger (4 whole maps), discovery `repos` | pool transactions (no input); discovery rows |
| 2 | `shared/engine-locals.ts:19` | `selectedIssueId`, `coarseNow` | local-key event |
| 3 | `header-source.ts:77` | machines, repos (whole array on identity change), window, `outboxSize` | machine by id, discovery row, local keys, outbox count |
| 4 | `session-pane-source.ts:32` | window keys, `pendingSpawnIds` | local keys; pool spawn transactions |
| 5 | `shell-source.ts:42` | 9 window keys (structural compare per publish), approvals, file tabs, workspaces | local keys; approval, tab and workspace by id |
| 6 | `command-launch-source.ts:55` | repos (a change re-links ALL resident sessions), machines, window | discovery row; machine by id; local keys |
| 7 | `mobile-inbox-source.ts:27` | nothing; a wake-up to re-read the cursor | cursor signal |
| 8 | `chat-context-source.ts:27` | `drafts[sessionId]`, window | draft-per-session event; local keys |
| 9 | `superagent.ts:74` | `superThreads` (full rebuild), window; counts all sessions while booting | thread by id; local keys; a booted latch |
| 10 | `settings-source.ts:25` | machines, repos (full rebuild), `settingsTab` | machine by id; discovery row; local key |
| 11 | `mobile-settings.ts:71` | lengths of the overlaid issue list and conversations, cursor | count and cursor signals |
| 12 | `mobile-session-context.ts:125` | `pendingSpawnPrompts`, cursor | pool spawn transactions; cursor signal |
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

## 4. Target design: the pool owns optimism

### 4.1 Three layers

| Layer | Owner | Linear's equivalent |
|---|---|---|
| Durable queue | kernel `Outbox` (`packages/sync/src/outbox`), unchanged | the transaction queue persisted to IndexedDB |
| Transactions and optimism | the pool: `PoolTransactions`, grown from `client-graph/src/write/*` | model mutation plus `Transaction` objects |
| Server truth | the replica feed into the pool, `truth` mode per owned kind | sync deltas |

The outbox stays the only queue and the only durable record. The pool's transaction log holds no second
copy of the queue. It is an index over outbox records keyed by target row, rebuilt from the outbox at
boot (`write/edit.ts:371-454` already does this).

### 4.2 A change

`issue.title = 'x'`, or the general `pool.mutate(command, input)`, runs **one MobX action**:

1. **Reduce.** The command's pure reducer turns the input into row changes. The reducers already exist:
   `overlaysForOutboxEntry` (`client-core/src/engine/overlay.ts:356`) maps every queued command kind to
   its patches and inserts, with `issueUpdateRoute` (`:330`) splitting issue and per-user fields. They
   move to a pure shared module (step 3) and the pool calls them.
2. **Mutate the model.** For each touched row: `visible = fold(truth, transactions)` with the new
   transaction appended, and the visible row replaces the table row. Model getters read the table row,
   so every reader of that one model, and nothing else, sees the change at once.
3. **Record the transaction** `{mutationId, command, input, rows, state}` in the log and call the
   outbox's single enqueue path. If the enqueue throws, the transaction leaves the log and the touched
   models rebase (4.3). That is today's "unpaint on a failed commit" (`optimism.ts:1016`).

Paint happens before the durable commit, as today. Model setters are the API for pool screens. They call
`pool.mutate`, so there is one write path in the pool.

### 4.3 Rebase: the one rollback mechanism

For model X: `visible(X) = foldRowOverlays(truth(X), changes of X's live transactions, in queue order)`.
`foldRowOverlays` is at `overlay.ts:942`; inserts apply before patches, as today.

It runs when:

- truth for X arrives (a feed row, a rescope batch, an eviction);
- a transaction on X is refused, expired, cancelled or retired;
- X becomes resident (a cold model with pending transactions paints on load).

Only changed rows are written, so an unchanged row keeps its identity. With no live transactions,
`visible` is the truth object itself. The pool stores a separate truth slot only for rows that have
live transactions.

This is the "re-applied on the accepted state" half of the decision. It needs no stored prior values.
`prior`, `priorIdentity` and `restoreIdentity` in `write-contract.ts` (`:112, :119, :173`) are replaced
by rebase, so a refusal in the middle of a chain can never restore a stale value.

### 4.4 Settlement

A transaction moves through these states:

- **painted:** in the log, not yet durable;
- **queued / sending:** mirrors the outbox record;
- **applied, awaiting truth:** the outbox answered `applied`;
- **retired:** the echo covers it, or 60 s pass (`AWAITING_TRUTH_TTL_MS`, `overlay.ts:151`), or the row
  moved past the transaction's baseline (`patchedCellsMovedPast`, `:251`).

Retiring releases the outbox's `awaiting` hold, as `outbox.retireAwaiting` does today. **The reference
behaviour is the ledger's**, because it is what ships. `write-contract.ts`'s `PendingLog` (W1–W12) is the
starting code. Where the two differ, the ledger's rule wins and the difference is listed in the step 4
change:

- echo coverage: by fingerprint against the baseline (ledger) versus by value (`write/*`);
- the spawn grace period (`SPAWN_CONFIRM_GRACE_MS`, 2 s);
- absent per-user rows (`optimism.ts:508-520`);
- `chained` entries.

### 4.5 Coverage

The pool covers every one of the 27 queued command kinds (`OutboxKinds`, `engine/wiring.ts:54-151`)
through the shared reducers, plus the spawn placeholder inserts:

- `spawnDraftAgent` and `spawnIssueAgent` are online-only direct creates with client-minted ids
  (`optimism.ts:1139, 1211`).
- In the pool they are insert transactions. A failed create removes the provisional model after the
  grace period, as today.
- `pendingSpawnIds` and `pendingSpawnPrompts` become reads of the pool's insert transactions.

A command with no reducer paints nothing and still shows as pending (ADR 3 D6: "absence is valid").

### 4.6 Changes the pool did not author

Legacy screens (during migration) and other tabs on the same store enqueue through the outbox. The pool
**adopts** every outbox record it did not author:

- It subscribes to outbox record events, runs the record through the same reducer, and adds a
  transaction, so pool screens show it.
- Another tab's write arrives through the outbox's existing rebase notification.

This is how two kinds of screens stay correct while only one queue exists.

### 4.7 Cold targets

A transaction may target a model that is not resident. It is recorded under the target id and applied
when the model loads (4.3). This removes `write/*`'s "a cold row cannot be edited" limit
(`write/edit.ts:64-73`).

A change computed from the current value (a toggle, a reorder) reads a resident model, so the action
loads it first.

### 4.8 Refusal on screen

- **The model rolls back** in the same action that records the refusal (rebase).
- **Authored text is kept and recoverable.** It is parked with the input verbatim, through the existing
  recovery chip (`apps/web/src/features/machines/OutboxRecovery.tsx:242-307`) and its mobile twin, which
  offer retry, edit and discard. The chip keeps its two security rules:
  - it never reads the target;
  - its affordances come from the reason code alone.
- **A per-row marker** ("not saved") may show on a model that has a parked transaction. It reads only
  the parked record, on a row the user can already see.
- **No authored text:** the change snaps back with the existing toast (`shouldParkDeadLetter`,
  `engine/wiring.ts:390`).
- **`onRejected` listeners** (`write/edit.ts:297-318`) fire after the rebase.
- **Nothing waits behind a refusal** (R1). Retry and edit go to the back (R3).

### 4.9 The queue (kernel changes for R1 and R3)

- **Partition scan** (`outbox.ts:599-656`): a parked entry no longer stops the scan, for every command.
  Delete `yieldsWhenParked` (`:1197-1201`), the `parkedYieldsPartition` port field (`ports.ts:303`) and
  `OUTBOX_PARKED_YIELDS_PARTITION` (`wiring.ts:658-664`, `kernel-outbox.ts:47, 570`).
- **Retry and edit go to the back of the partition.** Edit already creates a new record. Retry re-orders
  in the same durable span as its transition (today it transitions in place, `outbox.ts:999-1030`).
- **Every transition that releases a partition starts a drain:** park, discard, cancel and automatic
  discard. This closes the INFERRED gap in 1.3.
- **Conformance table** (`docs/design/outbox-lifecycle-state-machine.md:78`): the row becomes "a parked
  head blocks nothing; a backing-off head blocks its partition; a retried entry drains after every
  entry queued before the retry".

### 4.10 Keyed inputs and switching the legacy publish off

**Pending rows need no input:** the pool owns them. Adapters 1 (ledger part), 4 and 12 read the pool's
transactions. The remaining inputs come from the one producer that owns each value:

| Input | Producer | Shape | Adapters (table 1.5) |
|---|---|---|---|
| Local keys | the runtime's single locals writer | `onLocals(changedKeys)` plus `readLocal(key)` | 2, 3, 4, 5, 6, 8, 9, 10, 13 |
| Discovery | the discovery producer | machine by id, repo by `[machineId, path]`, upsert and remove | 1, 3, 6, 10 |
| Window lists | runtime | approval, file tab, workspace and super-thread by id | 5, 9 |
| Drafts | draft ledger | `onDraft(sessionId)` | 8 |
| Cursor and counts | replica, outbox | cursor-moved signal; outbox size | 3, 7, 11, 12 |

Each adapter then wakes only for its own keys. Finding 13's two whole-history adapters change too:

- Chat context reads the pool's tables and residency.
- `issueExit` copies `session-exit-source.ts`'s per-id demanded set.

**Switching off, per kind and per path:**

- **Per kind.** The row source takes a set of pool-owned kinds. For an owned kind it runs in `truth`
  mode: it never reads the ledger, and the pool's transactions paint. Other kinds stay `overlaid` until
  their turn.
- **Per adapter.** An adapter unsubscribes from `runtime.subscribe` once its last snapshot read is gone.
- **Legacy screens.** The legacy snapshot becomes lazy. `publishReplica` records the changed kinds and
  bumps a version. The ledger fold and `sessionViews` are computed on `getSnapshot()` read, memoized by
  version. With pool screens on and no legacy screen mounted, no whole-array work runs.
- **F4.** When the last legacy screen goes, the ledger, the fold, `readChanged`, the snapshot store and
  `runtime.subscribe` go with it.

---

## 5. How the standing rules hold (epic plan §4)

| Rule | How it holds |
|---|---|
| **One mutation owner** | The outbox stays the only queue and the only durable record. The pool's log is an index over it, never a second queue. Optimistic entity edits use `pool.mutate`/`rt.write`. Runtime-owned pins, tab order, personal settings, layout and chat sends enqueue in that same outbox and are non-optimistic for pool rows; their local paint and settlement remain runtime/composer concerns. Nothing writes the replica. The epic plan §4 now says "one queue and one durable record: nothing new adds a queue or writes the replica" (POD-5546). |
| **One painter per screen** | A kind is either pool-owned (`truth` feed, pool transactions paint) or not yet (ledger paints through the `overlaid` feed), never both. During migration the ledger paints legacy screens from the same outbox records the pool adopts. That is two readers of one queue, not two queues. |
| **No lost semantics: optimistic edits** | Paint before the durable commit, unpaint on a failed commit (4.2). |
| **… rejection and rollback** | Rebase (4.3), in the same action as the refusal. Content is kept by the existing park policy (4.8). |
| **… evict vs delete** | An eviction removes the row from the table. Its transactions stay in the log and the outbox (ADR 3 D9.5) and are not painted while the row is absent. They paint again if it is readmitted. A delete stays a pending `remove` until truth covers it. |
| **… readmission** | A refused delete or tuck rebases and the row returns in the same action. |
| **… atomic rescope** | A rescope arrives as one batch. Every row in it rebases in one action. |
| **… offline hydration** | The log is rebuilt from the durable outbox at boot, and models paint as they become resident. Painted-but-not-durable transactions do not survive a reload, as today. |
| **… principal isolation** | One `Outbox` per principal, filtered by `onBehalfOf` (`outbox.ts:371, 502, 1148`). The pool, and so its log, is keyed by runtime (`host/pool-host.ts:46`, "weak keys never retain a departed principal"). A principal switch destroys the runtime, its pool and its log together. Adoption (4.6) reads `mine()` only. |
| **… draft-ledger policy** | Untouched. Drafts are not outbox commands: they keep rev arbitration and "a dirty local draft always wins locally". Adapter 8 gets a per-session event. Chat sends lose their special case: R1 covers them, with the same 2-minute give-up window and D11.4 id rule. |
| **Ordinary deltas must not scan the world** | A change touches its own rows. Rebase is per model. Adapters wake per key. The legacy fold runs only when read. |

---

## 6. Migration order

Each step ships alone, with focused tests, a before/after count, and a revert path. Steps 0-2 do not
depend on the pool and close POD-5415 for every screen.

| Step | What | Gate |
|---|---|---|
| **0** | **Server: typed refusals.** Every precondition reachable from `routerFromCommands` answers 409/412 (`crud.ts:929, 1109, 1457, 1596, 1828, 1851`, plus an audit of `throw new Error` in issue commands). Settle the policy for an update to a soft-deleted issue. | A test per precondition: a typed code, classified definitive by the client. Legacy arm: the bare `Error` retries. |
| **1** | **Outbox: R1, R3, drain on release (4.9).** Delete the parked-yield list. ADR 3 D12 amendment and conformance row. | POD-5415's sequence as a kernel test; the hold arm must fail it. A retry after a newer change landed drains last. Chat-send tests unchanged. |
| **2** | **Recovery surface.** Copy for "nothing queued behind"; POD-4978's phone sequence re-run. | "1 change needing review", 0 queued. |
| **3** | **Pure reducers out of client-core.** Move `overlaysForOutboxEntry`, `issueUpdateRoute`, `insertOverlay`, `foldOverlays`, `foldRowOverlays`, `pruneAwaiting`, `patchedCellsMovedPast`, `rowFingerprint` and the TTL constant into a pure module both the ledger and the pool import. No behaviour change. | Existing ledger tests pass unchanged. Lint: the pool imports no `client-core` engine class. |
| **4** | **`PoolTransactions`, off by default.** Grow `write/*` into it: all 27 kinds plus spawn inserts (4.5), adoption (4.6), boot rebuild, settlement rules ported from the ledger (4.4), rebase (4.3), write-time visible rows, cold targets (4.7). | Differential test against the ledger over scripted sequences: same visible rows for a mid-chain refusal, offline reload, spawn failure, another tab's write, eviction and readmission, and rescope. Per-change meter: one click costs O(rows touched) at 1x and 4x. |
| **5** | **The pool owns issues.** `issueProjections` and `issueUserStates` become pool-owned kinds (`truth` feed). Pool screens write through model setters and `pool.mutate`. Delete the read-time overlay: `writes?.pending` in `pool.row` and `readCursor`, the `PendingOverlay` map (`write/overlay.ts`), and optimism's use of the overlay Proxy. | A refusal rewinds once (no ledger fold on owned kinds). Rename input → paint not slower than POD-4978's recorded numbers. Row identity stable across reads. |
| **6** | **The pool owns sessions:** `sessions`, `sessionUserStates`, spawn placeholders. Adapters 4 and 12 read pool transactions. | Same gates as step 5 for sessions; spawn failure removes the placeholder after the grace period. |
| **7** | **Local keys** (`onLocals`, `readLocal`): adapters 2 and 13 first, then 5, 3, 6, 10, 9, 8 (window parts). | Per adapter: no wake on an unrelated local or kernel batch. |
| **8** | **Discovery and window lists by id:** adapters 1 (discovery lanes), 3, 6, 10, 5, 9. | One repo change wakes only that repo's rows. Command launch no longer re-links all resident sessions. |
| **9** | **Drafts per session (8); cursor and count signals (7, 11, 12).** Chat context reads pool tables; `issueExit` uses a per-id demanded set. | A kernel batch touching no demanded key: zero adapter work. |
| **10** | **Lazy legacy snapshot** (4.10). | Pool screens on and no legacy screen mounted: zero whole-array folds per batch. Legacy screens' tests unchanged. |
| **11 (F4)** | **Delete the legacy optimism and publish** (section 7). | Part of F4. |

Steps 7-9 are ordered by how many whole-array reads each removes: locals touch 9 adapters, discovery
touches 4 (including the all-sessions re-link). Steps 5 and 6 can run in parallel with 7-9.

---

## 7. What is deleted

| What | Where | Step |
|---|---|---|
| Parked-yield special case | `OUTBOX_PARKED_YIELDS_PARTITION` (`wiring.ts:658-664`), `parkedYieldsPartition` (`ports.ts:303`), `yieldsWhenParked` (`outbox.ts:1197-1201`) and call sites | 1 |
| ADR 3 D12's "blocks only its partition until recovery or cancel" | ADR 3 and the conformance row | 1 |
| Stored prior values | `prior`, `priorIdentity`, `restoreIdentity` in `write-contract.ts`; replaced by rebase | 4 |
| Read-time optimism in the pool | `writes?.pending` in `pool.row` and `readCursor` (`pool.ts:670-672, 704-710`); `write/overlay.ts` (88 lines); `observePending`; optimism's use of `overlayRow` (`pool.ts:672`) | 5 |
| Ledger reads for owned kinds | `readPending()` (`row-source.ts:518-526`) and the `overlaid` mode, per kind, then entirely | 5, 6 |
| 13 `runtime.subscribe` subscriptions | table 1.5 | 6-9 |
| Eager legacy fold per batch | `runtime.ts:1539-1580` (made lazy) | 10 |
| The legacy ledger | `optimism.ts` (1,273 lines): the class, `enqueueOverlayed`'s paint, `recomputeFor`, `foldStable`, `recomputeSessions`, `pendingByRow`, `pendingSpawnIds` and `pendingSpawnPrompts` in the snapshot | 11 (F4) |
| Legacy publish | `replica-binding.ts` `readChanged`, the snapshot store, `runtime.subscribe` | 11 (F4) |

**Kept and grown, not deleted:**

- `write/edit.ts`, `write/create.ts` and `write-contract.ts`'s `PendingLog` become `PoolTransactions`.
- `receipts.ts` is the transport over the outbox.
- The pure reducers move out of `overlay.ts` (step 3).
- `IssueModel.update` and the generated setters become the production write API.

---

## 8. Risks

1. **Settlement rules diverge** between `PendingLog` and the ledger (echo coverage, spawn grace, absent
   user rows, chaining). Mitigation: the ledger is the reference. Step 4's differential test runs until
   the ledger is deleted.
2. **Two painters on one kind** cause a double rewind or a flicker. Mitigation: the per-kind ownership
   set (4.10), and a test that an owned kind never reads the ledger.
3. **Paint latency.** `pool.mutate` must paint in the same action as the click. Gate it against
   POD-4978's recorded rename input → paint.
4. **Adoption needs a reducer per kind.** A kind without one paints nothing but stays pending (D6), not
   a crash. Step 4 asserts all 27 kinds map.
5. **Cold targets.** A transaction on a non-resident model paints on load. A toggle or reorder must load
   the model first, or it would compute from a missing value.
6. **Order-sensitive intents** (reorder keys computed against the optimistic order) re-apply on a
   different accepted order after an earlier refusal. The result is valid but may differ from what the
   user saw, the same as in Replicache. Test that the result is a valid order.
7. **An older retry overwrites a newer landed value** under R3. That is the user's latest act. The
   recovery chip cannot show the current value, because it never reads the target.
8. **Step 0 is a prerequisite.** Without it the 500 cases still hold their partition, and R1 looks
   inconsistent.
9. **An update to a soft-deleted issue succeeds on the server** (`crud.ts:1099`). That is a dependent
   change the server does not refuse today. Step 0 settles it.
10. **Harness evidence on the writable arm.** `work-per-change.test.tsx`, `tracking-counts` and the
    `mobx-write` and `mobx-pending` entries drive `write/*` today. Step 4 changes that code, so step 4
    re-records the tracking-counts baseline and keeps the meter's write coverage.
11. **Overlap with POD-5416** (overlay Proxy). Step 5 removes optimism's use of it, and POD-5416 owns
    the other uses. Mail POD-5416 when step 5 starts.
12. **The compatibility queue** (`client-core/src/outbox.ts`, one global FIFO) is the fallback when no
    `createOutboxFn` is injected (`wiring.ts:835`). READ: web (`AppShell.tsx:341`) and mobile
    (`MobileClientProvider.tsx:799`) inject the kernel `Outbox`. Delete the fallback, or give it R1, in
    step 1.
13. **Lazy snapshot and `useSyncExternalStore`.** `getSnapshot()` must return the same object until the
    version changes, or React loops. Memoize by version, and test with a legacy screen mounted.
14. **Sign-offs.** R1 amends ADR 3 D12. The epic's "one mutation owner" wording changes (section 5).
    Both need the operator's sign-off as written text, beyond this decision.

---

## 9. Open items for the operator

The direction is decided. These four smaller items need a word:

1. **ADR 3 D12 amendment text.** Step 1 drafts it; the operator signs it.
2. **The epic rule's new wording** (section 5).
3. **An update to a soft-deleted issue**: refuse it (typed 409) or keep accepting it. Recommended:
   refuse.
4. **The per-row "not saved" marker** (4.8): show it, or rely on the recovery chip alone.

---

## 10. Evidence index

- **Queue proof:** POD-4978 artifact 3 (`mobile-queue-audit.json`), and
  `docs/measurements/POD-4978-mobile-actions.md` lines 126-147 at `c391e95d73`.
- **Review findings:** `docs/reviews/pod-4286-mobx-architecture-review.md` §13, §19, and "Against
  Linear's client model".
- **Outbox policy:** `docs/adr/0003-command-security.md` D9-D13;
  `docs/design/outbox-dead-letter-recovery.md`; `docs/design/outbox-lifecycle-state-machine.md`.
- **External:** Replicache server push reference (`doc.replicache.dev/reference/server-push`); Linear
  sync engine reverse-engineering (`github.com/wzhudev/reverse-linear-sync-engine`).
- **Decision:** operator, 2026-10-03, pinned comment on POD-5426.
