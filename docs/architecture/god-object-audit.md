# The god-object audit (POD-425 Phase 4 exit criterion)

**Instrument:** `scripts/audit-god-objects.ts` (`bun run audit:god-objects`)
**Test:** `scripts/audit-god-objects.test.ts` — runs in the unit lane
**Ledger:** `GOD_OBJECT_LEDGER`, in the instrument itself

## What the criterion says, and what this measures

The epic's rule is that module size is a **review signal with justified
exceptions**, not a hard limit. `docs/architecture/pod-355-boundary-ownership-review.md`
records steward at 1080 lines as "a review signal, not a defect"; the Phase 4
ledger accepts the 600-plus session-state module by name.

POD-425 refused candidate `6fc75d09` not because 28 modules were over the line
but because the answer to each was prose in six different documents, or nothing:
it recorded *"earlier child evidence only; no same-candidate audit result with
exit code."*

So an **audit item** is:

> a production module over the threshold that is either UNDECOMPOSED (no
> argument for its size) or UNEXPLAINED (an argument that is not checkable, is
> stale, or has silently stopped being true).

Population: `apps/server/src/**/*.ts`, excluding tests. Threshold: **600 physical
lines** — the same number and the same measure POD-425's screen used, so the
audit's population and the gate's screen are the same set with no reconciliation
step.

## Why every exception carries a predicate

A ledger of free prose passes forever, because prose cannot notice that the file
it describes has changed underneath it. Each `kind` therefore pairs a written
argument with a structural claim the audit re-derives from source on every run:

| kind | predicate |
| --- | --- |
| `type-declarations` | zero runtime exports |
| `declaration-table` | no exported class, no owned state, named table export present |
| `composition-root` | the single declared root, and the construction-order record reports 0 forward / 0 deferred / 0 late-binding |
| `documented` | code lines (blank + comment stripped) under the threshold |
| `operation-surface` | one exported class, ≤2 owned mutable fields, no method over 180 lines |
| `cohesive-owner` | one exported class, every owned mutable field named in the entry, ≤12 of them |
| `capability-composition` | no inheritance, every named capability actually imported |

The argument is still required and still human. The predicate is what stops the
argument from outliving its truth.

**Budgets are not a ratchet.** Each entry carries a physical-line budget set
15–25% above its reviewed size. A bound pinned to today's number would fire on
every ordinary additive change a neighbouring issue makes, and a gate that must
be re-baselined on every merge teaches everyone to re-baseline it without
reading it. The `kind` predicate catches a module *changing shape*; the budget
only catches growth large enough that the reviewer's model of the file is gone.
There is deliberately **no `--update` flag**: regenerating budgets from the tree
would launder growth into an accepted baseline.

## What this audit cannot see — read before quoting a green

A clean run means **"no module over the line is unexplained."** It does **not**
mean the decomposition is sound, and the gate must not read it that way.

This audit measures **one file at a time**. Every coupling defect — the class of
failure this epic exists to remove — is *between* files, and is therefore
structurally invisible to it. Three shapes, all real in this tree right now:

1. **A module owning async work that outlives its owner.** POD-1390 found that
   `SessionRegistry.dispose()` never touches `modules.memory`, so memory-owned
   work survives the close and a ranged daemon read resolves ~10 seconds *after*
   the SQLite handle is shut. No line count would ever surface that; the fix is
   one line. A short file with this defect is worse than a long file without it.
   It was found by distrusting a 300 ms observation window that **passed** —
   widening it to 14 s turned it red.
2. **Protected state shared by reference across a boundary.** `observationLeases`
   is a raw `Map` passed into both `SessionRepository` and
   `SessionDaemonLifecycle`; all three modules read *and* write it (POD-1396).
   Three files, each individually defensible, one shared mutable map between
   them. Splitting a god object while leaving that map shared would make this
   audit greener and the design worse.
3. **A split that only looks like one.** Two files reaching into each other's
   internals pass every predicate here, because each is measured alone.

So the honest reading of a green is narrow: nobody is carrying an unargued god
object. Acyclicity is `scripts/server-composition-graph.ts`; construction order
is `scripts/server-construction-order.ts`; **lifecycle ownership has no
instrument at all today** and is checked only by review. This audit is one of
four inputs to the criterion and the weakest of them — it proves an argument
*exists*, not that the argument describes a good design.

## What the predicates do not catch

Stated plainly so a pass is not read as more than it is.

`sessions/lifecycle.ts` owns only **3** mutable fields and would clear the state
bound comfortably. Its problem is that ninety-six methods across six
responsibilities hang off those three fields. **No structural bound in the
instrument detects that.** The written argument is what detects it, because
nobody can truthfully write "this module does one job" about it — which is why
it has no entry and the audit refuses it.

