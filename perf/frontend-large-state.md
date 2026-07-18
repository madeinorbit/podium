# Large-state frontend benchmark

POD-999 adds a reproducible frontend scale lane after POD-991 removed Home and
made issue selection the primary startup/navigation path [spec:SP-0b2e]. The
fixture is generated and anonymous, with the Ludovico cardinalities measured in
POD-981/POD-991: 674 issues and 530 sessions, spread deterministically over 12
repositories and 96 worktrees.

## Hermetic CI lane

Run from the repository root:

```sh
bun run test:perf:frontend
```

The lane runs under Bun/Vitest and happy-dom in one worker with no retries. It
gates deterministic signals rather than runner-dependent wall-clock values:

- Tasks keeps its initial board render to the 40-card-per-stage progressive
  boundary from POD-1000: 200 of 674 cards, at or below 4,000 DOM elements and
  225 buttons. This fails closed if the pre-POD-1000 full render returns.
- Tasks render property reads stay below a fixed synchronous-work budget. The
  lane reveals exactly one 40-card chunk, then proves full-order keyboard
  navigation can mount an initially hidden card in the next stage and open it
  with Enter.
- Sidebar ownership resolves each session cwd once per derivation. The test
  deliberately runs both the direct ownership index and the complete sidebar,
  so the ceiling is two cwd reads per session; an issue × session regression is
  orders of magnitude over budget.
- A fresh-but-equal 674-row replica snapshot performs no persistence writes and
  emits no row notification. A one-row update emits one coalesced notification.
- A fake monotonic clock pins the client-switch trace milestones and warm-switch
  interaction budget without a wall-clock gate.

Each case prints one `[large-state]` JSON line. `renderMs`, `deriveMs`, and
`unchangedMs` are diagnostics for local comparisons only and never decide pass
or fail. Cardinalities, DOM counts, property/own-key reads, writes,
notifications, and synthetic trace offsets are the regression gates.

When intentionally changing the Tasks representation or a derivation contract,
compare the emitted signals before adjusting a budget. Do not raise a ceiling
just to absorb unexplained drift.

## Measure live Ludovico data

The read-only Playwright driver collects real-browser Tasks DOM/buttons, CLS,
Long Tasks, sidebar issue-click durations, `__podiumSwitchTraces`, and the
server `perf.snapshot`. It does not create or mutate issues or sessions.

Run it against the live Ludovico instance from a checkout with Playwright's
Chromium installed:

```sh
BENCH_URL=https://podium-host.example.com:55555 \
BENCH_SWITCHES=12 BENCH_ROWS=6 BENCH_DWELL=1500 \
BENCH_STORAGE_STATE=/path/to/playwright-storage-state.json \
BENCH_OUT=/tmp/ludovico-large-state.json \
bun tests/e2e/large-state-bench.ts
```

Keep `BENCH_ROWS` at or below the desktop warm-panel cap (8) to measure warm
issue navigation. Raise it deliberately for cold-churn measurements. The page
can reuse an authenticated Playwright context through the optional
`BENCH_STORAGE_STATE`; the in-page snapshot fetch reuses the browser session.

For comparable runs, use a production web build, the same 1600×1000 viewport,
the same row/switch/dwell values, and three fresh browser runs. Report the
median/range for Tasks elements/buttons, CLS, maximum Long Task, click p50/p90,
and completed switch-trace totals. Inspect `snapshot.result.data.phases` for
replica/broadcast work and retain the raw JSON beside the report.

The live measurements are signals, not CI gates: browser scheduling, terminal
mount state, host load, and the live dataset all move wall-clock values. CI
protects algorithmic and DOM-scale regressions; this driver explains their
real-user cost on Ludovico.
