# POD-4548 (L1c) — The optimistic write contract

How an edit enters a round-three prototype, how it is remembered while it is
pending, and how the server's answer settles it. The phase-c issues implement
this: Mc1/Mc2 (MobX) and Hc1/Hc2 (hand-rolled). The receipts stream it consumes
is L3b (POD-4554).

Code: `packages/worklist-proto/shared/src/write-contract.ts` holds the types
(`Edit`, `Receipt`, `Rejection`, `Superseded`, `PendingLog`, `WriteApi`,
`WriteTransport`), the edit-to-command mapping (`commandFor`,
`editForPendingWrite`) and a reference `createPendingLog`. Every sequence below
is a test in `write-contract.test.ts`. An arm may use the reference log or
write its own. If it writes its own, it adds its factory to that file's `LOGS`
list and must pass the same tests.

## 1. The shape, and what it replaces

Linear (audit `docs/decisions/4441-round-two-audit.md` §7) applies an edit to
the in-memory object at once. It records the edit in a transaction log that
keeps the old values, and sends it. The server's broadcast is the receipt, even
for the client that made the edit. A rejection rewinds from the old values.
Fast first, truthful second.

The kernel does the same thing in a different place. Optimism lives beside the
pool as folded arrays: `OptimismLedger` folds queued outbox entries over replica
rows on every recompute (`engine/optimism.ts`, `engine/overlay.ts`). Round
three moves optimism onto the model. The kernel stays the transport, the
durable queue and the authority on outcomes. **The prototype never reads the
kernel's fold** (rule W12).

## 2. The rules

**W1 — An edit is synchronous and paints first.** `WriteApi.edit(kind, id, patch)`:

1. `commandFor(kind, id, patch)` validates the patch and picks the kernel command (W3). A bad patch throws `WriteContractError` before any state changes.
2. The object must be in memory. **An edit on a row that is not in memory (a cold row) is refused** with a `WriteContractError` naming it LOADING, and the row is requested through the arm's load window; nothing is painted, logged or sent, and nothing blocks. Once the row lands, the same edit applies as on any row in memory. Editing an unknown id throws. See W1a.
3. Record `prior` for every patched field: the value the object shows now, which may be an older pending value. Also record `priorIdentity`, the arm's current row identity (W6).
4. Mint `txId` (W2).
5. In **one** action or commit, write the patch onto the object and `log.append(edit)`. A title rename commits one row.
6. `transport.send(txId, command)`. It is not awaited. The paint does not wait for storage, the same order the kernel uses (POD-1053).
7. Return `txId`.

**W1a — A row that is not in memory is not edited (POD-4753).** This is a
semantic change from today's app, which can edit any replica row: with rows
kept out of memory (the cold rule now, the working-set cutoff later) the arm
edits only what it holds. The reasons:

- The log needs the edit's `prior`, and for a field with nothing pending the
  prior IS the server value (W4: the rewind target and the echo base). A row
  not in memory has no server value in hand, so the entry cannot be written.
- Queueing the edit until the row lands would need the receipt, a rejection
  or the echo, which can all arrive before the row, to be held beside the log
  (a second log), and would paint on nothing.
- No user loses an edit: every edit surface draws the row first, and a row
  not in memory draws as a loading placeholder with no model to edit
  (`pool.issue(id)` is undefined), so the UI never offers it. A surface that
  edits by id (a command palette) opens the row, waits out its loading, then
  edits.

On bootstrap (W11) the re-applied entries take their prior from the feed's
server row with the already re-applied entries laid over it, never from the
pool, so a pending entry on a cold row needs no read of the pool. Arms: the
MobX pool follows W1a (`arms/mobx/pool/write/edit.ts`); the hand arm, paused,
still materialises synchronously and follows when it resumes.

