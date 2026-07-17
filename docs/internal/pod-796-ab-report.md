# POD-796 — the issues wire cutover, measured

**Date:** 2026-07-17 · **Branch:** `issue/790-issues-vertical-on-new-architecture`, rebased onto main
**Scale:** 793 issues × 588 sessions — the live instance's real size, read from a read-only copy of `~/.podium`
**Baseline:** the **real post-POD-722/723/724/725 pipeline**, present after the rebase. Not the pre-fix one.

---

## The headline, in one line

A one-field session change costs **81.7ms p50** of issue-wire work on the old path and **nothing at all** on
the new one — the phase does not execute.

| | `sessionsBroadcast.publishIssues` | membership scans (D7.2's unit) |
|---|---|---|
| **Old path** (flag off, post-722/723) | count 20 · **p50 81.7ms** · p90 100.9ms · max 127.2ms | **15,860** = 793 × 20, each filtering all 588 sessions |
| **New path** (flag on + cap client) | **count 0 — the phase never runs** | **0** |
| | `publishIssuesSkipped` p50 **0.71ms** (the predicate check) | |

Trigger: `setWorkState`, 20 rounds. Phase timers are POD-701's own, consumed under the
`packages/protocol/src/perf.ts` STABILITY contract — **nothing renamed** (see below).

---

## The honest qualifier: this does NOT move chat-switch latency

It would be easy to present this as "another 81.7ms off the switch". It is not, and the pilot's framing
needs correcting:

- A chat switch is attach/detach, i.e. `clientCount` / `controllerId`.
- POD-722's denylist is exactly `['clientCount', 'controllerId', 'epoch']`, and its own test is titled
  *"an attach-then-detach fans out sessionsChanged but NOT issuesChanged"*.
- **So post-722 a switch already performs zero issue work.** POD-796 cannot improve it further, and
  POD-736's switch-latency gate should be expected to show ~no delta from this change.

What POD-796 removes is the **agent-activity** cost, which POD-722 never touched: every `workState`,
`phase`, `title` and `lastActiveAt` change — and `lastActiveAt` ticks on *every* agent activity across 588
sessions — pays the full 81.7ms p50 rebuild on the old path. That is a continuous background cost
proportional to how busy the instance is, and it goes to zero.

POD-722 is a **partial** fix: 3 fields of pure connection churn.
The normalization is **total**: every session field, because `toWire(issue)` has no session parameter to read.

---

## Why "scans", not "builds" — the measurement that would have lied

The original instrument counted `toWire` calls. Post-rebase it reads **1**, not 300, and that number makes
POD-723 look almost compliant. It is not:

`toWireMemo` memoizes the expensive per-issue *body*, but it still calls `sessionsForIssue(...)` for **every**
issue to compute its cache key — a filter across the whole session list. The O(issues × sessions) scan
ADR 4 D7.2 forbids survives the memo completely; it just stops being visible to a counter that increments
inside `toWire`.

D7.2 forbids **work proportional to entity count**, not serializations. Measuring serializations lets a shim
that still scans the world pass for compliant. Hence the scan counter, which counts what the ADR actually
forbids. This is precisely what the ADR means by *"Interim dirty-set shims (POD-722/723) are scar tissue on
the pipeline POD-308 deletes, not compliance."*

Both numbers are kept side by side so the divergence stays visible: **builds is the cost per dirty issue,
scans is the complexity class.**

---

## Why there is no browser p50/p90 A/B

`tests/e2e/switch-bench.ts` is the right instrument for POD-736's gate, and running it today would produce a
confidently wrong **zero**.

The bypass engages only when every connected delta client offers `CAP_ISSUES_NORMALIZED`. `apps/web`
deliberately does not: the cap promises *"I no longer need IssueWire"*, and the web replica's issue views
still read it, because `IssueProjection` carries no `deps`/`prefix` and nothing replica-side supplies them
(**POD-822**). A browser A/B would run its flag-ON arm with a non-cap client, never engage the bypass, and
measure flag-ON == flag-OFF.

**The browser A/B is blocked on POD-822, not on the harness.** It becomes meaningful the moment the client
can honestly offer the cap.

---

## Metric-name migration story (POD-736's ask)

**There is no rename.** The cutover does not re-point `sessionsBroadcast.*` at a new pipeline. It makes the
existing `sessionsBroadcast.publishIssues` phase **stop executing**, and the existing
`sessionsBroadcast.publishIssuesSkipped` phase fire in its place. Both keep their POD-701 meaning, so the
recorded baselines stay comparable and the gate reads the same keys before and after.
(`publishIssuesSkipped` is itself a post-baseline addition under the same contract — POD-701's own
accounting note says so.)

---

## Reproduce

```bash
bun --bun vitest run apps/server/src/issues.normalized-wire.bench.test.ts --reporter=verbose
```

The D7.2 proof and its interlocks: `apps/server/src/issues.normalized-wire.test.ts`.
Every load-bearing guard is mutation-tested; the flag-OFF control exists so a 0 there exposes a vacuous test
rather than passing quietly — which is exactly what it did when the pre-rebase `clientCount` trigger was
eaten by POD-722.
