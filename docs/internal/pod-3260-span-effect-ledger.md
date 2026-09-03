# POD-3260 — span side-effect ledger

One row per transaction span in `apps/server/src` and `packages/sync/src`, by symbol:
what non-database work its body reaches, which of spec §3.3's three post-commit
mechanisms that work is, and what this issue did about it. This is the B-prep
ledger row set the execution method's §2 asks for
(`docs/internal/pod-3221-execution-method.md`), for spec §3.3 and Stage A
checklist item 6 (`docs/internal/pod-3221-spec.md`).

**Enumeration.** Every site that opens a transaction, found by reading rather
than by pattern, as the brief requires. Four kinds:

| Kind | Sites | Where |
|---|---|---|
| `transaction(this.db, …)` inside a repository | 43 | `apps/server/src/store/**`, `packages/sync/src/adapters/sqlite` |
| `SessionStore.transact` through a `transact` port | 12 | services, the kernel, the orchestrator |
| `ledger.commit` / `authority.commit` (`write` and `changes` are span bodies) | 20 | services |
| `funnel.run` (its `write` is a span body — `run` goes through `authority.commit`) | 17 | issues, locks, sessions, maintenance |
| client-replica `unitOfWork.transact` | 8 | `packages/sync/src/{replica,adapters}` |

The three server kinds are not disjoint: `funnel.run` reaches `authority.commit`
reaches `SessionStore.transact`, and `LockService` nests all three. They are
listed separately because each is a place a body was written.

## The finding, before the rows

The brief named seven sites. The defect is not seven sites, it is **two choke
points and one structural rule**, and fixing it at the call sites would have been
a list somebody has to keep complete.

1. **`EventsRepository.appendEvent` announced to the feed inside whatever span its
   caller had open.** 22 call sites reach it; several are inside spans
   (`LockService.steal`, `MaintenanceService`'s expiry job, the issues service's
   `emitEvent` under the attach orchestrator). The announcement is mechanism 3.
   `persistManyWith` already did this by hand with `announce: false` plus
   `announceEvent` after the commit — that convention is now the default, and it
   still works unchanged.
2. **`IssueService.sendMail`'s delivery nudge ran inside the caller's span.**
   `LockService` sends grant and steal mail from inside its lock transaction, so
   the hook fired — waking an agent — for a message a rollback could still take
   away. The durable message row is a different contract and does not move.
3. **A NESTED `ledger.commit` published inside the outer transaction.**
   `Authority.commit` broadcasts after ITS OWN span, which is correct only when
   that span is the whole transaction. `IssueAttachOrchestrator.execute` wraps an
   entire attach in one `SessionStore.transact`, so every commit under it is a
   savepoint and every subscriber was told about changes the outer body could
   still roll back — and on a throw the change rows DID roll back, leaving the
   feed ahead of the log with nothing able to notice.

