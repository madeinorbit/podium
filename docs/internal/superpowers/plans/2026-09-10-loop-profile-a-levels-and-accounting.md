# Loop profile A — levels and accounting

**Goal:** Both processes resolve one of four profile levels and, above `off`, run a shared
loop-accounting module that writes one machine-readable minute record per component.

**Spec:** `docs/internal/superpowers/specs/2026-09-10-loop-profile-levels-design.md` §3, §4, §5.
This part is the foundation; B, C and D depend on it and must not start before it lands.

**Tech:** Bun, TypeScript, vitest through the repo's validation-admission lanes.

## Global constraints

- Level `off` installs nothing: no timer, no wrapper, no directory, no file.
- No allocation on the per-second path; rings are preallocated `Float64Array`s.
- Only the four level names are accepted; there is no `1`, `true`, or stacks variable.
- A new server test file must be added to the shard roster
  (`bun scripts/server-test-shards.ts --write`, commit both files).
- Scoped typecheck only (`--filter`, `--concurrency=1`); never repo-wide.

## Steps

### 1. Level type and resolver (`packages/runtime/src/config.ts`)

- Add `loopProfile: z.enum(['off','accounting','attribution','full']).optional()` to
  `PodiumConfig` next to `updateChannel` (line ~177). No config migration: optional field.
- Add `export type LoopProfileLevel` and `export const LOOP_PROFILE_LEVELS`.
- Add `resolveLoopProfileLevel(config = loadConfig(), env = process.env)`:
  1. `env.PODIUM_LOOP_PROFILE` if it is one of the four names. Any other non-empty value
     returns a `warning` string alongside the level (return shape
     `{ level, source: 'env'|'config'|'default', warning? }`), and falls through.
  2. `config.loopProfile`.
  3. `attribution` when `resolveUpdateChannel(config, env) === 'dev'` or
     `(env.PODIUM_APP_VERSION ?? process.env.PODIUM_APP_VERSION ?? 'dev') === 'dev'`;
     else `off`.
- Update the env table comment at the top of the file: `PODIUM_LOOP_PROFILE` row becomes
  "level name; resolveLoopProfileLevel()"; drop the `PODIUM_LOOP_PROFILE_STACKS` mention.
- Tests in `config.test.ts` (or a new `loop-profile.test.ts`): precedence table, rejection
  of `1`/`on`/garbage with warning, defaults for `stable`/`edge`/`dev`, source-run sentinel.

### 2. Process-level module (`packages/runtime/src/loop-profile.ts`)

- Resolves once at import: `export const loopProfile = resolveLoopProfileLevel()`,
  `export const loopProfileLevel: LoopProfileLevel`, `export function atLeast(level)`.
- Logs the resolver's warning once through `@podium/logger` at `warn`.
- Add `"./loop-profile"` to `packages/runtime/package.json` exports.

### 3. Replace the raw env reads

- `packages/runtime/src/query-attribution.ts`: `ENABLED = atLeast('attribution')`,
  `STACKS = atLeast('full')`. Same in `task-attribution.ts`.
- `apps/daemon/src/loop-attribution.ts`: `ENABLED = atLeast('attribution')`.
- `apps/daemon/src/host-runtime.ts:386` and `apps/server/src/server.ts:1832`: gate on the
  level (see step 6 for what each level starts).
- `apps/cli/src/cli-systemd.ts:162`: delete the `Environment=PODIUM_LOOP_PROFILE=1` line and
  its comment; update `cli-systemd.test.ts` if it asserts the line.
- Grep `PODIUM_LOOP_PROFILE_STACKS` and remove every mention (code, comments, docs table).

### 4. Parent statement (`apps/cli/src/cli.ts` ~1645)

- Where the parent builds the child env, add
  `PODIUM_LOOP_PROFILE: resolveLoopProfileLevel(config, process.env).level`.
