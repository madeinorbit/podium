# POD-418 — re-review of the server composition root

`scripts/audit-god-objects.ts` voids a ledger entry when the module outgrows its
budget: "re-review the module, then either decompose it or raise the budget
deliberately in a commit." `apps/server/src/relay.ts` reached 2501 physical lines
against a reviewed budget of 2300. This is that re-review.

**Outcome: decomposed, budget UNCHANGED at 2300.** The file is now 1704 lines.

| | before | after |
|---|---:|---:|
| `apps/server/src/relay.ts` | 2501 | 1704 |
| `apps/server/src/feed-visibility.ts` | — | 400 |
| `apps/server/src/modules/issues/relay-dispatch.ts` | — | 580 |
| budget | 2300 | 2300 |

Both new modules are under the 600-line review threshold, so neither needs a
ledger entry of its own.

## What the argument claims, and where it had stopped being true

The entry's claim is narrow and checkable: the root **decides nothing, it only
wires**. Its size is allowed to be the size of the system because every line is
one named construction, and splitting it into *sub-roots* would hide edges from
`scripts/server-construction-order.ts`, which proves the order topological by
walking this one constructor.

That claim was false in two places. Both were jobs that had accreted inside the
constructor, and neither participated in the construction order at all — they
made decisions *about services that were already built*.

### 1. The feed visibility policy (~300 lines) → `feed-visibility.ts`

Per-bootstrap read tracing, the bulk prefetch, the grant checks behind `mayRead`,
and the generation-keyed read cache the anchor port walks. It owned two pieces of
mutable state of its own (the trace stack and the read cache) and answered a
policy question — who may read which row — over store reads only.

Moved behind **`VisibilityStatePort`** and **`VisibilityAnchorPort`**, two ports
the sync kernel already declares. The root still constructs
`GrantEdgeVisibilityPolicy` and `Ledger`; those are services, and naming them is
its job.

### 2. The agent-relay dispatch arm (~420 lines) → `modules/issues/relay-dispatch.ts`

Router/proc routing, hand-rolled validation for the two inputs that have no
contract (`offer.set`, `sessions.title`), the scope gates that `relay-gate.ts`
deliberately leaves to the arm, and the issue-prime tail.

Moved behind **`AgentRelayGateDeps.dispatch`** — a port that already existed, and
whose own doc comment already called its implementation "the dispatch arm in the
composition root". `sessionTitlePrime` and its `sessionLabel` helper went with
it; their only reader was the prime tail.

`SessionRegistry` now has a constructor, two getters, `dispose` and
`runStewardTick`. No domain methods.

## The gate that was broken, not merely stale

`scripts/server-construction-order.ts` was **throwing** on main, not reporting.
`forBootstrap` declared a local `const issues` for its prefetched rows; that name
collided with the `issues` service declared ~250 lines later; the audit matches
identifiers without scope analysis, so it read the local as a forward dependency
and refused to run.

The consequence is worth stating plainly, because it is the failure mode the
god-object audit exists to prevent. `audit-god-objects.ts` does not run the
generator — it greps the *committed document* for three zeros. So the record kept
reading green while it was months out of date and could not be regenerated at
all. An argument had outlived its truth behind a predicate that could not see it.

Moving the block out removed the shadowing rather than working around it. The
record now regenerates and the no-`--write` check passes:

> Verified constructor declarations: 55. Forward dependencies: 0. Deferred
> service closures: 0. Non-null late bindings: 0.

The generator also caught a genuine mistake in this work: passing the reassigned
`currentSettings` binding as `() => currentSettings` is a zero-arg thunk
returning a declaration, which is precisely its deferred-service-closure rule.
Handing the resolved `featureStates()` over instead satisfies it honestly rather
than dodging it.

## Why the budget did not move

Re-pinning to 1704 would fire on the next additive arm a neighbouring issue lands
here, and a bound that must be re-baselined on every merge teaches everyone to
re-baseline it without reading the argument beside it — at which point the number
is noise and the prose stops being read too. The `kind` predicate is what catches
the file changing *shape*; the budget only catches growth so large the reviewer's
model of the file is gone. The ~600-line gap is the intended slack.

Same shape as the precedents: POD-1606 and POD-417 on `issues/service/workflow.ts`,
POD-1467 and POD-1505 on `modules/machines/service.ts`.

## Verification

- `bun run typecheck` — green.
- `bun run --cwd apps/server test` — 286 files, 4088 tests pass, 1 skipped.
- `bun run audit:composition` — all three records current; graph acyclic (222
  modules, 0 cycles).
- `bun run audit:god-objects` — no longer reports `relay.ts`.
- `scripts/audit-god-objects.test.ts`, `scripts/server-construction-order.test.ts` — pass.

Both moves are verbatim. `diff -w` of the extracted dispatch arm against the
original reports 22 changed lines, all of them the seven dependency substitutions
and one reworded comment. No behaviour changed, so no tests were added.

## Filed, not fixed

- **POD-440** — `packages/runtime` session-mint tripwire fails on main
  (`client_sessions` gained `userId` while the mint is FS-only). Aborts
  `bun run test` before later packages run.
- **POD-442** — `bun run audit:composition` is red on main and nothing executes
  it, which is how two of its three records rotted. Regenerating them here
  necessarily absorbed ~9 modules of unrelated drift into this commit.
- **POD-443** — `modules/sessions/lifecycle.ts` is an unanswered god object at
  615 lines. The audit test filters `unexplained-god-object` out of its
  assertion, so only a raw run surfaces it.

## What this review does not claim

The same thing `audit-god-objects.ts` says about every green it prints: this
measured one file at a time. Two modules reaching into each other's internals
pass every predicate here, because each is measured alone. What is established is
that the root's argument is true again and machine-checkable — not that the
decomposition around it is sound.
