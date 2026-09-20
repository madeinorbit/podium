# POD-4445 NOTES — measurement harness + legacy control (WIP)

## Where things stand (2026-09-20, ~2h in: reading done, writing starts next)

Read: G1 spec (`pod-4441-round-two-slice.md`), methodology §1a/§5.7/§5.8 budgets,
G2 fixture (`harness/src/fixture/corpus.ts`) + oracle (`harness/src/oracle/oracle.ts`),
G3 row stream (`shared/src/row-source.ts`) + scenarios (`shared/src/scenarios.ts`,
13 scenarios + `startScenarioEngine`/`ScenarioCache` exported),
`worklistSlice` + `useSlice`/`createSlicePublisher`, `slice-render-count.test.tsx`,
`large-state-bench.ts`, stage0 `capture.ts`, D1 `suite.tsx`, stage0-live JSON shape.

## Findings that shape the build

- Load ~8.2 at start: counts only until load drops; no browser timing yet.
- `arm.snapshot()` is `SliceSnapshot`; G3 `ScenarioResult.after` is `ScenarioSnapshot`
  — the brief's "compare to scenario.after via deep-equal" cannot be literal.
  Parity = `arm.snapshot()` deep-equals an expected `SliceSnapshot`. For engine-backed
  runs the expected snapshot comes from a new oracle export
  `snapshotFromStore(store, locals)` (legacy derive + same projection over live engine
  state). `expectedSnapshot(corpus, locals)` behavior unchanged (refactor to share
  the projection).
- Control cannot take `RowSource` alone: legacy reads the whole store via the
  published slice, not the row stream. So: `legacyControlArmFor(engine, replica): Arm`
  factory; `create()` ignores source deltas by design (documented — that IS the control).
  Read path = real `useSlice`-equivalent: `createSlicePublisher` + `useSyncExternalStore`
  over the engine handle (StoreProvider boots its own runtime, can't inject; same
  mechanism as `use-slice.ts:60-66`). Derive counted via a wrapper slice def
  (instrumentation only, same derive body).
- `RowShell` (required wrapper, added to `shared/src/arm.ts`): per-row
  `React.Profiler` reporting into a harness-provided context registry. Arms render
  `<RowShell id={rowId}>`; default context is a no-op so arms run outside harness.
- Control list mirrors pre-Stage-0 shape deliberately: NO memo on rows, whole
  `issues`/`sessions` arrays as props, fresh closures per render.
- vite 8 lives in apps/web (`apps/web/node_modules/.bin/vite`); harness/web uses it
  via workspace bin. Playwright chromium present (`chromium-1234`).
- Mobile: RN aliased to react-native-web under happy-dom (`apps/mobile/vitest.config.ts`);
  native lane = control `mountNative()` with RN primitives tested that way.
- Web entries: `entries/control.{html,ts}` fully working; `hand/mobx/tanstack` entries
  are labeled PENDING stubs exposing `__proto {ready:false}` so the build covers all
  entries and H workers replace stubs. One entry per arm keeps bundles isolated.
- Browser driver `harness/browser/run.ts`: `--arm --scale` one invocation per arm/scale
  (a killed browser test poisons later renders in the same file), interleaved scenarios,
  input-to-paint via dispatched pointerdown + double rAF, longtask observer, CDP heap
  with forced GC, loadavg+uptime per record, bench lease around timing only, JSON field
  names overlapping stage0-live (`runtimeSha`, `browser`, `capturedAt`, heaps, `longTasks`).
- Control 1x JSON: counts via engine-backed count harness at GROWTH x1 (no walls under load).

## Next: write shared RowShell → count harness → oracle snapshotFromStore → control → tests.
