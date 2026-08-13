# React UI performance epic — final review packet

This packet records the integrated work on the parent branch. It is deliberately
about user-visible cost and retained resources, not a list of implementation
commits.

## What shipped

| Area | Result |
| --- | --- |
| Session state | Session/draft subscriptions are entity-scoped, so activity in one session no longer invalidates every mounted panel. |
| Issue projection | Shared issue view models remove repeated per-consumer projections. |
| Startup | Cold web-only surfaces are lazy and browser entrypoints avoid pulling server-only code into the initial bundle. |
| Terminal residency | Warm panel policy plateaus at three heavy desktop panels (two narrow), instead of retaining eight. |
| Worklist / Flight Deck | Stable keyed row models, memoized task leaves, and a structural Motion layout revision keep unrelated updates from rebuilding or measuring every row. |
| Transcript links | File-link paths are updated incrementally through a stable read-only Set and capped at 4,096 recent paths; reset and cwd changes re-seed the provider. |
| Kanban / issue list | Drag publication is frame-bounded and large issue lists render a bounded window. |

## Evidence carried into the parent

- Warm-panel residency: 485 fewer panel DOM nodes, five fewer xterm/WebGL
  surfaces, and five fewer attaches/subscriptions after the policy change. The
  three-panel desktop policy plateaued; warm-switch p50 was 46.9 ms and p95
  85.1 ms (previously 49.1 ms / 116 ms). See `artifacts/POD-847/residency-evidence.md`.
- The bounded issue-list and Kanban lanes retain their focused regression and
  performance suites from the integrated child commits.
- The new row-reuse tests cover unrelated session updates, changed-row freshness,
  and order preservation. The path-index tests cover stable identity, reset,
  LRU refresh, and the retention cap.

## Validation notes

The final focused/performance/browser commands are recorded in the parent issue
state after they run. The Kanban boundary uses `PORT=18899`; the historical
default `8799` is shared by browser harnesses and is not an issue-specific port.

The earlier broad web run was stopped after unrelated pre-existing failures in
`agent-panel-draft-flush.test.tsx` and `handover-pane.test.tsx`; those failures
are kept as a note rather than relabeled as regressions from the residency work.

## Remaining review decision

The final gpt-5.6-sol high reviewer must report no unresolved blocker/high
finding. Once that review and the final validation gate are green, this branch
will be rebased onto current local `main` and left ready to merge.