The predicates stop an accepted argument from rotting. They do not manufacture
one.

## Verdict at this candidate

27 production modules over 600 lines. **26 carry a reviewed exception whose
structural claim holds; 1 is an open item.**

| module | physical | code | status |
| --- | ---: | ---: | --- |
| `modules/sessions/lifecycle.ts` | 2700 | 1900 | **ITEM** — six responsibilities, 96 methods |
| `relay.ts` | 2026 | 1606 | composition-root |
| `modules/messages/service.ts` | 1797 | 1190 | cohesive-owner (POD-1397 — was an ITEM at 2595/1749, 18 owned state fields) |
| `migrations/schema.ts` | 1404 | 1056 | declaration-table |
| `modules/superagent/service.ts` | 1187 | 952 | cohesive-owner |
| `modules/issues/registry.ts` | 1157 | 818 | declaration-table (POD-1398 — was an ITEM at 1664/1188, "table + 2 classes in one file") |
| `modules/issues/service/workflow.ts` | 1152 | 906 | cohesive-owner |
| `steward.ts` | 1080 | 701 | cohesive-owner (POD-355) |
| `modules/superagent/tools.ts` | 969 | 857 | declaration-table |
| `modules/issues/service/core.ts` | 934 | 510 | cohesive-owner (the one store) |
| `modules/machines/rpc.ts` | 915 | 745 | operation-surface |
| `store/issues.ts` | 879 | 671 | operation-surface |
| `modules/issues/service/crud.ts` | 820 | 596 | operation-surface (POD-320) |
| `modules/messaging/service.ts` | 810 | 643 | cohesive-owner |
| `store/sessions.ts` | 779 | 617 | operation-surface |
| `modules/issues/service/reads.ts` | 738 | 626 | operation-surface (POD-320) |
| `modules/workflows/service.ts` | 724 | 504 | operation-surface |
| `modules/sessions/session.ts` | 716 | 507 | cohesive-owner |
| `modules/settings/service.ts` | 713 | 359 | operation-surface |
| `composition/reactions.ts` | 685 | 658 | declaration-table |
| `store/types.ts` | 672 | 375 | type-declarations |
| `server.ts` | 651 | 416 | operation-surface |
| `modules/sessions/command-plane.ts` | 649 | 321 | documented |
| `modules/automations/service.ts` | 648 | 537 | operation-surface |
| `modules/machines/service.ts` | 625 | 329 | cohesive-owner |
| `store/workflows.ts` | 622 | 564 | operation-surface |
| `modules/sessions/session-state/service.ts` | 621 | 495 | cohesive-owner (POD-393, named in the Phase 4 ledger) |

(`modules/sessions/handoff/coordinator.ts`, 616/421, was the fourth item. It
left the population entirely — POD-1399 decomposed it and the largest surviving
piece is 368 lines.)

The remaining item is tracked as a sub-issue of POD-1385, and the audit exits 1
while it is open. That is the correct state of the world rather than a number to
tune the predicates against: each of the four was examined and none of them had
an argument that was true. Three closed by decomposition rather than by
argument, which is the honest way to clear an item and, on this evidence, the
usual one.

`issues/registry.ts` is the one that has since closed, and it closed by
decomposition rather than by argument (POD-1398). It held three concerns — the
command table, the `IssueCommandCtx` every handler is handed, and the
`IssueCommandDispatcher` that runs one — and the seam was the dependency order
the code already had: context, then the table written against it, then the
dispatcher that needs both. Each is now its own module in that order
(`command-ctx.ts` 381, `registry.ts` 1157, `dispatcher.ts` 201), the table
imports the context as a TYPE only so it adds no runtime edge back, and nothing
imports the dispatcher back. Only then did the table qualify for a
`declaration-table` entry; the other two fell under the threshold entirely.

`messages/service.ts` closed by decomposition too, and it is the case that shows
what this audit's state bound is for. Its problem was named as eighteen owned
mutable fields, and four capabilities came out carrying their own: rendering and
the confirmation mode that follows from it (`render.ts`), containment brakes 1
and 2 (`brakes.ts`), delivery scheduling (`scheduler.ts`), and the pull path of
reads, replies and bounded waits (`mailbox.ts`). Four fields remain and the entry
names all four.

Two things about it are worth recording rather than leaving to the diff.