Since the store is still synchronous and `postCommit()` needs an executor scope,
this issue also built the bridge that makes the mechanisms reachable at all:
`apps/server/src/store/executor/synchronous-span.ts`, with
`SessionStore.transact` wrapping its `transaction(this.db, fn)` in
`runSynchronousSpan` (the coordinator's edit, spec §6 rule 17). It is an
instrument; its deletion is POD-3327.

## A. Moved into a mechanism by this issue

| # | Site | What was inside the span | Mechanism | What it became |
|---|---|---|---|---|
| 1 | `EventsRepository.appendEvent` — `store/events.ts:291` | the feed `appendListener` call, for every one of the 22 appends that happens inside a span | 3 — external effect | `afterCommit(() => this.appendListener?.(id, announced))`. Outside a span it runs where it always did, and UNGUARDED: mechanism 3 isolates an effect because the transaction already committed, and out there catching would hide the wiring fault this listener's comment was written to expose. |
| 2 | `IssueCommentsMailModule.sendMail` — `issues/service/mail.ts:73`, nudge now at `:86` | `deps.onMailSent` — the send-time nudge | 3 — external effect | `afterCommit(…)`, keeping its own `try/catch`. The `addIssueMessage` write above it is UNCHANGED and stays nested: it is atomic with the grant that caused it, and spec §3.3 says durable mail is never reclassified as best-effort. |
| 3 | `Authority.finalize` — `packages/sync/src/authority/authority.ts:515` | subscriber delivery, when the commit is a savepoint under a wider span | 3 — external effect | New optional `AuthorityDeps.postCommit` (`PostCommitEffectPort`), threaded through `LedgerDeps`, wired in `relay.ts` to the bridge. Unset means immediate, so every client adapter and every existing test is unchanged. The baseline fold deliberately did NOT move with it — see D. |
| 4 | `IssueAttentionModule.attachSession` — `issues/service/attention.ts:234` | `void maybeTakeOriginWorktree(…)` — a git worktree take-over started inside the orchestrator's span and running on past it | 3 — external effect | `afterCommit(…)`. The fire-and-forget shape and its `catch` are unchanged; only the moment it begins moves. |
| 5 | `IssueAttentionModule.onIssueArchived` — `issues/service/attention.ts:635` | `void releaseWorktreeIfIdle(…)` — a round trip to the issue's machine, reached from inside `MaintenanceService`'s span by the auto-archive job | 3 — external effect | `afterCommit(…)`. `cascadeArchiveSessions` beside it deliberately stays — see D. |

## B. Already correct, and the convention the rows above copy

No change made. Listed because each one is evidence that the shape was known and
applied by hand, and because a reviewer meeting them should not "fix" them.

| Site | Shape |
|---|---|
| `IssueStore.persistManyWith` — `issues/service/core.ts:970` | appends events with `announce: false` inside the span, `announceEvent(id)` after it. The original of row 1. |
| `SessionKillService.killSession` — `sessions/session-kill.ts:129` | span body is two repository writes; the runtime teardown, the projection publish and the `session.exited` emit are all after the commit, with a comment saying why. |
| `IssueSessionLifecycle.deleteIssue` / `restoreIssue` — `issue-session-lifecycle.ts:196, 232` | `write`/`changes` are plan callbacks that only write; `apply`, `broadcastSessions` and `publish` follow the commit. |
| `ShippingService.claimDurableTrain`, `claimAttempt`, `transition`, `commitEffect…` — `shipping/service.ts:1799, 2320, 2350, 2470, 2861` | `write` is one repository call, `changes` is `projectionSpecs()`; the lease bookkeeping and every `audit(…)` are after. |
| `MessagesService` reply write — `messages/service.ts:1078` | span is `addMessage` plus `markAcked`; every `emitTransition` is after. |
| `SessionRepository.persist` — `sessions/repository.ts:337` | span is `additionalWrite()` plus `upsertSession`; `view.wire` is a pure projection. |
| `Replica` multi-region apply — `packages/sync/src/replica/replica.ts:559` | already registers through the span's own protocol: `span.onCommit(adoptBatched)`, with a comment stating the rule this issue is applying server-side. |
| `AutomationsService` (6 sites), `MemoryService` (2), `IssueCrud.purgeEmptyDraft`, the `funnel.run` writes in `attention.ts` (3), `mail.ts` (3), `session-meta-ops.ts` | span bodies are repository calls only. |

## C. Repository-internal spans — database only

All 43 `transaction(this.db, …)` bodies were read. Every one contains repository
statements, other methods of the same repository, and PURE functions —
canonicalisers, digests, parsers, comparators, `JSON.stringify`. Pure computation
is not a "non-database call" in the sense that matters here: it yields nothing,
touches nothing outside the process, and is unaffected by the flip.

Two things worth naming:

- **Diagnostic logging inside a span.** `store/observation-checkpoints.ts:60, 75`
  (`log.warn` from the quarantine path) is reached from four spans. Kept where it
  is, and this is a deliberate exemption rather than an oversight: logging is the
  observability seam (spec §6 rule 8), it must record the fact where the fact is
  observed, and deferring it past a rollback would lose exactly the diagnostic a
  corrupt row is being reported for. **This needs the coordinator's confirmation
  as a rule**, because a literal reading of B0.5's acceptance ("only database
  calls or calls through the mechanisms' API") forbids it.
- **The bridge does not cover these spans.** `runSynchronousSpan` wraps
  `SessionStore.transact`, the cross-aggregate seam, not `transaction(db, fn)` in
  `packages/runtime` — which the client adapters share and which cannot import
  the server's executor. A repository-internal span that is not itself inside a
  `SessionStore.transact` therefore has no post-commit scope, and `afterCommit`
  correctly runs the step at once. No repository-internal span reaches a
  mechanism today, so nothing is lost; at the flip the repositories bind to the
  executor and the question disappears.

## D. Classified as staying in the unit of work

| Site | Why it stays |
|---|---|
| `IssueService.sendMail`'s `addIssueMessage` | Mechanism 1 — a durable nested write, atomic with the lock grant or steal that caused it. Demoting it to a follow-up would let a grant land with no mail. Spec §3.3: durable mail is never reclassified as best-effort. |
| `Authority`'s baseline fold (`finalize`) | Mechanism 1. It is what `reconcile` diffs its next full-list pass against, so a fold that lagged its own append would make a second reconcile in the same span re-derive changes it had already emitted. Its divergence when the OUTER span rolls back is a real, separate defect: **POD-3328**. Note that spec §3.3 puts the fold in phase 3, so the target design already disagrees with where it sits today; POD-3328 is where that gets resolved. |
| `IssueAttentionModule.cascadeArchiveSessions` | Durable session writes plus in-process live-session state. That is POD-3259's category (mutable process-owned objects), not this one's, and splitting it here would pre-empt the model that issue chooses. |
| `SessionMetaOps.mutateSessionMeta`'s `write(session)` | Mutates the in-memory `Session` before the commit. Same boundary: POD-3259. |
| `LockService`'s `sweepExpired` → `advanceQueue` → `grantTo` | The lock row writes are the unit of work. Only the mail nudge inside them moved, and it moved at the mail choke point (row 2), which is why all SEVEN lock spans are fixed by one edit rather than the one the brief named. |

## E. `capture` and `reconcile` have no span at all

`Authority.capture` and `Authority.reconcile`
(`packages/sync/src/authority/authority.ts:236, 243`) stage, append and finalise
with no `transact` of their own — the brief names them, and the answer is that
there is no span body to classify. Their delivery goes through the same
`postCommit` port as `commit`'s, so when they are called from inside a caller's
span (`IssueStore.broadcastList` under the attach orchestrator) their subscribers
now wait for the outer commit too. Giving the appends themselves a span is
Stage B work: §3.4 makes every storage-backed Authority method async and the unit
of work becomes explicit there.

## F. What this ledger cannot prove, and what will

The acceptance sentence — *every span body in `apps/server/src` and
`packages/sync/src` has only database calls or calls through the mechanisms' API*
— is not checkable by reading, and this document should not be read as claiming
it. Two spans have a fan-out too deep to certify by hand:

- `IssueAttachOrchestrator.execute` (`application/issue-attach-orchestrator.ts:26`)
  wraps `attention.attachSession`, which reaches issue creation, dependency
  writes, coordinator assignment, draft cleanup and the full-list broadcast.
- `MaintenanceService.write` (`maintenance/service.ts:592`) wraps whichever job
  the command names, including the issue and session auto-archive services.

Every leaf this issue could DEMONSTRATE inside one of those spans is in section
A. What remains are conditionally-reachable fire-and-forget calls in the issues
service (`crud.ts:580, 1118`, `workflow.ts:458, 589`), each of which is
best-effort IO already, and each of which would be caught for certain by a lint
that can see a call inside a span body. That lint is the epic's own answer —
method §1 principle 1, "completeness comes from the compiler and a lint, never
from grep or memory" — and it is filed as **POD-3332**.

## G. Tests

| File | What it pins |
|---|---|
| `store/executor/synchronous-span.test.ts` | The bridge: registration is drained after COMMIT (probed by asking the engine whether a transaction is open, not by bookkeeping); a body that throws discards everything it registered; a nested span merges into its parent rather than draining, and discards on its own throw; mechanism order; the three failure contracts, including a follow-up failure being a `PostCommitError` with `committed: true` and a body failure being neither post-commit class; an asynchronous follow-up refused and an asynchronous effect allowed; a throwing report sink not becoming the transaction's error; a re-entrant commit ordered through the queue; and the SEAM — `SessionStore.transact` itself, because every other test in the file would pass with the production store never wired to the bridge. |
| `store/executor/span-side-effects.test.ts` | POD-3248's two harness shapes with the real `SessionStore`, `Ledger` and `Authority` wired as `relay.ts` wires them: subscriber-inside-notification (batch N reaches both subscribers before N+1, and both rows are durable) and follow-up-rejection (`committed: true`, and `maxChangeSeq()` proves the write is there). Plus the nested-commit rule from both arms — nothing delivered while the outer span is open, nothing delivered at all when it rolls back, and immediate delivery when the commit IS the transaction — and the same three arms for the event log's announcement. |

Mutation-checked rather than assumed. Replacing `finalize`'s post-commit branch
with a bare `this.broadcast(changes)` fails 2 tests; replacing `appendEvent`'s
`afterCommit` with a direct listener call fails 2; making a nested span drain its
own registry instead of merging fails 1 — and, correctly, only 1, because the
Authority registers its delivery after its inner `transact` has returned, when
the ambient scope is already the outer frame. All three restored byte-identical.
