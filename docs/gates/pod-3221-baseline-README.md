# POD-3221 hot-path baselines

These two files are the epic's measurement baseline, and they live IN THE REPO rather than only as
issue artifacts so the gate is reproducible by anyone at any commit:

    bun --conditions=@podium/source scripts/measure-hot-paths.ts --suite queries \
      --baseline docs/gates/pod-3221-baseline-queries.json
    bun --conditions=@podium/source scripts/measure-hot-paths.ts --suite frames \
      --baseline docs/gates/pod-3221-baseline-frames.json

`--conditions=@podium/source` is required: a fresh worktree has no built dist.

## Values, re-taken at the epic tip 73cb5ed5f on 2026-09-04

    feedBootstrap.queriesPerRequest     44   (control 1 bootstrap frame)
    issueFrameReads.queriesPerRequest  253   (control 80 issue rows)
    bootReconcile.framesPerBurst         1   (control 60 changes)
    bindStorm.framesPerBurst             2   (control 50 changes)

## Why they were re-taken

POD-3243 measured `issueFrameReads` at **371** on its own commit, 37829e864. At the tip it is **253**.
POD-3407 found the gap and named it; this coordinator re-measured independently and got the same 253,
with `feedBootstrap` identical at 44 at both ends.

The 118 is a REAL IMPROVEMENT, not instrument drift — POD-3257 / POD-3261's batching landed after the
baseline was taken, and the breakdown shows it directly: three hoisted list reads now run once each
(`... FROM issue_labels ORDER BY issue_id`, `... FROM issue_deps ORDER BY from_id`,
`COUNT(*) ... GROUP BY issue_id`) in place of per-row reads, taking labels 80→50, deps-from 160→100
and deps-to 80→50.

**The danger was the direction.** The gate's budget is "no increase", so a stale HIGH baseline passes
a regression silently: against 371, an issue frame could have regressed by 118 queries — roughly 0.4-0.6 s
of added latency at same-metro 3-5 ms per round trip — and the gate would have said "budget held".
A stale baseline is only safe when it is stale in the direction that makes the gate stricter.

## Verified when written

    gate against these baselines          exit 0, "hot-path budget held"
    baseline with issueFrameReads 252     exit 1, "252 → 253 — increased"
    frames baseline                       exit 0

The second is the defeat test: a gate that cannot say no is not a gate.

## Re-take them when a batching change lands deliberately

Re-taking is correct after an intentional improvement and WRONG as a way to make a red gate green.
Record which commit and which named change moved the number, as this file does.