**W2 — The transaction id is the outbox mutation id.** The arm mints it
(`asMutationId(randomUUID())`) and passes it into the runtime's
`enqueueOverlayed(kind, input, { mutationId: txId })`. The outbox already
accepts a caller-named id (`EngineOutbox.enqueue` `opts.mutationId`,
`engine/wiring.ts:140-152`). The runtime seam does not pass one through yet:
`OptimismLedger.enqueueOverlayed` mints its own (`optimism.ts:571`). **L3b adds
that optional pass-through**, which leaves behaviour unchanged for every
existing caller. The id is then stored on the outbox entry and sent as the
tRPC input's `mutationId`, which is the server's dedupe key. It is carried by
every outbox event (`applied`, `dead-lettered`, `superseded`) and survives a
reload. Why the arm mints it: `edit()` must return it synchronously, and the
drain can fire `applied` before the enqueue promise resolves (wiring.ts:145-149).

**W3 — The mapping to existing kernel commands** (section 3). Title and stage
ride `issues.update`, and one edit may carry both. `readAt` rides
`issues.markRead` and must be edited on its own. A patch that needs two
commands is refused: the caller makes two edits, which gives two transactions.
Terminal statuses are `issues.close`, a different command that also stamps
`closedReason` and emits `issue.closed`. Setting one through `issues.update`
would silently drop both (wiring.ts:94-101), so the WriteApi refuses them.
Closing is not a slice edit.

**W4 — The display rule.** For each editable field, the object shows the
value of the **newest pending edit** on that field. If there is none, it shows
the **last server value**. Every log operation keeps this true and returns the
fields whose shown value changed (`LogOutcome.changes`). The arm writes exactly
those in one action and skips writes of an equal value.

**W5 — A rejection rewinds to server truth.** `log.reject(rejection)` removes
the edit:

- If it was the newest pending edit on a field, the field shows the next-older pending value, or the server value if there is none.
- If a newer edit is still pending on that field, nothing repaints.

The rewind target starts as `prior` (captured at edit time, per field). It is
**replaced by any server value that lands on the field while the edit is
pending**, because rejecting must reveal truth, not a stale capture. `Edit.prior`
itself stays immutable as the record of what the user replaced. After applying
the rewind, the arm fires `WriteApi.onRejected` with the `Rejection`. The
user-facing toast and the dead-letter recovery surface stay the kernel's. It
already raises both for these kinds (wiring.ts:725-737).

**W6 — A rewind restores identity when nothing else moved.** If a removal
empties the row's log, and no server row for that object has arrived since its
**first** pending edit, then every editable field is back to its pre-edit
value. The outcome then carries `restoreIdentity`: the `priorIdentity` of that
first edit. A hand-rolled arm reinstates that row object instead of building an
equal new one, so the commit-counting harness sees the original object, as
round two's spikes did (POD-4453/4454). A MobX arm mutates in place and can
omit `priorIdentity`, since its identity never changed. Its row view re-derives
to an equal value.

**W7 — Settling needs the receipt AND the echo.**

- The **receipt** is the kernel's outbox `applied` event for `txId`: the Authority applied the mutation and recorded a receipt (`packages/sync/src/outbox/ports.ts` `OutboxEvent`, ADR 3 D9). L3b delivers it as `{ type: 'accepted', txId }`.
- The **echo** is the server row carrying the edit's effect. It arrives through the per-row feed like any other server row.

Both are needed because **the wire change row carries no mutation id**
(`replica/feed/frames.ts:56-72`: ADR 2 D8 provenance is not on the v2 wire).
So the echo cannot name its transaction, and the receipt carries no value.
Echoes are recognised by value:

- `exact` (title, stage): the server value equals the pending value. `issues.update` lands keys verbatim (overlay.ts:371-391).
- `stamp` (readAt): any non-null server value that differs from the server value at edit time. The server writes its own clock, so the echo never equals the client's stamp. This is the kernel's own `issueMarkRead` predicate (overlay.ts:326-341).

A server value confirms the **oldest** unconfirmed edit on that field that it
echoes, and every older edit on the field. Every slice edit shares the issue's
outbox partition (`issue:<id>`), so same-row writes apply in queue order. An
edit leaves the log when it has its receipt and every one of its fields is
confirmed or overtaken (W8). Either signal may come first. The broadcast often
beats the HTTP response.

