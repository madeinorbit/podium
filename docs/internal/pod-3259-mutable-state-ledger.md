# POD-3259 — mutable process-state ledger

One row per registry that mutates a process-owned object before its commit, or
restores one on failure: the site by symbol, the category, the model chosen, and
what proves it. This is the B-prep ledger row set the execution method's §2 asks
for (`docs/internal/pod-3221-execution-method.md`), for spec §2.5 item 9 and
spec §3.6 (`docs/internal/pod-3221-spec.md`).

The three models are [0.6]'s, in `apps/server/src/store/executor/state-models.ts`:

| | Model | What it is |
|---|---|---|
| (a) | WRITE-LEASE-BEFORE-READ | take the write unit of work before reading or mutating; every reader takes the read lease |
| (b) | DRAFT-THEN-INSTALL | build an immutable draft from a committed snapshot, persist the draft, install only after the commit |
| (c) | VERSIONED PROJECTION | serialise state that has no database write to hang off, with a version a caller can pin so a stale decision is refused |

## How the registries were enumerated

Not by hand. Two derived sets, then every site in them classified:

1. Every `ledger.commit(` and `funnel.run(` in non-test server code — 38 sites in
   14 files — read for a process-owned object written before or after the span.
2. Every `catch` block in non-test server code whose body restores in-memory
   state (matched on `this.<x>.set/delete`, `Object.assign`, `restore*`, and
   assignment from a `backup`/`captured`/`snapshot`/`previous` binding). That
   returns exactly three persistence rollbacks — `issues/service/core.ts` twice
   and `sessions/repository.ts` once — plus two unrelated catches
   (`superagent/headless.ts`'s timeout resolve, `updates/service.ts`'s message),
   which is the evidence that the brief's list was complete rather than merely
   plausible.

## A. Registries changed by this issue

| # | Registry (symbol) | Category | What breaks once the store awaits | Model | Where |
|---|---|---|---|---|---|
| 1 | `IssueRegistry.rows` — `issues/service/core.ts` `persistWith` / `persistManyWith` | mutate-in-place, then restore-by-assignment on throw | Every mutation path took the MAP'S OWN object, assigned onto it, and persisted it: readers see fields no committed row backs, and on a throw the loser's `Object.assign(row, backup)` writes the WINNER's row back to a stale value — silently, both callers told they succeeded | **(b)** drafts + a durable revision precondition | `core.ts` `draft`/`draftOrThrow`/`draftOf`/`registerNewDraft`; `store/issues.ts` `upsertIssue(row, { expectedRevision })` |
| 2 | `SessionRepository` — `sessions/repository.ts` `persist`, `sessions/session-meta-ops.ts` `mutateSessionMeta` | live object mutated inside the write callback; capture-and-restore on throw | The committed baseline was re-captured from the LIVE session AFTER the commit, so anything that changed during the write became "committed"; and a rollback rewound the live terminal half with it | **(b)** on the durable snapshot, with an explicit live/durable line. **The mutation half is NOT converted — POD-3330** | `repository.ts` `commitDurableBaseline`, `committedDurableState`; `terminal.ts` `restoreState` |
| 3 | `ShippingService.leases` — `shipping/service.ts` `claimAttempt`, `claimDurableTrain`, `heartbeat` | in-memory projection written after `ledger.commit` returns, read by `tick()`, `reconcile()` and `runEffect` | A cancellation, hold, settlement or train abandon landing in the gap DELETES the lease, and the claim's install then puts back a lease for an attempt that has just been revoked; and `heartbeat` moved `expiresAt` on the shared object under a claim deciding against it | **(c)** the projection behind its own version | `shipping/lease-projection.ts` |
| 4 | `MessagesService` mirrors — `messages/service.ts` `markDelivered` | mirror moved before its durable write | `requeueCounts.delete` stood BEFORE `messages.markDelivered`: a delivery that fails to commit hands the row a retry cap it did not earn, and a requeue landing in the gap has its count dropped by a delivery that never happened | rule 12 — the mirror moves with the commit | `messages/service.ts` |

