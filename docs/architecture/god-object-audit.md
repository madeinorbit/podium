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

28 production modules over 600 lines. **24 carry a reviewed exception whose
structural claim holds; 4 are open items.**

| module | physical | code | status |
| --- | ---: | ---: | --- |
| `modules/sessions/lifecycle.ts` | 2955 | 2081 | **ITEM** — six responsibilities, 96 methods |
| `modules/messages/service.ts` | 2595 | 1749 | **ITEM** — 18 owned state fields |
| `relay.ts` | 2026 | 1606 | composition-root |
| `modules/issues/registry.ts` | 1664 | 1188 | **ITEM** — table + 2 classes in one file |
| `migrations/schema.ts` | 1404 | 1056 | declaration-table |
| `modules/superagent/service.ts` | 1187 | 952 | cohesive-owner |
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
| `modules/sessions/handoff/coordinator.ts` | 616 | 421 | **ITEM** — one private method spans 401 of its 421 code lines |

The four items are tracked as sub-issues of POD-1385. The audit exits 1 while
they are open. That is the correct state of the world rather than a number to
tune the predicates against: each of the four was examined and none of them has
an argument that is true.

`handoff/coordinator.ts` is the case worth naming, because it would have passed
a weaker instrument. At 421 code lines it satisfies the `documented` predicate
outright — and that would have been a technically-true entry papering over a
single 401-line method that is effectively the whole module. It was refused on
the argument, not the predicate.

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

The first attempt at the first mutation added only ONE field and the audit
correctly stayed silent (the ceiling is 2). Recorded because it is the reason to
run real-tree mutations at all: a fixture probe had already passed on synthetic
inputs, and only the real tree showed that a mutation had been too weak to
prove anything.