**W8 — Remote updates: local wins until settle, then last writer wins per field.**
For each editable field of an arriving server row:

- **No pending edit on the field:** the object takes the server value.
- **Pending edit on the field:** the object keeps the local value. The server value becomes the rewind target (W5), and the log checks whether it is an echo (W7).
- **After the receipt,** a server value that is neither the edit's echo nor the value seen when the receipt arrived **overtakes** the edit. That write is newer than ours, so the server wins the field. A value equal to the one seen at the receipt is stale: a change committed before ours, still in flight, or the same stale title riding another field's full-row upsert. The edit keeps waiting.

No rebase beyond this; Linear does none either.

**W9 — Supersede.** The outbox may collapse a still-queued entry into a later
one with the same collapse key (POD-785). Among slice edits only mark-read has
one (`issue-read:<id>`), so only mark-read can be superseded. The collapsed
entry is never sent and gets no receipt. L3b delivers
`{ type: 'superseded', txId }` and `log.supersede` removes the edit without a
repaint, because its successor is newer and carries the value.

**W10 — Lost echo.** An edit with its receipt whose echo never arrives leaves
the log after `ECHO_TTL_MS` (60 s, pinned equal to the kernel's
`AWAITING_TRUTH_TTL_MS`), and the object takes the server value. The arm calls
`log.expire()` from a timer while it holds receipted edits. An edit **without**
a receipt never expires: it may be sitting in the queue offline.

**W11 — Refresh and materialisation.** The log is in memory. Durability is the
outbox's job.

- **On bootstrap**, the arm builds its objects from server rows. It then walks `transport.pending()`: queued entries, then awaiting-truth entries, in kernel queue order. For each entry that `editForPendingWrite` maps to a slice edit, it paints the patch, appends the edit under the entry's mutation id (passing the kernel's enqueue-time `base` when present) and, for an awaiting-truth entry, settles it at once. It then passes each such row's current server values through `log.remote`, which confirms edits whose echo landed before the reload. **The arm never re-sends.** The kernel's outbox replays its own queue on reconnect, deduped by mutation id, and the receipts arrive under the same txIds.
- **Dead-lettered entries** are not re-applied. They were rejected, and they live in the kernel's recovery surface.
- **Mark-read after a reload** paints `queuedAt`, not the pre-reload press instant. The difference is milliseconds.
- **When a cold object materialises** while it has pending edits (Ma3/Ha3 lazy loading; a bootstrap entry on a cold row, W1a), the arm builds it from the server row, then writes each pending edit's patch, oldest first.

**W12 — What the prototype path does not consult.** Not the kernel's fold:
the painted `EngineState.issues`, `sessions` and `issueProjections`,
`OptimismLedger.overlaysFor` and `foldStable`, the awaiting-truth stage, and
the `retired` event it drives. The kernel keeps running all of it unchanged for
the legacy surfaces, which is what lets the two coexist in the live demo. It
follows that **a phase-c arm's per-row feed must carry server truth: replica
rows with no ledger overlay**. If the kernel's overlay is in the feed, a remote
value landing on a pending field is invisible (the feed repaints ours), and a
rejection rewinds twice.

Mc2 (POD-4574, ruling F4) fixes the gate expectation the same way: on pending
rows the expected display is server truth plus the shared reference log —
`write-contract.ts` rules alone over the feed's server rows, projected through
the shared slice oracle (`shared/src/gen/write-oracle.ts` `WriteOracle`,
shared with Hc2). The kernel's fold is never expected values. Kernel-fold
differences (an applied overlay retired on moved-past-baseline while the
contract holds, or a chained overlay held past a newer server value) count per
check as `kernelDiffers`: a finding for the decision document, not a failure.
The stale-hold allowance lives in the shared oracle with no condition on the
arm, so an arm that copies the kernel's hold fails there.