- Test: the parent's child-env builder carries the resolved level; a child with an explicit
  env level ignores its own config (covered by the resolver test's precedence).

### 5. Accounting module (`packages/runtime/src/loop-accounting.ts`)

Exports per spec §4.1: `startLoopAccounting(opts)`, `LoopAccountingHandle`,
`LoopWindow`, `LoopMinute`, `LoopBucket`, `LoopStall`, `LoopMinuteSink`.

- Probe timer: move the self-scheduling probe from `loop-metrics.ts` here (20 ms, unref'd).
  Lateness > 5 ms adds to the window's `blockedMs`; lateness > `longTickMs` increments
  `stalls`, updates `stallMaxMs`, pushes into the minute reservoir (cap 256), and calls
  `onLongTick` once per window (throttle as today) with the classifier verdict.
- Sample timer (1 s): read main-thread CPU (`/proc/self/task/<pid>/stat` fields 14/15,
  ticks × 1000 / `sysconf` clock ticks — read `CLK_TCK` once via
  `os.constants` fallback 100) and schedstat; compute deltas; write the window row; call
  `classifier.refreshBaseline()`; record self cost from `performance.now()` pairs.
- Window ring: `Float64Array(120 * COLUMNS)`; `LoopWindowColumn` enum for columns
  (utilization, runqueueWait, blockedMs, stalls, stallMax, heapUsed, rss, selfCostMs, then
  one column per `LoopBucket` wallMs and count).
- Minute rollup every 60 windows: `LoopMinute` per spec §4.3, into a ring of 60 plain
  objects (allocation once per minute is acceptable) and to `sink.write(minute)`.
- `attribute(bucket, wallMs)`: adds to the current window's bucket columns; no-op below
  `attribution`.
- `snapshot()`: copies rings into arrays, newest last.
- Injectable `now`, `readMainThreadCpu`, `readSchedstat`, `clockTicksPerSecond`.
- Move `createStallClassifier` / `parseSchedstat` reads to share the schedstat reader.
- `loop-metrics.ts`: `startLoopMetrics` becomes a wrapper that calls
  `startLoopAccounting` with a null sink and forwards `onLongTick`; delete the
  `monitorEventLoopDelay` histogram and the `snapshot()` percentiles it fed. Keep the
  existing tests green (adjust the histogram assertion if one exists).

Tests `loop-accounting.test.ts`: fake clock drives probe and sample timers (use vitest fake
timers plus an injected `now`); assert utilization from tick deltas, blocked sum, stall
count and max, reservoir percentiles, ring wrap at 120 and 60, `selfCostMs > 0`, level `off`
registers no timers (spy on `globalThis.setInterval`), `attribute` is a no-op below
`attribution`, minute record shape matches `LoopMinute` exactly (no undefined-valued keys).

### 6. Minute sink (`packages/runtime/src/loop-minute-sink.ts`)

- `createLoopMinuteSink({ dir, component })` writes `<dir>/loop-<component>.ndjson` with
  `writeSync`, rotates at 8 MiB to `.1` (one generation), creates `dir` lazily on first
  write. Reuse `packages/logger/src/node/file-sink.ts` if its options fit
  (`maxBytes`, `maxFiles: 2`); otherwise a 60-line sibling with the same rotation logic.
- Also emit the record through the component logger at `info`, message `loop minute`.
- Wire in both processes: `<stateDir>/perf` from `stateDir()` in `@podium/runtime/config`.
- Tests: rotation at threshold, one archive kept, directory absent until first write.

### 7. Wiring

- Server (`server.ts` ~1829): at level ≥ `accounting` start accounting with sink; at
  ≥ `attribution` additionally `attributeTasks()`, the 1 s attribution reset, `SIGUSR2`
  dump, and the per-stall `onLongTick` record exactly as today (it now receives
  `utilizationPct` too). At `accounting` `onLongTick` is a no-op.
- Daemon (`host-runtime.ts` ~386): same split; `reportLongTick` stays the ≥ `attribution`
  reporter. Keep `startLoopAttribution()` at ≥ `attribution`.
- Expose the handle on the server state (`state.loopAccounting`) for part C; on the daemon
  keep it in `host-runtime` scope and hand `latestMinute()` to the metrics push for part C.

### 8. Verification

- `bun run test` (lean gate) plus focused lanes for `packages/runtime`, `apps/daemon`
  `loop-attribution`, `apps/cli` `cli-systemd` and the parent env test.
- Live: restart the reference install, confirm `~/.podium/perf/loop-server.ndjson` and
  `loop-daemon.ndjson` gain one line per minute, `selfCostPct < 0.1`, and delete
  `~/.config/systemd/user/podium.service.d/91-loop-profile.conf` (value `1` is no longer
  accepted; the `dev` channel default covers it). Record both components' `utilizationPct`
  in the parent issue's state with the timestamp.
