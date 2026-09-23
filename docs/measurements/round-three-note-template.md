# Round-three wall note template (POD-4562)

Copy this for every round-three note that publishes browser walls: the
per-event walls at live corpus (round two's "M2" notes, round three's b4) and
the growth walls at 1x/2x/4x (round two's "M3" notes, round three's c4). The
rules are in `docs/plans/pod-4441-harness.md`, "Complete or fail" and
"Budgets = no-op floor + allowance, per scale".

**There is no withheld, provisional or partial cell.** If `summarize.ts`
exits 2 (a missing or short cell, a record above load 8, two machines, two
targets), the run FAILED: there is no note, only a rerun. Counts that do not
depend on load are reported on their own; they never stand in for a wall.

---

# POD-XXXX — <arm> walls, <what> (<date>)

**As of** `<runtime SHA>` on `<branch>`; host `<flatblock>`, Chromium
`<version>`; production build of `harness/web/dist` at that SHA.

**Matrix.** `bun packages/worklist-proto/harness/browser/matrix.ts --host <host>
--arms noop,<arms> --scales 1,2,4 --rounds <R> --samples <S> --tag <tag>`;
plan `results/<tag>/matrix-plan.json`: <R> rounds × <S> samples = n <R×S> per
cell (at least 20). Load per record: <min>–<max> (all ≤ 8). Failed attempts
the matrix retried: <list of `.tryN.failed.json`, or none>.

**Summary.** `bun packages/worklist-proto/harness/browser/summarize.ts
results/<tag>` exited 0. Paste both tables verbatim, unedited:

| Arm | Scenario | Scale | n | actionMs p50 / p95 / max | drainMs p50 | frameMs p50 | commits (median) | long tasks | stray | floor p95 | budget p95 | verdict | max load |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

| Arm | Scenario | p50 1x / 2x / 4x | raw p50 4x/1x | excess over floor 4x/1x (budget ≤ 1.2) |
|---|---|---|---|---|

**Verdicts.** One line per budget: within or OVER, with the number and the
budget it was held to. No budget is re-read on another dimension.

**Attachments.** The `results/<tag>/` directory (JSON per run, the plan, any
`.failed.json`) as issue artifacts; `results/` is gitignored.