### 1. Issues — what the model actually is

A mutation path takes a **draft**: a copy of the committed row, pinned to the
revision it was cut from. The draft is what is persisted, and it is installed
into `rows` only after the commit. Nothing is rolled back on failure, because
the shared object was never touched — the `Object.assign(row, backup)` in both
`persistWith` and `persistManyWith` is deleted rather than reworked.

`prepareSoftDelete` and `prepareRestore` had this shape already (`{...current}`,
installed in `apply()` after the commit); this generalises it to every write and
gives all of them the precondition none of them had.

The pin is checked **once, and durably**: `upsertIssue`'s `expectedRevision`
refuses inside the transaction, so a loser's write rolls back instead of
overwriting the winner's columns. A second, in-memory check at install time was
written first and then **removed** — it can never fire (the install follows a
write that would already have been refused) and it CAN fire wrongly, because a
`reload()` landing between the commit and the install re-hydrates the map to the
revision this very write just committed, and the install would refuse itself. An
unreachable guard with a false-positive arm is worse than no guard.

Two mechanism details worth the reader's time:

- **`persistWith` refuses the map-owned row outright.** That refusal is how the
  conversion set was derived rather than hand-listed: a path that forgets to
  draft fails loudly instead of working by accident for as long as the store
  stays synchronous.
- **The install puts a SNAPSHOT in the map, not the caller's object**, and
  re-pins the caller's draft to the revision just committed. That is
  load-bearing: `cleanup()` persists one draft four times as each git step
  settles, and `inspectRemovableWorktree` persists its caller's row before
  handing control back. If the caller's object became the map's object, its
  second write would be a shared mutation again and the refusal above would
  reject it.

Converted mutation entry points (the derived set): `crud.ts`
`shippingCommit`, `shippingCommitMany`, `setState`, `panelApply`, `update`,
`markIssueRead`, `markIssueUnread`, `setIssueTucked`, `setLabels`, `share`,
`unshare`, `undefer`, `applySuggestion`, `dismissSuggestion`, `create`,
`compactSortKeys`; `workflow.ts` `start`, `action`, `freeWorktreeKeepBranch`,
`ensureWorktree`, `cleanup`, `rehome`; `attention.ts` `maybeTakeOriginWorktree`,
`autoArchive`; `hierarchy.ts` `addDep`, `removeDep`, `reparent`; `assistant.ts`
`refreshAssistant`; `mail.ts` `addComment`.

`rehome` is the one that needed more than a `draft()`: it assigned
`row.repoPath` onto the map's row and then called `update()`, so the new
repoPath stood on the shared object whether or not the update committed. It now
threads the value through `update`'s internal `opts.repoPath`. Widening
`IssuePatch` instead would let the router move an issue between repositories,
which is a different decision and not this issue's.

### 2. Sessions — which fields may change while persistence is awaiting

The question the spec asks by name. The answer, now written into
`repository.ts` and enforced in `terminal.ts`:

| Half | Fields | While a persist is in flight |
|---|---|---|
| DURABLE METADATA | everything `Session.captureDurableState()` returns except its `terminal` grid: cwd, issue/ref bindings, machine, resume, conversation binding, title/name, archived, stop/exit, work and agent state, model/effort pairs, offer, transcript availability | May NOT be treated as settled. Snapshotted before the write; that snapshot becomes the committed baseline when the commit returns; a failed commit rolls it back |
| LIVE TERMINAL | frames, the cursor, `outputAt`/`inputAt`/`resumedAt`, the input/output/activity counts, `activityDirty`, `shellBusy`, `shellCommandRunning` | MAY change, and does — a pty does not stop producing output because a metadata row is being written. NOT rewound by a rollback |
| GEOMETRY | the terminal grid | Restored by a rollback (a rollback undoes what the SERVER believed and clients cached that belief), unless the caller's preserve set says otherwise |
| PRESERVED VOLATILE | the four `SessionVolatileField`s — `geometry`, `status`, `machineId`, `handoffTarget` | Explicitly preserved through a rollback by the pending-volatile preserve set, which already existed for exactly this reason |