Mc2 (POD-4574, oracle-pipe skew ruling) fixes how the oracle observes: the
reference oracle subscribes to the feed's delivery stream — remotes, receipts,
echoes — and applies each event **in delivery order, at the same moment the
arm's own subscription sees it** (`WriteOracle.watch`, installed before the
step's apply starts). `onStep` (`feedStep` for intents, `refresh` for reloads)
is comparison and intent-feeding only, never a later remote sync: W8's
overtake reads `ackBase`, the value seen at receipt, so it is order-sensitive
by design, and a later pipe is a different sequence that resolves opposite.
Each check's result file keeps the ordered event list consumed per differing
row, so a skew reads directly from the output.

Reading a disposed `RowSource` throws (`snapshot()` and `row()` in shared
`row-source.ts`, POD-4574) instead of serving whatever it last held. A stale
arm reading stale rows matches nothing — which once looked like a 54-row
rollup bug — so the refresh-step compare runs on the new arm after the swap,
and every step keeps its oracle compare, refresh steps included.

## 3. The mapping for the slice's editable fields

| Edit | App action today (`engine/actions.ts`) | Outbox kind → tRPC command | Partition / collapse (`OUTBOX_ROUTING`) | Echo recognised by | Refusal (`shouldParkDeadLetter`) | txId |
|---|---|---|---|---|---|---|
| `edit('issue', id, { title })` (rename) | `updateIssue(id, { title })` :974 | `issueUpdate` → `issues.update` | `issue:<id>` / none | `exact` | **parked**: a title is authored text, kept for recovery. `Rejection.error.parked = true`; the object still rewinds | the mutation id the arm passed as `opts.mutationId` |
| `edit('issue', id, { stage })`, stage ∈ backlog, planning, in_progress, review | `updateIssue(id, { stage })` :974 (menus: `parseIssueStatusValue` → `kind: 'stage'`) | `issueUpdate` → `issues.update` | `issue:<id>` / none | `exact` | reverted + toast ("a refused stage click just snaps back") | same |
| `edit('issue', id, { title, stage })` | `updateIssue(id, { title, stage })` | `issueUpdate` → `issues.update`, one entry | `issue:<id>` / none | `exact`, both fields | parked (carries a title) | same, one txId |
| `edit('issue', id, { readAt: <ISO> })` (mark read) | `markIssueRead(id)` :967 (its `pendingReads` dedupe is bypassed: the arm calls `enqueueOverlayed` directly) | `issueMarkRead` → `issues.markRead` | `issue:<id>` / `issue-read:<id>` (**supersede possible**) | `stamp` | `discard-automatic`: no toast, the object rewinds | same |

The arm calls the runtime's `enqueueOverlayed` seam (`runtime.ts:1342`) rather
than the `EngineActions` wrappers, so that it can name the mutation id (W2).
Each wrapper is a one-line call to the same seam with the same kind and input.
The test "matches the kernel routing, park and TTL tables the rules rely on"
pins the command names, routing, park decisions and TTL against the kernel's
own tables, so a kernel change that breaks a rule fails there.

## 4. Sequences

Each numbered step is one call. "Object" is the arm's model object; "log" is
the pending log; "kernel" is the outbox plus runtime.

### S1 Happy path: edit → paint → command sent → echo → settle

1. The user renames i1 from "Old" to "New". `edit('issue', 'i1', { title: 'New' })`.
2. The arm records `prior { title: 'Old' }` and `priorIdentity`, and mints tx1.
3. In one action it writes the title and calls `log.append(tx1)`. The row paints "New": 1 row commit.
4. `transport.send(tx1, issueUpdate { id: 'i1', patch: { title: 'New' } })`. `edit` returns tx1.
5. The kernel enqueues under tx1 and drains. The server applies it. Outbox `applied(tx1)` becomes `accepted(tx1)`, and `log.settle` records the receipt. The echo has not arrived, so the edit stays.
6. The server row arrives with title "New". `log.remote` confirms tx1, and tx1 leaves the log. `changes` is empty, so nothing repaints.

