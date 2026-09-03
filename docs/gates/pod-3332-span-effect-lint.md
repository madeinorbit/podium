# The span-effect lint (POD-3332)

`scripts/check-span-effects.ts` over `scripts/span-effect-graph.ts`, with fixtures in
`scripts/check-span-effects.test.ts`. It runs as `bun run lint:span-effects` — its own
blocking CI step (`.github/workflows/ci.yml`), never the `continue-on-error` `bun run lint`
bundle. POD-744 is why that distinction is load-bearing.

## The rule it encodes

Spec §6 rule 19, and **it is not "no non-database call inside a span"**. The line is
OBSERVABILITY, not kind:

> If the transaction rolled back, would anything outside this process be wrong for having
> seen this?

A `log.warn` recording that a corrupt column was quarantined: **no**, and it stays where it
is — deferring it past a rollback would lose exactly the diagnostic a corrupt row is being
reported for. The store's quarantine warnings are the live example, and a fixture pins that
this lint does not flag them.

An event published to subscribers, a mail nudge, a git round trip, a directory the
filesystem now lacks: **yes**, and it moves to one of spec §3.3's post-commit mechanisms.

A rule that flagged every call would be turned off within a week. A rule that flags
observable effects is worth having, and that is the one this is.

## Why it exists

POD-3260 classified every span in `apps/server/src` and `packages/sync/src` by hand and did
not claim what it could not show. Its ledger §F says the acceptance sentence is *not
checkable by reading*, and names two spans whose fan-out is too deep to certify:
`IssueAttachOrchestrator.execute` and `MaintenanceService.write`. Four
conditionally-reachable fire-and-forget calls in the issues service were left unsettled
because no one could demonstrate whether a span reaches them.

This is the epic's own first principle — *completeness comes from the compiler and a lint,
never from grep or memory* (execution method §1) — applied to the one B-prep category that
had no compiler check.

## How it works, in three passes

1. **Index.** Every function-like node in the walked scope becomes a graph node carrying its
   call edges and its direct capability hits. A nested function is folded into the body that
   creates it — conservative on purpose. The ONE exception is the argument subtree of
   `afterCommit`, `postCommit`, the registry's `effect`/`followUp`/`commitApplication` and
   the replica's `SyncSpan.onCommit`: that is code which has already been moved out of the
   transaction, so it is not walked at all.
2. **Propagate.** Capability sets flow along reversed call edges to a fixpoint, so a cycle
   converges instead of recursing and one union is shared by every span that reaches it.
   Each capability keeps the edge it arrived on, so a finding prints its whole call path.
3. **Roots.** Every call whose resolved callee is a declared span opener contributes its body
   callback as a root. A root reaching an `observable` capability is a finding.

**Every callee is resolved with `checker.getResolvedSignature(...).declaration`.** Nothing
matches on a name. That is not a style preference: the execution method records POD-3257's
proof, found by a worker on its own work, that a name-matching scan LOSES a site the moment
the call goes through a local `const` or a closure, and FLOODS on `Map.get`. Both halves are
fixture-pinned here — a call through `feed.announce.bind(feed)` behind two closures is
followed; a body full of `Map`, array and `JSON` work produces zero capabilities of any kind.

## What fails it

| Failure | What it means |
|---|---|
| `NEW observable effect inside a span` | A span body can reach an observable effect that is not on `ACCEPTED`. Move it behind `afterCommit`, or classify the callee with the sentence that says why a rollback leaves nothing outside this process wrong. |
| `UNCLASSIFIED port member` | A port member nobody has judged. Not a warning: an unclassified port is a rule that has quietly stopped covering something. One line in `PORT_CAPABILITIES` fixes it. |
| `SLACK in the accepted list` | An `ACCEPTED` line no finding matches any more — the site was fixed. Delete the line. This is what makes the list shrink and stops it rotting into an allowlist. |
| `DEAD span opener` | `SPAN_OPENERS` names a declaration nothing resolves to. Either it was renamed, in which case this lint has been scanning fewer spans than it claims, or it is gone. |
| `UNNAMED transaction opener` | A `transact`/`transaction` declaration in neither `SPAN_OPENERS` nor `NOT_A_SPAN_OPENER`. Say which it is. |