### 2a. Two things this registry got wrong on the first attempt

Both are recorded because the wrong answer is the tempting one.

**A version-pinned rollback is a bug, not a refinement.** The first version of
this change gave `capturedSessionStates` a version and had a failed persist
stand down when another persist had committed while it was in flight —
symmetrical with the issue registry's revision pin, and wrong. That map holds
the LATEST committed state, so restoring it is right whether or not somebody
else committed in the gap; standing down leaves the failed write's OWN
uncommitted fields on the live object. The case that separates the two is two
writers touching DIFFERENT fields, and the refusing version loses it. The
version was removed, the field's doc says why, and the mutation that deletes the
restore entirely is what the test kills.

**The mutation half is not converted, and there is a failing case for it.**
POD-3259 converted the snapshot half: the baseline is the draft that was
written. Every write path still assigns onto the LIVE `Session` before its
commit, so two writers share one object — and the winner's draft is captured
from an object already carrying the loser's uncommitted fields, which the winner
then makes durable. `repository.state-model.test.ts` pins this as a named
CHARACTERIZATION rather than asserting the behaviour anyone wants, and
**POD-3330** is the sub-issue that fixes it and flips the assertion. It was split
out rather than done here because it is a ~15-file refactor of the session write
paths (`session-teardown.ts`, `daemon-lifecycle.ts`, `session-start.ts`,
`session-revival.ts`, `handoff/transfer.ts`, `naming.ts`, `client-control.ts`,
`session-state/service.ts`) and B0.4 is one of seven B-prep issues landing in
parallel; it must land before the flip.

### 2b. The live half being rewound

This was a real finding, not a documentation exercise.
`Terminal.restoreState` put `times`, `counts`, `dirty` and `shell` back. Today
that is a no-op — capture and restore are one uninterruptible pair — but once
the commit between them can await, a failed metadata write would discard
activity that really happened, and `dirty: false` in particular would tell
`flushActivity` there is nothing to write, losing the counter advance until the
next frame. The rollback now restores the grid and leaves the live half alone.

### 3. Shipping — why (c) and not a mirror install

The lease projection is the one registry here with no row to hang off: a claim's
attempt id exists only once its write has returned, so the projection cannot be
re-read from the store while a claim is deciding. So a claim pins
`leases.version` before its commit and `installIfUnchanged` refuses the install
when the projection moved.

Refusing is safe and self-healing rather than lossy: `runOrder` and `runEffect`
both reconstitute a missing lease from the durable attempt, so the worst case is
one pass re-deriving what it needs, while installing over a revoke is
unrecoverable without a restart. A refused install writes a
`shipping.lease_install_refused` audit row rather than passing silently.

**The version is per order, and that is a correctness requirement rather than a
refinement.** The first version of this change used one projection-wide counter.
Renewals arrive continuously from the daemon and every one of them moves such a
counter, so a claim of any duration would be refused by heartbeats that have
nothing to do with it — and a train claim installing several orders would refuse
its own second install because its first had moved the counter. Both are pinned
by tests.

The version is a plain counter and not a mutex: nothing here awaits, and a lock
that can only be taken and released inside one synchronous turn would prove
nothing. What the model needs is that a decision taken before a write can be
refused after it, and a pinned counter is exactly that.

### 4. Messages — the honest size of this one

Three of the four mirrors around `markDelivered` were already on the right side
of their write (`forgetLiveQueuedForExit`, `turnHop.set`, `emitTransition`), and
`liveQueuedForExit` is populated only after a durable re-read confirms the
queued state. The fourth, `requeueCounts.delete`, stood before it and was moved.

