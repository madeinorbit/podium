# C2 changed-key routing: verdict — do not build (POD-4320)

**Verdict: do not implement explicit changed-key routing.** It cannot reach the
A3 budgets, and the reason is structural, not a matter of tuning.

The one sentence that justifies it: routing can only silence readers whose keys
did not change, but the readers that cost — the worklist slice and the issue
models — genuinely observe sessions, so every expensive publication keeps
notifying and re-deriving exactly as today.

## The ceiling: routing could ever touch ~185 ms per minute

A1's ordinary-activity window (65.5 s, live corpus 4,867 issues / 4,304
sessions) measured synchronous snapshot fan-out at 8,268 ms and worklist
derivation at 8,083 ms, with 70 long tasks totalling 38,367 ms. Derivation
happens inside fan-out, so fan-out minus derivation — about **185 ms per
window, ~1.5 ms per publish** — is every wake, selector run and bail-out check
put together. That 185 ms is the entire budget routing could ever touch.
Against it stand 8.08 s of derivation and 38.4 s of long tasks, which routing
leaves at 100% by construction (next section). Even with generous error bars
the win is two to three orders of magnitude short of any budget.

The publish mix shows why. Of 125 publications, 39 host-metric and 29
conversations frames caused zero derives; the 34 session-carrying publications
caused 34 derivations costing 5,181 ms, machine-only frames another 850 ms
(now guarded by B5), and the clock tick one 63 ms derive. Routing only skips
the cheap half of that mix. Host metrics already left the snapshot (B3), so
that class of wake is gone with or without routing.

## By construction: zero-derives-on-unrelated-session cannot hold

The budget requires an unrelated session delta to derive nothing. It will
always derive, because two derivations legitimately read sessions:

- The worklist slice declares sessions in its `sourceEqual` guard, and B5
  proved `lastActiveAt` material: heartbeats move it constantly, so
  session-carrying publications keep missing the guard and rebuilding the
  whole world. Skipping the worklist's notification would not save work; it
  would freeze the sidebar on stale rows.
- The legacy issue models read sessions transitively:
  `allIssueViewModels` derives membership and rollups over member sessions
  (`deriveIssueViews`), and the view cache invalidates on replica session
  changes. At top-level-key granularity all 30 `useReplicaIssues` sites must
  therefore declare `sessions` — declaring only `issues`/`issueProjections`
  would silently stale every member list on every session delta. This is the
  recursive-derived-dependency trap the fork rule warns about, found before
  any code was written.

A selector census of this worktree (215 `useStoreSelector` sites in prod
files) confirms the shape: 48 sites read `sessions`, plus the 30 issue-model
readers, 12 `useSession` readers and the worklist slice itself. All of them
must stay subscribed to the 34 expensive publications per window.

The controlled case proves the arithmetic. A3's unrelated-session scenario
(live profile, post-Phase-B) costs 1 publish, 5 wakes, 1 derive and about
**117 ms (p50) against the 8 ms budget**. With routing, wakes fall 5 to 2 —
the draft reader and the static selectors skip — while derives stay at 1,
commits stay at 1, and wall time stays at ~117 ms, because a ~140 ms
derivation dominates the event. Routing saves about a millisecond of a
117 ms event.

Evict and rescope need no special case: both mint new arrays, so their keys
are present in the changed set and dependents are notified. Static readers
(`trpc`, action functions, `uiState` handles) keep identity across publishes
and already bail out via `Object.is`; a principal switch is a new runtime
and therefore fresh subscriptions, so they can never go stale.

## What routing does buy (stated so the operator can judge it on its own)

The wake reduction is real, only small. Conversations-only publications (29
per window, zero derives) would skip nearly every legacy reader — only mobile
`SettingsScreen` reads `conversations` — and the ~80 trpc-only plus dozens of
actions-only selectors would go quiet on every publish. In a full tree that is
roughly half the callbacks on entity publications and nearly all of them on
conversations frames, calibrated by host-metric fan-out (39 frames cost
34 ms) at order **~100 ms per minute**: about 1% of derivation, about 0.3% of
long-task time. A genuine improvement that cannot reach any budget.

## Outcome

No implementation was built and none should be: the fork rule fires on both
clauses (routing does not touch the measured derivation cost, and correct key
declarations already demand recursive derived dependencies). The remaining
session-derive cost (~5.2 s per window) needs per-issue computed summaries or
explicit acceptance — a decision for the operator, not this issue. A negative
result delivered before the 215-site key audit is the cheap outcome; it saved
the days that audit and its freeze risk would have cost.

## Method and limits

No new measurements were taken. The verdict rests on existing A1/C1/A3 counts
plus code construction (slice guards, the sessions-through-replica
dependency, the static-identity bail-out), so it is load-independent. This
deliverable is docs-only: there is no revert path because nothing shipped.
