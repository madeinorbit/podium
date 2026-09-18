# Phase C gate — measurement in progress

No operator decision has been made. C2 and D1–D6 remain conditional.

## Comparison lock

Post-Phase-B comparison baseline: `c728e9c252c43110944934b8aedb63603695852d`,
branch `integrate/4286-frontend-perf`, measured from
`issue/4319-c1-phase-b-remeasure-and-gate-decision`. Includes B11 and B12.
Any later pilot must compare with this runtime, not A1; Phase B gains cannot be
credited to a reactive library. A3 uses deterministic CI/live/growth profiles;
A1 used a changing live corpus, with no frozen state snapshot in its archive.

A1 authority: [baseline](POD-4286-baseline.md). A3 authority:
[scenario definitions and frozen ceilings](../../perf/frontend-large-state.md).
Regression ceilings are distinct from acceptance goals: one unrelated-session
derivation meets the current ceiling but fails the zero-derivation target.

## Capture plan

Run the five-file frontend performance lane once with Bun 1.4.2 on Ludovico.
Record publication counts separately from wakes, selectors, derivations, row
builds and React commits. Preserve its armed negative-control result.

Recover A1 collectors before live capture: production Chromium 1600×1000,
hydration plus ten-second settle; connected idle, disconnected control and
ordinary activity windows around 65.8 seconds; six-row cold churn and separate
two-row, fourteen-switch rotation with 1500 ms dwell. Classify cold/warm/timedOut
using current data-issue-row identifiers; never label happy-dom commits paint.
Capture source-mapped worklist, lookup, React commit/layout, transcript and GC
buckets, with overlap explicit. Missing measurements stay missing, never zero.

Per-commit attribution must distinguish original controlled probes from this
rerun. B1 and B2 warm-navigation savings overlap; their reported counts must
not be added. B11 removes unchanged async folds but genuine queue-status
publications still wake generic subscribers.

## Rollback

This issue changes measurement documentation only. Remove the report to revert;
no runtime switch, deployed build or live server change is required.