The last three are the anti-rot checks, and they are the reason this is a gate rather than a
report. A lint whose own tables can go quiet is a lint that reports green for the wrong
reason — the failure mode POD-3257 and the shard-manifest rule in the execution method both
describe.

## `ACCEPTED` — the ledger, and why it is not an allowlist

Eight findings stand on the tree this was written against, and every one of them is on the
single span POD-3260 said could not be certified by hand:
`IssueAttachOrchestrator.execute`. Each carries the sentence that says why it stands. Like
POD-3252's `STAGE_A_UNCONVERTED`, it excuses no construct and hides no class of defect: it
records what the lint FOUND, so the rule can gate on a tree it was written against instead
of being red from the day it lands. An entry that stops matching fails.

Run `bun run lint:span-effects --report` for the full picture, and `--json` for the paths.

## What it deliberately cannot see

Stated here rather than discovered later. All four are counted and printed by `--report`;
none is silently passed.

- **A port is a leaf when no class satisfies its interface.** A call through an interface
  resolves to the port's member, not to whichever implementation the composition root
  injected. Where a class in the scanned scope is assignable to the whole port interface, the
  lint follows into it — that is how the attach span reaches `IssueAttentionModule` and
  `IssueCrudModule` at all. Where the port is a WIDE deps interface satisfied by an object
  literal the composition root assembles (`IssueDeps`, `LockServiceDeps`), no class is
  assignable and the member is answered by hand in `PORT_CAPABILITIES`, with its reason.

  Member-by-member matching was tried, and it is recorded here because it looks like the
  obvious improvement: matching a port member against every same-named, signature-assignable
  class method FLOODS. `run`, `get`, `send` and `handler` are everywhere, the graph joins
  into one component, and 95 span bodies each reach 72 capabilities — a result nobody can
  act on. Whole interfaces are specific enough to mean something.

- **Two classifications are asserted rather than seen**, and they are the two POD-3260 fixed
  at a choke point: `LockServiceDeps.sendMail` and `LockServiceDeps.appendEvent`. Both are
  `contained` because the effect they used to carry moved INSIDE the implementation — the
  mail nudge and the feed announcement are both behind `afterCommit` now (ledger §A rows 1
  and 2), and what is left at the port is a durable write belonging to the unit of work.
  The mechanism is not taken purely on trust: both implementations are also reached body and
  all from repository spans that do not go through a deps port, so deleting either
  `afterCommit` turns the deferred call back into a direct hit and this lint fires. It is only
  THROUGH these two wide interfaces that the answer is asserted.

- **A span body handed in as a value is not followed.** `MaintenanceService.write` does
  `this.store.transact(operation)`, where `operation` is whichever job the command named.
  The span is counted, its body is not analysed, and the report says so. This is the second
  of POD-3260 §F's two deep spans, and it is the one this lint does NOT settle. Settling it
  needs the jobs enumerated at their own call sites, which is `MaintenanceService`'s own
  work, not this rule's.

- **An `any`-typed port defeats a type-checker rule exactly as a closure defeats a scan.**
  403 calls in the scanned tree have no resolvable signature; 8 of them are reachable from a
  span body, all in `apps/server/src/modules/issue-session-lifecycle.ts`, through the
  `SessionAuthzPorts` interface whose seven members are declared `any`. The report prints
  this per file, worst first, so the blindness is locatable rather than notional.

Two more properties worth naming because they are choices, not oversights:

- **Reachability, not execution.** An edge is a call the body COULD make. A branch that never
  runs in practice still counts. The rule is over-approximate in that direction deliberately:
  a span body that can reach an observable effect is one somebody will eventually drive
  into it.
- **Timers are POD-3258's ledger, not this one's**, and in-process live-session state is
  POD-3259's (ledger §D). Both are classified `exempt` here with that reason, so this rule
  does not pre-empt a model another issue is choosing.

## After the flip

The `runSynchronousSpan` bridge is an instrument and its deletion is POD-3327. When it goes,
`SPAN_OPENERS` loses two entries (`runSynchronousSpan`, `transaction(db, fn)`) and gains the
executor's own `transact` — which `NOT_A_SPAN_OPENER` already names, with that sentence, so
the change is one table edit rather than a rediscovery. The `DEAD span opener` check is what
makes the edit impossible to forget.