The first is a seam the issue brief got wrong, and the reason to re-derive a
proposed split from the code instead of taking it. The brief asked for a delivery
queue and a retry/sweep as separate owners. They cannot be, without sharing state
by reference: `triggerFailures` is incremented by every entry path, and
`deliveryStats().oldestJobAgeMs` is a minimum over the queue's `enqueuedAt`
values *and* `retryPassStartedAt`. The eleven fields are exactly the closure of
`MessageDeliveryStats`. Splitting them would have produced two files that pass
this audit separately while sharing one counter and one clock — shape 2 above,
made worse by a decomposition rather than removed by one. They are one owner with
three entry paths.

The second is that shape 1 above now has a witness in this module. `dispose()`
appeared in the messages tests only as cleanup; nothing asserted it stopped
anything, which was survivable while one object held every timer and is not once
three owners each arm their own. A test arms one timer in each owner, proves both
are armed, and requires `vi.getTimerCount()` to reach zero — a count rather than
a list, so it also fires for a timer a future owner adds without a disposer.
Dropping either delegation, or hollowing out the brake's own disposer, turns it
red. That is one module covered; the general instrument the "cannot see" section
asks for still does not exist.

`handoff/coordinator.ts` is the case worth naming, because it would have passed
a weaker instrument. At 421 code lines it satisfies the `documented` predicate
outright — and that would have been a technically-true entry papering over a
single 401-line method that is effectively the whole module. It was refused on
the argument, not the predicate.

It closed by decomposition (POD-1399), and the seam it closed along is worth
recording because it is not the one a line count suggests. The phases are not
equal slices of a sequence; they are graded by WHAT AN EXIT COSTS, which is the
property the choreography actually turns on:

| phase | file | refusing costs |
| --- | --- | --- |
| admission | `admission.ts` (115) | nothing — owns the single-flight registry |
| placement | `placement.ts` (181) | nothing — reads only; its port type has no write on it |
| pre-flight | `preflight.ts` (134) | one overlay — clone and base handshake, all reversible |
| transfer | `transfer.ts` (368) | an unwind, and past the authorized target claim, nothing: the target keeps the session |

`coordinator.ts` is what is left: 154 lines that sequence the four and hold no
state. The transfer is deliberately still one function — `targetClaimed`,
`sourceCommitted` and `winnerAuthorized` are the rollback's inputs, and
splitting the legs would distribute them across the split, recreating inside
the decomposition the coupling a decomposition exists to remove. Its 259
irreversible lines were MOVED byte-for-byte rather than reshaped, because the
region between the export and the import is pinned by ordering alone (POD-1409's
clause covers the source release specifically), and a net that cannot see a
reshape is a reason not to reshape.

## Watching it refuse

The probe (`--probe`, and unconditionally before every run) plants a fixture for
every check and requires it to fire on the violation and spare the clean one; an
instrument that cannot say YES is not evidence when it says NO. That is
fixture-level. Four **real-tree** mutations were also run at this candidate,
each reverted after:

| mutation | audit response |
| --- | --- |
| 3 owned mutable fields added to `store/issues.ts` | `exception-predicate-failed` — "holds 3 private mutable fields; 2 is the ceiling" |
| a runtime export added to `store/types.ts` | `exception-predicate-failed` — "now exports 1 runtime symbol" |
| `sessions/session.ts` truncated to 399 lines | `stale-ledger-entry` — the entry defends a file that no longer needs one |
| construction-order record edited to "Forward dependencies: 3" | `exception-predicate-failed` — the composition root loses its exception |
| the population glob broken (`apps/server/src` → `apps/server/srcTYPO`) | the test suite fails 2 of 19, and the CLI throws rather than reporting a clean tree |

That last one is the specific failure an auditor is most likely to die of — going
green forever the day somebody breaks its glob — so it is asserted rather than
assumed. It is caught by the stale-entry check without needing a rule of its
own: if the screen returns nothing, all 24 accepted entries are suddenly
defending files the audit cannot see, and each one reports.

The first attempt at the first mutation added only ONE field and the audit
correctly stayed silent (the ceiling is 2). Recorded because it is the reason to
run real-tree mutations at all: a fixture probe had already passed on synthetic
inputs, and only the real tree showed that a mutation had been too weak to
prove anything.

POD-1398 ran the `declaration-table` arms against its own file after the split,
for the same reason — a predicate that has only ever been seen passing is not
evidence. All three fired:

| mutation to `modules/issues/registry.ts` | audit response |
| --- | --- |
| `export class MutantProbe {}` appended | `exception-predicate-failed` — "exports 1 class(es) (MutantProbe)" |
| a non-exported class holding `private cache = new Map()` | `exception-predicate-failed` — "holds owned mutable state (cache)" |
| `issueRegistry` renamed to `issueRegistryRenamed` | `exception-predicate-failed` — "table export 'issueRegistry', which the module does not export" |
