# POD-4537 — live demo of the new sidebar (round three)

A dev-served page that mounts the round-three prototype sidebars over the
operator's LIVE data, through the existing server, so the difference can be
experienced rather than read about. Round-three update: arms are
`mobx|hand|control` (no TanStack), branch `integrate/4545-round-three`.

## Start it

On ludovico (where the server and the data are), from this issue's worktree:

```sh
bun run --cwd apps/web dev
```

Then open (same browser profile signed into the app, so the session cookie applies):

- `http://localhost:55556/proto-live.html?arm=mobx` — MobX pool over live data
- `?arm=hand` — the round-three hand pool
- `?arm=control` — the legacy control (current sidebar shape, for comparison)
- `?arm=mobx&split=1` — two side by side (mobx + control) on ONE runtime,
  each with its own counters; `&arm2=hand` picks the second arm

First paint is ~200–400 ms after the runtime syncs (engine ~50–500 ms on a
warm replica); the header shows engine/build/paint timings and the JS heap.

## What you see

- Header: principal, live issue/session counts, per-arm visible rows, heap,
  startup timings, and the read-only statement.
- Per arm: row commits (cumulative + last-poll delta) from the existing
  RowShell profiler, mounts, derivation counters, feed flush/event/enumeration
  counters (the row-source `rebuilds` cost is the enumeration count), and the
  parity indicator.
- Parity ticks every 10 s (plus "Check parity now"): the arm's snapshot
  against `oracleSnapshot` over the live store — the same oracle the tests
  use. Green/red with the first differing row id; `LIVE` while the store is
  changing faster than the check. Live data moves under the check, so one
  comparison can straddle a publication; the check retries while the answer
  moves and reports red only when the same row differs across attempts.
- Clicking a row selects it through the engine's own selection write (the same
  path the legacy control's pressable uses); selection is locals-only.
- "Rebuild" runs the principal-switch path: dispose arms, sources, runtime and
  assembly, then re-resolve the principal and boot fresh. After switching
  principals (sign out/in in the app), press Rebuild. Dev console helper:
  `__protoLive.survivors()` lists old-store objects still alive (force a GC
  first — DevTools Memory → collect garbage — or the list is meaningless);
  `__protoLive.parity()`, `__protoLive.rebuild()`, `__protoLive.info()`.

## Read-only apart from selection

The page issues no write commands: no renames, stage moves, archives, or
mark-read calls of its own. The one exception is selection, which flows through
the engine exactly as in the app (the runtime's own eager mark-read may follow
a click, as it does for the control). Optimism originated from this page is
not exercised — there is none to originate.

## Known gaps

- Boot-time churn: rows that change within milliseconds of the seed can paint
  stale for a second or two (one stale title seen at boot, converged green on
  the ticker). The frozen-corpus harness never sees this; live data does.
- Background traffic moves the commit counters at all times; a click's +2
  reads as a small single-digit delta on a live system, exact only when quiet.
- The page is dev-only: `proto-live.html` + `apps/web/harness/` are served by
  `vite dev` but are not inputs to `vite build` (which takes only
  `index.html`), so the production bundle and the web bundle budget are
  untouched. Two dev-server aliases support it (`node:async_hooks` absent-stub
  mirroring the prototype bundle, `react-native` → `react-native-web` as the
  harness build does); neither has a production-graph importer.
- Wire compatibility (checked 2026-09-30): client and server agree on wire 3
  (server min 1); the schema digest differs (branch touched the protocol —
  mostly terminal framing), which in a dev-served page is an iteration-mode
  notice, never a refusal. Sync/feed parsing is lenient with unknown-change
  fallback, and the sidebar path verified live. If `/version` ever disagrees
  on the wire numbers, stop and report before working around.

## Never publish the data

This page renders real missions. No screenshots, recordings, exports or data
dumps of it in commits, artifacts or mail. Serve on ludovico localhost only.
