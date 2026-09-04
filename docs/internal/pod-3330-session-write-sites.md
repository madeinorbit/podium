# POD-3330 — the session write sites, classified

The mutation half of the session registry's state model. POD-3259 converted the
SNAPSHOT half (the row a write persists is a draft cut before the commit, and
that draft becomes the committed baseline); this converts the MUTATION half, so
the fields a write changes live on that draft rather than on the shared
`Session` until the commit returns.

## The mechanism, in four pieces

1. **`SessionDurableFields`** — every field `SessionDurableState` carries except
   the terminal grid. A live `Session` satisfies it and so does a draft. That
   assignability is load-bearing twice: it lets the projections default to the
   live object with no clone on the broadcast path, and it fails at typecheck if
   a durable field is added to the bag and not to the class.
2. **The projections take a durable source.** `Session.toRow(d)`,
   `Session.toMeta(overlay, d)`, `SessionView.wire(session, principal, memo, d)`
   and `SessionTerminalProof.facts(session, lease, checkpoint, d)` all default
   `d` to the live object and read every durable answer from it. The live-half
   reads — geometry, the counters, epoch, controller, client count, and the
   identity/launch fields — stay on the session, because they are not what a
   metadata write is about.
3. **The repository seam.** `draft(session)` cuts a copy;
   `persistDraft(session, draft, additionalWrite?)` projects the row and the
   declared change FROM that draft, commits, and only then installs it on the
   live object; `write(session, mutate, additionalWrite?)` is the two together
   and is what a call site normally uses. `persist(session, additionalWrite?)`
   keeps its old meaning — "restate this session's current durable state" — for
   the paths that change nothing durable, and is now literally `persistDraft`
   with a fresh capture, so there is one body and one commit tail.
4. **The install's preserve set is the volatile work that landed DURING the
   write**, not the pending entry the write inherited: a sweep that marked
   `status`/`machineId`/`handoffTarget` dirty while the commit was in flight
   knows something newer than this draft about those fields. Nothing suspends
   today, so the version cannot move and the whole draft installs — which is
   exactly what assigning onto the live object did before.

`Session`'s sixteen mutating methods (`onExit`, `markLive`, `setAgentState`,
`markSpawnError`, `clearOffer`, …) take the same optional durable target, so a
write path passes its draft and their live effects — `terminal.stopOutput()`,
the `agentExit` frame, the unread re-arm — stay where they are.

`setResume(next, d)` is new and is not a convenience. `resume` is an ACCESSOR
whose setter promotes `conversationBinding` to `'bound'`; a draft is a plain bag
with no setter, so `draft.resume = ref` would silently skip the promotion and
leave a session that has a native conversation still claiming it never bound one
— the fact `neverBound` exists to make un-loseable. Four write paths assign a
resume ref and all four go through it.

## The sites

Shape key: **D** = drafted (the write now mutates a draft);
**D-txn** = drafted, and the mutation happens INSIDE the transaction because the
store decides it; **S-live** = safe, the span changes only the live half (or a
row column the durable bag does not carry) and `persist` restates it;
**S-nospan** = safe, a live mutation with no commit in the span at all;
**deferred** = not converted, with the reason.

