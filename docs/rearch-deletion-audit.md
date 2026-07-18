# Deletion audit — the anti-intermediate-state ratchet

The v3 rewrite is defined as much by what **disappears** as by what gets built. A
rewrite that only adds the new thing and leaves the old one standing is the worst
of both worlds: two mechanisms, two mental models, and a migration that is
"nearly done" forever.

This audit makes that failure mode a build failure. It encodes the proposal's §6
"what disappears" inventory as executable checks, counts what still exists, and
refuses to let the numbers go up.

- **Script**: [`scripts/rearch-audit.ts`](../scripts/rearch-audit.ts) (rules), [`scripts/rearch-audit.test.ts`](../scripts/rearch-audit.test.ts) (tests)
- **Baseline**: [`scripts/rearch-audit-baseline.json`](../scripts/rearch-audit-baseline.json) — committed counts
- **CI**: its own blocking step in the `lint` job (POD-297)

## Running it

```bash
bun run audit:rearch                     # the ratchet — what CI runs
bun run audit:rearch --sites             # every counted file:line
bun run audit:rearch --json              # machine-readable
bun run audit:rearch --update-baseline   # record the current counts
bun run audit:rearch --phase POD-309     # phase-close gate
```

## The ratchet

CI compares live counts against the committed baseline:

| Result | Exit | Meaning |
| --- | --- | --- |
| count **>** baseline | 1 | **Regression.** New code was routed through a mechanism the rewrite is deleting. Use the replacement seam. |
| count **<** baseline | 1 | **Unrecorded win.** Run `--update-baseline` and commit the file. |
| count **=** baseline | 0 | Pass. |

### Why a decrease also fails — a deliberate deviation from POD-297's AC

POD-297's acceptance criterion reads *"a PR may only keep counts equal or lower;
increase fails the build"*, which taken literally says a decrease should pass.
**It fails instead, on purpose** (approved on POD-279 — recorded here so the exit
gate does not flag it as a defect).

The rationale is convergence. A decrease that is not written to the baseline
leaves the baseline still authorising the old, higher count — so a later PR can
give the ground back with CI green, and *"must reach zero"* never converges. The
count policy is unchanged: lowering a count is always allowed. What fails is a
**stale artifact**, and the fix is one mechanical command. The baseline diff then
doubles as the per-phase before/after evidence the migration ledger (POD-298 §8)
records. This mirrors `bun run migration:manifest --check`: you may add
migrations, but the committed manifest must be exact.

The audit is a **blocking** CI step of its own, not part of `bun run lint` — the
lint step is `continue-on-error` while the biome backlog burns down, so a ratchet
folded into it would report green no matter what.

## The phase-close rule

> **A phase issue may not be closed while any of its mapped items count > 0.**

Every item names the phase issue that owns deleting it. Before closing a phase:

```bash
bun run audit:rearch --phase POD-309
```

Exit 0 means every item mapped to that phase is at zero and the phase is clear to
close. Exit 1 lists what is still standing, with file:line sites. Exit 2 means the
argument named no known phase — a typo fails closed rather than reporting "clear".

This is what makes the audit a *scheduler* rather than a report: a phase cannot
declare victory while its deletions are outstanding, so the intermediate state
cannot become permanent by attrition.

Grep audits are necessary, never sufficient (POD-298): a zero here means the
named shapes are gone, not that the phase's design intent was met. The exit gates
still own that judgment.

## What a count means

Each check declares its own `unit`, deliberately. Some items are a **fan-out**
whose size *is* the debt — `publishComputed` call sites, `mods()` reach-throughs
in `router.ts`. Others are **binary**: a type exists or it does not. A count of 1
on a binary item is not weaker evidence than 119 on a fan-out; both must reach 0.

Two items count **redundancy** rather than raw sites, because the thing that
disappears is a duplicate, not the capability:

- `send-turn-duplicate`: N procedures forwarding to `superagent.sendTurn` ⇒ N−1
  counted. One of them is the real entry point and stays.
- `state-dir-defs`: already 0 — a **regression guard** that keeps the second
  definition from coming back.

## Counting rules

- **Comments are stripped** before matching. A doc comment mentioning a deleted
  symbol must not pin its count above zero, and comment churn must not move a
  count. This is not a marginal correction: a third of the raw `publishComputed`
  hits are prose, and two thirds of the `__local__` ones (23 of 35).
- **String literals are kept**: `'__local__'` is itself a literal.
- **Tests are excluded.** They legitimately construct doubles of the shapes being
  retired.
- **Migrations and generated files are frozen.** A past migration is immutable
  history; no phase can delete a placeholder out of one.
- **Package barrels are not shims.** `packages/*/src/**/index.ts` re-exports a
  deliberate public API. Only *app-level* all-re-export files are tombstones.

## A detector that stops matching is not a deletion

This is the audit's own worst failure mode, and it is worth stating plainly
because the ratchet actively converts it into permanent damage: **a count that
falls because a regex broke looks exactly like a count that fell because someone
deleted the debt.** The script then prints *"counts went DOWN — nice, lock the
win in"*, the baseline records a deletion that never happened, and the phase can
close over live code.

So detectors must not key on things that move for unrelated reasons:

- **Not on formatting.** Anchors that need a construct on one line break when
  biome (lineWidth 100) wraps it — and the count silently drops. `reexport-shims`
  matches statements, not lines, for this reason.
- **Not on a helper's name when the debt is the underlying reach-through.**
  `mods(ctx)` is only sugar for `ctx.registry.modules`, so `router-triple-access`
  matches both; otherwise a codemod inlining the helper would "delete" 100+ sites
  while changing nothing.
- **Zero must be provable, not inferred.** Where a zero count could only mean the
  detector broke, say so: `send-turn-duplicate` throws if its anchor matches
  nothing rather than reporting 0.

`scripts/rearch-audit.test.ts` asserts every check still binds to a real anchor
in the live tree, which catches total drift. It cannot catch partial
under-counting — that is what the rules above are for.

## Registered transitional residue

Residue is code intentionally retained after its owning deletion slice reaches zero. It is
registered in REGISTERED_RESIDUE in scripts/rearch-audit.ts with exact production sites,
an owner, and an expiry; tests fail if a registered site silently moves. Registered residue
is excluded from the slice count, while the forbidden old-path detector remains at zero.

The Issues pilot retains one residue entry: the minimal IssueWire type, the session-free
legacy issue emit, the upstream hub-mirror consumer, and the membership-scan regression
counter. It is deleted when the forwarder retires (POD-309) or the hub speaks projections
(POD-827), whichever first. POD-827 blocks normalized-as-sole-feed on hub-node installs.

## Adding or changing a check

1. Add an `AuditCheck` to `CHECKS` in `scripts/rearch-audit.ts` with its `phase`
   and `unit`. Make the `unit` describe exactly what the detector counts — if the
   prose is broader than the regex, the gap is a false zero waiting to happen.
2. Add a test pinning the shape it must match **and one it must not**, plus one
   that the count survives reformatting.
3. `bun run audit:rearch --update-baseline` and commit the baseline.

The counts here were re-derived at the baseline commit, not carried over from the
proposal's prose — several had drifted (a second `IssueRow`, `HandoffManifest` as
a new session shape). Re-count; do not trust a number in a description.