Echo before receipt: steps 5 and 6 swap. The echo confirms tx1 while local
still wins, and the receipt removes it. Mark-read is the same except for the
echo: the server's stamp differs from the client's. When the edit leaves, the
object takes the server stamp. This is the one "truthful second" repaint. It
is invisible, because readAt is compared with activity times that are far
apart. Tests: *echo after the receipt settles on the echo*, *echo before the
receipt…*, *a stamp field settles on the server clock*, *a stamp echo before
the receipt…*.

### S2 Rejection: edit → paint → reject → rewind to prior → error surfaced

1–4. As in S1. The row shows "New".
5. The server refuses. The kernel parks the entry (a title) and emits `dead-lettered`. L3b delivers `rejected(tx1, { parked: true })`.
6. `log.reject` removes tx1. The display falls back to the server value "Old". The log is now empty and no server row arrived in between, so the outcome carries `restoreIdentity` and the arm reinstates the original row object.
7. The arm fires `onRejected(tx1)`. The kernel has already toasted "could not save" and holds the words in recovery.

Variants: a server value "Theirs" landed while the edit was pending, so the
rewind shows "Theirs" and there is no identity restore. Two stacked edits:
rejecting the newer one shows the older one's value, and rejecting the older
one repaints nothing. Tests: the five under *S2 rejection*.

### S3 Remote update on a pending field

1. tx1 renames i1 to "Mine" and is pending.
2. A server row arrives: title "Theirs", stage "review". Stage has no pending edit, so the object takes "review". Title is pending, so the object keeps "Mine" and the log records "Theirs" as the rewind target.
3. `accepted(tx1)`. The value seen at the receipt is "Theirs".
4. The echo "Mine" arrives, and tx1 leaves.

Branches:

- If a newer writer's "Later" arrives after our echo but before our receipt, local still wins until the receipt. Then tx1 leaves and the object shows "Later" (last writer wins).
- After the receipt, a repeat of the value seen at the receipt is stale and ignored. A third value overtakes: the object shows it and tx1 leaves.

Tests: the five under *S3 remote update*.

### S4 Duplicate receipt (idempotent)

1. tx1 settles fully (receipt, then echo).
2. A second `accepted(tx1)` arrives, because the server dedupes a replayed send by mutation id and answers again. `log.settle` returns null: no change.
3. A late `rejected(tx1)` also returns null. The object stays as it is.

The same holds after a rejection: a later receipt or rejection is a no-op. An
unknown txId is always a no-op. A **reused** txId on `append` throws, because
that is a programming error, not a network one. Tests: *S4 duplicate receipt…*.

### S5 Refresh with pending edits

1. Offline, the user renames i1 to "Queued" (tx q1) and marks it read (tx a1). a1 drained and got its receipt before the tab closed; q1 is still queued.
2. The tab reloads. The in-memory log is gone. The outbox persists q1 (queued) and a1 (awaiting truth).
3. The arm bootstraps the objects from server rows: title "Old", readAt null.
4. It walks `transport.pending()`. For q1 it paints "Queued" and appends under txId q1. For a1 it paints readAt from `queuedAt`, appends with the kernel's enqueue-time base (null), and settles at once. A session `rename` entry maps to nothing and is skipped.
5. `log.remote(i1, server values)`: the server readAt is non-null, so it is a1's echo, which landed before the reload. a1 leaves and the object takes the server stamp. q1 stays.
6. The kernel reconnects and replays q1 under the same mutation id. `accepted(q1)` arrives, then the echo, and q1 leaves.

The arm sent nothing in this sequence. Test: *re-applies queued and receipted
outbox entries in queue order*.

### Also covered

- **Supersede:** two queued mark-reads. The outbox collapses the first. It leaves with no repaint and the second carries the value.
- **TTL:** a receipted edit with no echo leaves at exactly `ECHO_TTL_MS` and the row returns to its original identity. An unreceipted edit never expires.

## 5. What other round-three issues need from this

