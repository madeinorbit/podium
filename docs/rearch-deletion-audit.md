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

A decrease failing the build is deliberate, and it is not the ratchet fighting
you — it is the ratchet *keeping* your win. If a win is not written to the
baseline, the baseline still authorises the old, higher count, and a later PR can
give the ground back with CI green. The fix is one mechanical command, and the
baseline diff doubles as the per-phase before/after evidence the migration ledger
(POD-298) records. This mirrors `bun run migration:manifest --check`: the
committed artifact must be exact.

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

## Adding or changing a check

1. Add an `AuditCheck` to `CHECKS` in `scripts/rearch-audit.ts` with its `phase`
   and `unit`.
2. Add a test pinning the shape it must match **and one it must not** — a
   detector that quietly stops matching reads as "deleted!" and would let a phase
   close on a false zero. `scripts/rearch-audit.test.ts` asserts every check
   still binds to a real anchor in the live tree for exactly this reason.
3. `bun run audit:rearch --update-baseline` and commit the baseline.

The counts here were re-derived at the baseline commit, not carried over from the
proposal's prose — several had drifted (a second `IssueRow`, `HandoffManifest` as
a new session shape). Re-count; do not trust a number in a description.
