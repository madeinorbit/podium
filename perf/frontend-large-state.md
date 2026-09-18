# Large-state frontend benchmark

POD-999 added a reproducible frontend scale lane after POD-991 removed Home and
made issue selection the primary startup/navigation path [spec:SP-0b2e].
POD-1004 aligns that lane with POD-1000's progressive Tasks renderer
[spec:SP-d562]. The fixture is generated and anonymous, with the Ludovico
cardinalities measured in POD-981/POD-991: 674 issues and 530 sessions, spread
deterministically over 12 repositories and 96 worktrees.

## Hermetic CI lane

Run from the repository root:

```sh
bun run test:perf:frontend
```

The lane runs under Bun/Vitest and happy-dom in one worker with no retries. It
gates deterministic signals rather than runner-dependent wall-clock values:

- Tasks keeps its initial board render to the 40-card-per-stage progressive
  boundary from POD-1000: exactly 200 of 674 cards, at or below 4,000 DOM
  elements and 225 buttons. The calibrated happy-dom signal is 3,700 elements
  and 214 buttons, so the lane fails closed if the pre-POD-1000 full render
  returns.
- Tasks initial property reads stay at or below 55,000; the calibrated signal is
  53,212. The lane reveals exactly one 40-card chunk, then proves full-order
  keyboard navigation can mount one initially hidden card in the next stage and
  open it with Enter (200 initial, 240 after reveal, 241 after navigation).
- Sidebar ownership resolves each session cwd once per derivation. The test
  deliberately runs both the direct ownership index and the complete sidebar,
  so the ceiling is two cwd reads per session; an issue × session regression is
  orders of magnitude over budget.
- The kernel facade reads exactly one durable record for a changed issue and
  performs no full durable scan. Untouched row identities remain stable.
- Real runtime scenarios emit A2 counts and timing distributions at three scales;
  the removed synthetic 81 ms trace is no longer presented as latency evidence.

Each case prints a `[large-state]` or `[large-state-kernel]` JSON record. Timing
is diagnostic; deterministic count ceilings decide pass/fail.

When intentionally changing the Tasks representation or a derivation contract,
compare the emitted signals before adjusting a budget. Do not raise a ceiling
just to absorb unexplained drift.

## Measure live Ludovico data

The read-only Playwright driver collects real-browser Tasks DOM/buttons,
input-filtered CLS, Long Tasks, sidebar issue-click durations,
`__podiumSwitchTraces`, and the server `perf.snapshot`. Its CLS total excludes
every layout-shift entry whose `hadRecentInput` flag is true, so shifts caused
by recent user input are not interpreted as page-instability CLS. The driver
does not create or mutate issues or sessions.

Run it against the live Ludovico instance from a checkout with Playwright's
Chromium installed:

```sh
BENCH_URL=https://podium-host.example.com:55555 \
BENCH_SWITCHES=12 BENCH_ROWS=2 BENCH_DWELL=1500 \
BENCH_STORAGE_STATE=/path/to/playwright-storage-state.json \
BENCH_OUT=/tmp/ludovico-large-state.json \
bun tests/e2e/large-state-bench.ts
```

Keep `BENCH_ROWS` at or below the desktop warm-panel cap (3; mobile 2) to measure warm
issue navigation. Raise it deliberately for cold-churn measurements. The page
can reuse an authenticated Playwright context through the optional
`BENCH_STORAGE_STATE`; the in-page snapshot fetch reuses the browser session.

For comparable runs, use a production web build, the same 1600×1000 viewport,
the same row/switch/dwell values, and three fresh browser runs. Report the
median/range for Tasks elements/buttons, input-filtered CLS, maximum Long Task,
click p50/p90, and completed switch-trace totals. Inspect `snapshot.result.data.phases` for
replica/broadcast work and retain the raw JSON beside the report.

The live measurements are signals, not CI gates: browser scheduling, terminal
mount state, host load, and the live dataset all move wall-clock values. CI
protects algorithmic and DOM-scale regressions; this driver explains their
real-user cost on Ludovico.