| # | Site | Fields | Shape | Note |
|---|---|---|---|---|
| 1 | `session-meta-ops.setOffer` | `offer` | D | satellite `offers` row rides the same commit |
| 2 | `session-meta-ops.clearOffer` | `offer` | D | the live `clearOffer()` was asking a question by MUTATING; it is now a read |
| 3 | `session-meta-ops.setSessionIssueId` | `issueId`, ref triple | D-txn | `prepareRefAllocation` reads the issueId this write just set — the case where passing the live object would decide against the previous attachment |
| 4 | `session-meta-ops.setSessionCwd` | `cwd` | D | |
| 5 | `session-meta-ops.mutateSessionMeta` | any | D | the callback now receives the draft; every caller's body is unchanged because the bag's field names are the class's |
| 6 | `naming.rename` | `name`, `nameSource` | D | |
| 7 | `naming.setAgentName` | `name`, `nameSource` | D | |
| 8 | `session-state.setArchived` | `archived` | D | |
| 9 | `session-state.setWorkState` | `workState` | D | |
| 10 | `session-state` DRAFT tag (`applyDraftEdit`) | `draftUpdatedAt` | D | only the branch that PERSISTS is drafted; the other advances a stamp nothing is committing, and stays a live assignment |
| 11 | `session-state.installSession` | `draftUpdatedAt` | S-nospan | attaches off-row metadata to a session being installed |
| 12 | `daemon-projection` agentColor / agentModel / agentContext | colour, observed model/effort, context % | D | all three ASK before they write; the draft is where the answer is computed |
| 13 | `daemon-projection` title (both arms) | `title` | D | `titleLocked` stays live — it is not a row column |
| 14 | `daemon-projection` sessionCwd | `cwd` | D | |
| 15 | `daemon-projection` transcriptDelta | — | S-live | the terminal adopted the delta and promoted `transcriptAvailable`/binding through its own callback |
| 16 | `daemon-lifecycle` agentExit | `status`, `exitCode`, stop metadata | D | `onExit` moved from the top of the method to the write; its live effects move with it |
| 17 | `daemon-lifecycle` spawnError | same, plus `spawnFailure` | D | the driver fields it clears are transient/row-only and stay live |
| 18 | `daemon-lifecycle` bind | `cmd`, `status`, `exitCode` | D | the handle facts (`driverId`, `configureFields`, …) are live; the drain below still sees `live`, because the install follows the commit immediately |
| 19 | `daemon-lifecycle` reattachFailed | `status`, `exitCode`, stop metadata | D | |
| 20 | `daemon-lifecycle` agentObservationRebind | `resume`, `conversationPodiumId` | D-txn | the store's rebind decides whether the binding advanced; only then is there an identity to record |
| 21 | `daemon-lifecycle` agentObservation checkpoint | `agentState`, compute totals, `lastActiveAt` | D | **and the candidate facts are derived from the same draft** — `facts()` reads `lastActiveAt`, which this call advances, and the hibernate path re-derives and compares byte-for-byte |
| 22 | `daemon-lifecycle` agentState (legacy) | `agentState`, compute totals, `lastActiveAt` | D | the fold accumulates on top of the previous total, so it is exactly the write a second writer must not capture half-finished |
| 23 | `daemon-lifecycle` driverSelected | `selectedDriverId` | S-live | a row column with no durable-state field — see the gap below |
| 24 | `daemon-lifecycle` geometryApplied | — | S-live | |
| 25 | `runtime-event-gate` accepted event | `lastActiveAt`, `lastOomKillAt` | D | both were assigned two statements before the commit |
| 26 | `runtime-event-gate` state projection (wired in `session-wiring`) | `agentState`, compute totals | D-txn | runs INSIDE the transaction body, which is now handed the same draft; on the live object its write would not have reached the row |
| 27 | `runtime-event-gate` duplicate/rebase | — | S-live | checkpoint row only |
| 28 | `session-binding` conflict loser | `resume`, `conversationPodiumId` | D | through `setResume`, which is also where the "the ref goes, the binding does not" rule keeps holding |
| 29 | `session-binding` observed ref | `resume`, `conversationPodiumId` | D | the memory-service identity call is HOISTED above the draft (rule 26) |
| 30 | `machine-reconciler.reviveParkedButAlive` | `status`, `exitCode` | D | |
| 31 | `machine-reconciler` daemon-gone sweep | `status` | S-nospan | `markReconnecting` + a volatile dirty mark; the sweep persists |
| 32 | `session-teardown.parkArchivedSession` | `status`, `exitCode`, stop metadata | D | |
| 33 | `session-teardown.parkShellSession` | same | D | |
| 34 | `session-teardown.parkStaleSession` | same | D | |
| 35 | `session-teardown.stopSession` | same | D | |
| 36 | `session-teardown.hibernateSession` | `status` | D | **and its rollback-by-assignment is deleted**: it restored a status it had overwritten before the write, which nothing overwrites any more. Its revalidation still reads the LIVE session, deliberately — see below |
| 37 | `session-revival.finishResurrect` | `cwd`, `status`, `exitCode`, resume stamps | D | the cwd is HOISTED: it is read twice before the write and the ensure that produced it may have been awaited |
| 38 | `session-revival` reopen | stop metadata | S-nospan | `markResumed` with nothing persisting in the span |
| 39 | `session-start` spawn | ref triple | D-txn | the allocation takes a letter (or a draft ordinal) inside the transaction |
| 40 | `session-start` onActivity | `lastActiveAt` | S-live | the terminal advanced it; the row restates it |
| 41 | `handoff/transfer` source park | `status` | D | |
| 42 | `handoff/transfer` target commit | `handoffTarget`, `machineId`, `cwd`, `status` | D | one write: a reader that saw the new machine with the old cwd would be reading a session on neither side of the move. The draft is cut after every await |
| 43 | `handoff/transfer` finalize/rollback | same | D | |
| 44 | `handoff/preflight` overlay | `handoffTarget` | S-nospan | `mutateSessionView` + a volatile mark, no commit |
| 45 | `inbox` interrupt / cancel / drain head | `queuedMessageCount` | D | the `=== 0` check reads the DRAFT: it asks what the count will be |
| 46 | `inbox` enqueue | `queuedMessageCount` | D | |
| 47 | `inbox` prompt-failed keep | — | S-live | |
| 48 | `inbox.configureSession` | `requestedModel`, `requestedEffort` | **deferred** | see below |
| 49 | `superagent/headless.setHeadlessResume` | `resume` | D | through `setResume`, on the path whose mint-site comment says this is what promotes the binding |
| 50 | `superagent/headless` turn activity | `agentState`, compute totals | D | |
| 51 | `superagent/headless` mint | — | S-live | a session created one statement earlier |
| 52 | `repository.flushActivity` | — | S-live | counters |
| 53 | `repository.loadFromStore` / `installStoredSession` | offer, binding, queued counts, checkpoint re-seed | S-nospan | the boot install; nothing is in flight because the row is where these came from |
| 54 | `repository` ref backfill | ref triple | D-txn | same as 39 |

