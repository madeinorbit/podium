# POD-3221 hot-path baselines

These two files are the epic's measurement baseline, and they live IN THE REPO rather than only as
issue artifacts so the gate is reproducible by anyone at any commit:

    bun --conditions=@podium/source scripts/measure-hot-paths.ts --suite queries \
      --baseline docs/gates/pod-3221-baseline-queries.json
    bun --conditions=@podium/source scripts/measure-hot-paths.ts --suite frames \
      --baseline docs/gates/pod-3221-baseline-frames.json

`--conditions=@podium/source` is required: a fresh worktree has no built dist.

## Values, re-taken at 3b1cba83e on 2026-09-08

    feedBootstrap.queriesPerRequest     10   (control 1 bootstrap frame)
    issueFrameReads.queriesPerRequest  253   (control 80 issue rows)
    bootReconcile.framesPerBurst         1   (control 60 changes)
    bindStorm.framesPerBurst             2   (control 50 changes)

`issueFrameReads` is unchanged from the 2026-09-04 re-take at 73cb5ed5f. Only
`feedBootstrap` moved.

## Why feedBootstrap was re-taken (44 → 10)

The 44 was taken when `serveWorld` still ran inline on `attach` / `hello`. POD-3523
deferred that admission, and the queries suite kept counting on the same turn as
`attachClient`, so it recorded 0 while the control — taken after `settle()` — still
saw the bootstrap frame. POD-3734 waits on `admissionSettled` before scoring. The
two numbers measure the same work: the window now covers the deferred admission
rather than closing before it runs.

Against that window the live count is **10**, not 44. That is a REAL IMPROVEMENT,
not instrument drift. The breakdown shows it directly:

    27 per-id `machines WHERE id = ?` lookups          gone
     9 per-id `grants` reads                           2 `listForResources` IN reads
                                                       (POD-3261 prefetch covering the pass)
     1 `feed_identity` SELECT                          gone (INSERT remains)
     1 `MIN(seq) FROM changes`                         2

**The danger was the direction.** The gate's budget is "no increase", so a stale HIGH
baseline passes a regression silently: against 44, a feed bootstrap could have
regressed by 34 queries — 34 network round trips on Turso, about 15 s at the
measured 453 ms — and the gate would have said "budget held". A stale baseline is
only safe when it is stale in the direction that makes the gate stricter.

## Why issueFrameReads was re-taken earlier (371 → 253)

POD-3243 measured `issueFrameReads` at **371** on its own commit, 37829e864. At the
73cb5ed5f tip it is **253**. POD-3407 found the gap and named it; the coordinator
re-measured independently and got the same 253, with `feedBootstrap` identical at 44
at both ends (that 44 is the number this file just replaced).

The 118 is a REAL IMPROVEMENT — POD-3257 / POD-3261's batching landed after the
baseline was taken, and the breakdown shows it directly: three hoisted list reads
now run once each (`... FROM issue_labels ORDER BY issue_id`, `... FROM issue_deps
ORDER BY from_id`, `COUNT(*) ... GROUP BY issue_id`) in place of per-row reads,
taking labels 80→50, deps-from 160→100 and deps-to 80→50.

## Verified when written

    gate against these baselines          exit 0, "hot-path budget held"
    baseline with feedBootstrap 9         exit 1, "9 → 10 — increased"
    frames baseline                       exit 0

The second is the defeat test: a gate that cannot say no is not a gate.

## Re-take them when a batching change lands deliberately

Re-taking is correct after an intentional improvement and WRONG as a way to make a red gate green.
Record which commit and which named change moved the number, as this file does.