## A3 kernel acceptance contract (2026-09-18)

The authoritative fixture is now `kernel-scenarios.frontend-perf.tsx`, using the
shipped `createKernelReplica` facade, runtime, published worklist, selectors,
`UnifiedIssueRow`, and `StoreStatsProfiler`. Its durable cache is an in-memory
`KernelCacheRead` with stable row identities, as in scoped-session-render. Disk,
HTTP, terminal painting and socket latency are excluded. The legacy wire-v1
snapshot method must throw; the lane must never construct the retired replica.

Profiles (issues / sessions / repositories / child worktrees): CI
674 / 530 / 12 / 96; live 4867 / 4304 / 500 / 468; growth
9734 / 8608 / 1000 / 936. Growth changes the unrelated corpus, keeping the two
visible issue rows i0/i1, composer s0 and changed background session s2 fixed.
All rows, event order and wall-clock dates are generated deterministically.
Performance.now remains real for timing; timer advancement is explicit.

Each profile records five independent cold mounts and twenty samples per hot
scenario. Endpoints are render → settled React commit for cold start, and event
entry → settled React commit for hot interactions. These include instrumentation
and happy-dom overhead; they are not browser input-to-paint measurements.
The output identifies hostname, CPU and Bun for hot distributions. Nearest-rank
p50/p95 are diagnostics, never single-sample timing gates.

### Frozen endpoints and acceptance targets

This table supersedes the planning table's idle-publication target. Publication
counts and their work are separate evidence. Current-baseline ceilings in the
harness are regression guards, not a claim that Phase C's targets already pass.

| Acceptance measure | Frozen target | Measurement endpoint |
| --- | --- | --- |
| Invisible idle work | 0 worklist derivations and 0 browser long tasks per 60 s | A2 `slices.worklist`; PerformanceObserver longtask entries in an idle capture, excluding startup |
| Unrelated session delta | 0 worklist derivations, 0 unrelated reader commits | Kernel committed row event → settled React; A2 worklist and addressed subtree Profiler |
| Navigation | 1 snapshot publish, 0 issue row builds per press | DOM `[data-issue-row]` click → settled React; A2 publishes/rowBuilds; optimistic/network work labelled separately |
| Host telemetry | 0 entity snapshot publishes, 0 worklist derivations | hub hostMetrics frame → host telemetry store notification and settled React |
| Draft A | ≤1 publish, 0 worklist derivations, 0 issue row builds | setSessionDraft(s0) → composer commit |
| Warm input → paint | p95 ≤100 ms | Browser switch start → chat:first-paint; only completed traces without panel:mount, with cold and timedOut reported separately |
| State/derivation CPU | p95 ≤8 ms | Event entry → synchronous runtime/derivation completion, separate from paint and async waits; controlled runner distribution |
| Pilot benefit, only Phase D+ | ≥50% p95 CPU reduction | Same event corpus and runner against recorded post-B tree |
| Startup / retained memory | ≤10% increase without approval | Independent cold navigation → interactable; retained heap after identical two-panel rotation and GC on same browser runner |

No browser timing, retained-memory, or long-task pass is inferred from happy-dom.
The nominated browser target remains Ludovico, production build, Chromium,
1600×1000; shared-host CI timing is informational. Timing acceptance needs paired
runs on that controlled target. Warm rotations use two stable issue IDs, within
the actual heavy residency budget (3 desktop / 2 mobile). Every browser trace is
classified cold, warm or timedOut; missing warm samples are missing evidence.

Disable/revert: revert the A3 commit to restore the previous lane. To diagnose a
new count failure, preserve its emitted report and compare the changed-key list
and named slice counts; do not widen a ceiling merely to restore green. The
kernel read guard fails on a full durable scan, the host/draft zero-work guards
fail if their snapshot/worklist fan-out is restored, and the existing scoped
render probe carries coarse-subscription controls alongside addressed readers.