## The one deferred site, and why

`SessionInbox.configureSession` still assigns `requestedModel`/`requestedEffort`
to the live session before its `persist`. It is the only session write path left
doing so.

`inbox.test.ts` pins that write with `expect(h.persist).toHaveBeenCalledWith(h.session)`
and, in the two refusal arms, with `expect(h.persist).not.toHaveBeenCalled()`.
Converting the site renames the port the fixture observes: the first assertion
fails and — worse — the other two start passing VACUOUSLY, which is the shape
this programme keeps warning about. Spec rule 21 says a conversion commit does
not rewrite an existing assertion, so the site waits on a ruling rather than on
an opinion. The change is three lines in the test and two in `inbox.ts`.

## Two gaps this audit found and did not close

**The row has durable columns the durable bag does not.** `selectedDriverId`,
`requestedDriverId`, `accountId`, `loginHarness`, `model`/`effort` and the
workflow ids are `SessionRow` columns with no `SessionDurableState` field. They
are written on the live object and persisted, a rollback does not restore them
today either, and `toRow` reads them from the session rather than from the draft
— which is why the conversion leaves them working exactly as they did. The
honest description is that the durable bag is a SUBSET of the row, and nothing
says so anywhere. Widening it is a behaviour change (a rollback would start
restoring them), so it is named here rather than done.

**Two live paths mutate durable fields with no write span at all** (38 and 11
above). They are not in-flight state — nothing is committing — but they do leave
a durable field on the shared object that the next writer's draft will pick up
and commit. That is the pre-existing behaviour in both cases and converting
either would mean adding a durable write that does not exist today.

## Why `hibernateSession` still re-derives from the live session

The one place where reading the live object inside a write span is the CORRECT
answer, so it is written down rather than left looking like a miss. The
revalidation compares `facts()` derived before the write against `facts()`
derived inside it, to catch the session doing something in between. `facts()`
describes what the session has DONE — `lastActiveAt`, the input/output counters,
the queue, the resume ref, the machine, and the children's statuses. This write
changes `status`, which is not among them. So the live object is what the
comparison is about, and a draft cut before the first derivation would hide
exactly the change the guard exists to catch.

## Mutation evidence

A behaviour-preserving refactor cannot be proved by a green lane, so each claim
was mutated BY LINE and the run reports which named tests killed it. Lanes:
`server:services` (129 files) and `server:boundary` (120 files),
`PODIUM_TEST_WORKERS=1`, under the `test:heavy` lease with a short-path TMPDIR.
Every mutant was restored and the tree diffed byte-for-byte afterwards.

| Mutant | What it breaks | Killed by |
|---|---|---|
| M1 | `draft()` returns the live object | the two new state-model tests |
| M2 | the install happens BEFORE the commit | the same two |
| M3 | the row is built from the live object, not the draft | 11 named tests (naming point, rename, setWorkState, stop, hibernate, activity flush, …) |
| M4 | the declared CHANGE is built from the live object | 2 (rename's wire, the DRAFT-marker broadcast) |
| M5 | `agentExit` applies `onExit` to the live object inside the write | 4 |
| M6 | `bind` applies `markLive` to the live object | 35 |
| M7 | the legacy `agentState` fold writes the live object | 5 |
| M8 | the terminal candidate's facts derive from the live object | 1 — **the test added for it**; nothing covered this before |
| M9 | the observation rebind assigns the live object inside its transaction | 1 (`atomically rebinds an exact native session…`, boundary) |
| M10 | the spawn's ref allocation assigns the live object | 4 (`sessions.refs.test.ts`, boundary) |
| M11 | `finishResurrect` does not write the ensured cwd | **nothing** — see below |
| M12–M18 | the park/hibernate/enqueue/naming/archive sites write the live object | not run individually: M3 already kills every one of them, because a site that writes the live object writes a row built from the draft |

**M11 is an uncovered site and is reported rather than papered over.** Deleting
the cwd write in `finishResurrect` fails no test in either lane. The line is a
hoist of the same value the instruction preparation and the spawn frame already
read, so the conversion cannot change it — and the coverage gap is not new: the
assignment it replaced (`session.cwd = ensured.cwd`) is the same line with the
same tests around it, so nothing distinguished it before either.

**M8 is why the facts change is in this issue at all.** It survived both lanes
until `terminal-hibernation-proof.test.ts` gained an arm that observes a
checkpoint whose provider time is AHEAD of the row's recency. Every existing
test in that file stamps its observations in 2026-07, which is behind a freshly
created row's `lastActiveAt`, so the checkpoint never advanced recency and the
draft-vs-live difference could not be seen. The fixture gained one optional
argument (`terminalProviderAt`) and the default is unchanged.