**No test can distinguish the two orders**, and that is a property of the code
rather than a gap in the tests: POD-1703 made `requeueCounts` a pure cache in
front of the durable `message.requeued` event log, so a dropped entry is
re-derived with the same number on the next read. It is recorded here because
"unobservable today" is exactly the class of thing the flip turns observable,
and because a reviewer should be able to see it was reasoned about rather than
missed. Its evidence is the delivery characterization suites staying green.

## B. Registries inspected and left alone

Each of these reaches `ledger.commit` or `funnel.run` and holds no
process-owned object that is mutated before the commit or restored after it. No
change made; listed so the flip's reviewer can see they were looked at.

| Site | Why no model is needed |
|---|---|
| `AutomationService` — `automations/service.ts` (6 commits) | No in-memory registry at all: the store is the source of truth and every patch is built as a fresh spread (`{...current, ...}`), so it is already draft-shaped |
| `IssueSessionLifecycle` — `issue-session-lifecycle.ts` (2 commits) | Built on the `prepare`/`write`/`changes`/`apply`/`publish` plan pair, which installs into memory only in `apply()`, after the commit. This is the precedent registry 1 generalises |
| `SessionKill.killSession` — `sessions/session-kill.ts` | Durable tombstone first, live teardown after, deliberately (#247): a commit throw leaves the session fully alive |
| `MemoryService.latestConversations` — `memory/service.ts` | A mirror written after the commit from a fresh object, with no await between (rule 12 as written) |
| `LockService` — `lock/service.ts` (7 funnel writes) | No process-owned registry; every decision is read from and written to the store. Its read-decide-write spans are spec §2.5 item 6 and belong to B0.5 |
| `MaintenanceService` — `maintenance/service.ts` | Single funnel write, no in-memory mirror |
| `IssueAttentionModule` subscriptions, `issues/service/mail.ts` claims | Funnel writes with no process-owned object |
| `SuperagentService.pendingTurns` — `superagent/headless.ts` | The `catch` the sweep found is a request timeout resolving its own promise, not a persistence rollback |
| `UpdateService` — `updates/service.ts` | The `catch` the sweep found builds a client-facing message; no state restored |

## C. What is deliberately NOT in scope

- `relay.ts`'s `SessionRegistry` aggregates and the frame caches are spec §2.5
  items 1 and 3 — B0.1 and B0.6.
- The read-decide-write spans in `lock/service.ts` and `messages/service.ts` are
  §2.5 item 6 and belong to B0.5's side-effect classification.
- Timer mirrors are §2.5 item 8 and were done by B0.3
  (`pod-3258-timer-guard-ledger.md`).

## Evidence

Three interleaving suites, one per registry that has a model object:

| Test | Registry | How the interleaving is produced |
|---|---|---|
| `modules/issues/service/issue-registry-model.test.ts` | issues | The ledger's `transact` seam: re-entering the registry from inside an open write span. `before` puts the second caller between the draft and the row write; `after` puts a reader between the row write and the install |
| `modules/sessions/repository.state-model.test.ts` | sessions | The ledger port's `commit`, same two positions |
| `modules/shipping/lease-projection.test.ts` | shipping | A real barrier — the projection is a plain object, so its "write" can genuinely be an awaited fake that parks |

**Why two of the three are re-entrancy rather than barriers.** The generic model
tests in `store/executor/state-models.test.ts` park an async persistence fake,
because `DraftRegistry` and `LeasedState` are already async. `IssueRegistry` and
`SessionRepository` are not: `persist` is synchronous top to bottom, so there is
no await to park on and a barrier could only ever be released after the write had
already finished. Re-entering from inside an open span IS the window an awaited
commit will open, and it is the only one available before the flip — the same
technique, for the same reason, as POD-3258's guard tests. These tests are
meaningful now and unchanged after the flip.

Every guard was mutation-checked by disarming it and re-running its suite; the
kills and which test caught each are in the issue's handoff.