- **L3b (POD-4554), receipts.** Its brief says `accepted(txId)` fires "when the echo arrives". That cannot be keyed by txId, because frames carry no mutation id (W7). Under this contract, `accepted` is the outbox `applied` event. L3b also needs to:
  - add `superseded(txId)` (W9);
  - turn an enqueue failure into `rejected(txId)`;
  - add the optional `mutationId` pass-through on `enqueueOverlayed` (W2);
  - expose `pending()` with `queuedAt`, the acked flag and the enqueue-time base (W11).

  It must not read the folded arrays or the `retired` event, and its own pitfall already says so.
- **L3a (POD-4553), per-row feed.** Its brief overlays the ledger's pending rows onto each row. The phase-c arms need a mode **without** that overlay, delivering server truth (W12). Otherwise W8 cannot be observed.
- **L4a (POD-4555), random changes.** The generator should interleave edits, receipts, rejections, supersedes, echoes (including echo-before-receipt), stale repeats, overtaking writes, TTL expiry and a reload mid-sequence. The expected snapshot is the WHOLE display from server truth plus the reference log (`WriteOracle.expectedSnapshot`, fed by `feedStep`): the feed's server rows with the reference log's pending display overlaid per row, run through the shared slice oracle — membership, order, groups, decay windows and roll-ups follow the spec rules over the overlaid rows. The oracle consumes the delivery stream in order (W12); generated edits go through the arm via the shared `ArmEditAdapter` (`shared/src/gen/arm-edits.ts`, reused by Hc2).
- **L6b (POD-4564), planted mistakes.** Candidate write-path mistakes, each killed by a test here: rewinding to the stale `prior` instead of the latest server value, settling on the receipt alone, and treating the stamp echo as exact.

## 6. Evidence

- `write-contract.test.ts`: 23 tests, green.
- Mutation check. Each of 8 mutants was planted alone in the reference log and killed by at least one test:
  - show the oldest pending edit instead of the newest;
  - remote values overwrite pending fields;
  - remote values do not update the rewind target;
  - a second receipt is not a no-op;
  - stamp echo treated as exact equality;
  - no overtake after the receipt;
  - identity from the last edit instead of the first;
  - unreceipted edits expire.

  The stamp mutant first survived: after the receipt, the overtake rule gives the same answer. The test *a stamp echo before the receipt…* was added, and it now kills that mutant.
- Mc2 gate-truth plants (`arms/mobx/pool/write/gate-truth.test.ts`, the executable proof for the F4 and stream-order rules above): rewind-to-current — a rejection restoring the edit-time row instead of current server truth (`plant (a)`); double-commit echo — an echo with equal values committing again (commit-count cell in `settle.test.tsx`); remote-overwrites-pending — a remote dropping the pending entry (`plant (c)`, fixed sequence and random run); duplicate receipt — a second `accepted` applied twice (commit-count cell in `settle.test.tsx`); late-observing oracle — remotes held until receipt, the old onStep-sync skew moved into an arm (`plant (iii)`, seeds 1@119, 2@139, 3@9). Each proven red alone and restored. The Mc2 truth gate is 20 seeds x 300 steps green with `kernelDiffers` tallied per seed as the legacy finding.
- `bun run typecheck -- --filter @podium/worklist-proto` is green. It ran uncached and pins `KernelCommand` inputs to the kernel's `OutboxKinds`.

## 7. Open questions

1. **Dead-letter recovery in the prototype.** A parked title retried from the kernel's recovery surface re-enters the queue. A `max-age` retry gets a new mutation id (outbox.ts:470-487). The prototype sees it only at the next bootstrap. That is acceptable for round three, since the recovery surface is legacy UI. The production client would treat a retry as a new edit.
2. **Equal-value overtake.** A newer writer setting the field back to the value seen at the receipt looks like a stale repeat. The edit then waits for the TTL (W10) while showing ours. This is the kernel's bound as well.
3. **File name.** The acceptance names `pod-pod-4545-round-three-write-contract.md`. It is written as `pod-4545-…`, following L1a, whose acceptance had the same doubled prefix and which landed as `pod-4545-round-three-schema.md`.
