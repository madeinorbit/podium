# Event-loop profile levels — design

*Issue: POD-3810 (Loop stall instrumentation audit). Written 2026-09-10 after auditing the
existing stall instrumentation on the server and the daemon and measuring the live install.
This introduces leveled, always-available loop accounting for both processes, keeps the
existing attribution behind a flag, and adds on-demand CPU profiles. It changes no product
behavior; every level is a diagnostic.*

## 1. Problem and goal

Both the server and the daemon carry a flag-gated stall probe (`PODIUM_LOOP_PROFILE`) that
reports single event-loop ticks blocked for longer than 100 ms, with a starved-versus-busy
verdict and, on the server, per-SQL and per-timer attribution. Three gaps were measured:

1. **No utilization number exists.** Under Bun 1.3.x `performance.eventLoopUtilization()`
   returns zeros and `monitorEventLoopDelay` missed a 300 ms synchronous block outright. The
   probe timer is the only working detector, and it reports stalls, never busy percentage. A
   loop that is 80 percent busy in 20 ms slices is invisible. On 2026-09-10 the live server's
   main thread was measured from `/proc` at 77–80 percent busy with no record of it anywhere.
2. **The flag is off on installed builds.** Only the source-run server unit sets it; the
   packaged supervisor never does, so installs record nothing until an operator adds a
   drop-in.
3. **Nothing is retained or machine-readable.** Stalls are single log lines; "percent of
   wall blocked" has been computed by hand from journal output in every investigation.

The goal is a leveled instrument, shared by both processes, that (a) always can report loop
utilization and stall statistics per minute in a bounded machine-readable file, (b) keeps the
per-event attribution seams behind a level so a customer install pays nothing, (c) captures a
CPU profile on demand or on a long stall, and (d) defaults on for development installs and
off for self-hosted customers, with cloud hosts opting into the cheap tier by configuration.

## 2. Invariants

1. At level `off` no timer is registered, no scheduler or database wrapper is installed, and
   no file is opened. The process is byte-for-byte on the current unflagged path.
2. The level is resolved once per process from env, then config, then the channel default,
   and the parent states the resolved level to its server and daemon children through env, so
   the two processes never disagree.
3. Accounting never allocates on the hot path: rings are preallocated typed arrays and every
   record is written by the once-per-second and once-per-minute timers only.
4. The instrument measures its own cost and reports it in the same minute record, so its
   overhead is a live field, not an assumption.
5. Every retained artifact is bounded: rings have fixed lengths, the minute file rotates at a
   fixed size, profiles are rate-limited and capped by count.
6. Attribution numbers are reported next to a coverage figure. A bucket is never presented as
   the cause of a window it does not cover.
7. Extending the wire is additive: every new field is optional, so an older daemon or server
   on either side of the link keeps working.

## 3. Levels and the gate

### 3.1 Levels

| Level | Installs | Default for |
|---|---|---|
| `off` | nothing | self-hosted customer installs (`stable`, `edge`) |
| `accounting` | probe timer, per-second `/proc` sampling, rings, minute file, perf snapshot section | cloud hosts, by env or config |
| `attribution` | `accounting` plus SQL, scheduler and frame seams, per-stall causes, automatic profile capture on long stalls, `SIGUSR2` dump | `dev` channel and source runs |
| `full` | `attribution` plus stack capture at scheduling sites (what `PODIUM_LOOP_PROFILE_STACKS` did) | explicit opt-in only |

### 3.2 Resolution

A new resolver in `packages/runtime/src/config.ts`:

```ts
export type LoopProfileLevel = 'off' | 'accounting' | 'attribution' | 'full'
export function resolveLoopProfileLevel(config?: PodiumConfig, env?: EnvSource): LoopProfileLevel
```

Order:

1. `PODIUM_LOOP_PROFILE` in env, when set. The only accepted values are the four level
   names. Any other value, including the old `1`, is a startup warning naming the accepted
   values and falls through to the next step.
2. `config.loopProfile` in `config.json`, a new optional field with the same enum.
3. `off` when the process is under a test runner (`VITEST` set at all, or `NODE_ENV`
   exactly `test`) — POD-3827, decided after this section was written. The suite runs from
   source and would otherwise inherit step 4's answer for every file in the repository; a
   test that exercises the instrument names its level at step 1.
4. Default: `attribution` when `resolveUpdateChannel(config, env)` is `dev` or the process
   runs from source (`PODIUM_APP_VERSION` is the literal `dev`); otherwise `off`.

`PODIUM_LOOP_PROFILE_STACKS` is removed; `full` is the only way to get stack capture.

### 3.3 Parent statement

The parent resolves the level once and puts `PODIUM_LOOP_PROFILE=<level>` into the env it
passes to the server and daemon children, following the `PODIUM_LOGGING_MODE` pattern. A
child that receives an explicit level takes it (step 1 above), so both processes agree even
if their config views differ. A standalone `podium server` or `podium daemon` resolves for
itself.

### 3.4 Consumers

The five modules that read `!!process.env.PODIUM_LOOP_PROFILE` today switch to one exported
`loopProfileLevel` from `@podium/runtime/loop-profile` (a thin module that calls the
resolver once and exports the level plus `atLeast(level)` helpers). They are
`packages/runtime/src/query-attribution.ts`, `task-attribution.ts`,
`apps/daemon/src/loop-attribution.ts`, `apps/daemon/src/host-runtime.ts`, and
`apps/server/src/server.ts`. The rendered dev server unit in `apps/cli/src/cli-systemd.ts`
drops its hard-coded `Environment=PODIUM_LOOP_PROFILE=1`, because the channel default now
covers it.

## 4. Accounting (level `accounting` and above)

### 4.1 Module

`packages/runtime/src/loop-accounting.ts`, used verbatim by both processes. It owns the probe
timer that `loop-metrics.ts` has today, so `startLoopMetrics` becomes a thin compatibility
wrapper over it and its `monitorEventLoopDelay` histogram is removed (it is blind under Bun
and its `h.max` semantics caused the earlier spam bug).

```ts
export interface LoopAccountingHandle {
  stop(): void
  /** The last N one-second windows and M one-minute rollups, newest last. */
  snapshot(): LoopAccountingSnapshot
  /** Feed one attributed cost into the current window (level attribution+). */
  attribute(bucket: LoopBucket, wallMs: number): void
}
export function startLoopAccounting(opts: {
  component: 'server' | 'daemon'
  level: LoopProfileLevel
  longTickMs?: number               // default 100
  onLongTick: (stall: LoopStall) => void
  sink: LoopMinuteSink              // §5
  now?: () => number
  readMainThreadCpu?: () => { utimeTicks: number; stimeTicks: number } | undefined
  readSchedstat?: () => string
}): LoopAccountingHandle
```

### 4.2 Per-second window

Every second the module samples:

- **Main-thread CPU** from `/proc/self/task/<pid>/stat` fields 14 and 15 (utime, stime, in
  clock ticks; the main thread's tid equals the pid). Utilization for the window is the CPU
  delta divided by the wall delta. Off Linux the field is absent and the record says so.
- **Runqueue wait** from `/proc/self/task/<pid>/schedstat`, already read by
  `loop-stall.ts`; the reader moves here and the classifier keeps using it.
- **Blocked wall** as the sum of probe lateness above 5 ms in the window, from the probe
  timer, plus the count of probe fires over `longTickMs` and their max.
- **Heap and RSS** from `process.memoryUsage()`.
- **Self cost**: wall time spent inside this module's own sampling and record writing, from
  `performance.now()` pairs around each sample and flush.

Each window is one row in a preallocated `Float64Array` ring of 120 windows, with a fixed
column layout (`LoopWindowColumn` enum). Attribution buckets (§6) are further columns in
the same row and stay zero at level `accounting`.

### 4.3 Per-minute rollup

Every 60 windows the module folds them into one `LoopMinute` record:

```ts
interface LoopMinute {
  at: string                 // ISO minute boundary
  component: 'server' | 'daemon'
  level: LoopProfileLevel
  utilizationPct?: number    // main-thread CPU / wall, mean over the minute
  utilizationMaxPct?: number // worst one-second window
  runqueueWaitPct?: number
  blockedPct: number         // probe-lateness sum / wall
  stalls: number             // windows' long-tick count
  stallP50Ms: number
  stallP99Ms: number
  stallMaxMs: number
  heapUsedBytes: number
  rssBytes: number
  selfCostPct: number        // §4.2 self cost / wall
  buckets?: Record<LoopBucket, { wallMs: number; count: number }>  // attribution+
  coverage?: number          // sum(buckets.wallMs) / (utilization-derived busy ms)
}
```

Stall percentiles come from a bounded reservoir of the minute's long-tick durations (cap
256, oldest dropped). Minutes go into a ring of 60 and to the sink (§5). A minute with no
long tick and utilization under 1 percent is still written; a flat file is evidence too.

### 4.4 Per-stall record

`onLongTick` keeps its current shape and fields on both processes (duration, verdict,
own-CPU, runqueue wait, heap, RSS; SQL, tasks and coverage on the server; frame and control
counters on the daemon). It gains `utilizationPct` of the window the stall landed in. It is
emitted only at level `attribution` and above, because at `accounting` the minute record
already carries the stall counts and the per-stall line would double-write them.

## 5. Files and retention

### 5.1 Minute file

`LoopMinuteSink` writes one NDJSON line per minute to
`<stateDir>/perf/loop-<component>.ndjson` with the existing logger's file-sink primitive
(`writeSync`, single line, no buffering). Rotation is size-based at 8 MiB to
`loop-<component>.ndjson.1`, one generation kept, so the pair holds roughly ten days of
minutes. The directory is created at start when the level is above `off` and never
otherwise.

The same record is also emitted through the logger at `info` under the message
`loop minute`, so it reaches the journal and `podium logs`, but the dedicated file is the
contract for agents: it holds only these records, in order, without other log traffic.

### 5.2 Profiles

`<stateDir>/perf/profiles/<component>-<ISO timestamp>-<trigger>.json`, where trigger is
`stall` or `signal`. At most 20 files are kept; the oldest is deleted before a new one is
written. See §8 for the capture itself.

### 5.3 What is not stored

Nothing goes into SQLite. These are process diagnostics, not domain state, and the store's
write funnel must not carry them.

## 6. Attribution (level `attribution` and above)

### 6.1 Buckets

A fixed enum, shared by both processes:

| Bucket | Server source | Daemon source |
|---|---|---|
| `ws.client` | `measureTask('ws.client.*')` in `gateway/client-socket.ts` | — |
| `ws.daemon` | `measureTask('ws.message.daemon')` in `gateway/ws-server.ts` | — |
| `rpc` | tRPC timing middleware (`perf.record('rpc')`), only the synchronous part: the handler's own time between awaits is not separable, so `rpc` records wall time and is flagged `inclusive: true` in the record | — |
| `sql` | `recordQuery` in `query-attribution.ts` | — |
| `timers` | `attributeTasks` scheduler patch | `attributeTasks`, newly installed |
| `control` | — | `beginControlTurn` / `timeTask('controlDispatch*')` |
| `frames` | — | `countFrame` path in `control/session.ts`, timed |
| `tails` | — | `timeTask('tailBatch*')` |
| `worker` | janitor worker hand-backs (`janitor-host.ts`) | discovery worker hand-backs (`discovery-loop.ts`) |

`attribute(bucket, wallMs)` is the single entry point; the existing `recordTask`,
`recordQuery`, `timeTask` and `measureTask` functions call it in addition to their own maps,
so their per-name detail stays available for the per-stall record and `SIGUSR2` dump.
The daemon's `timeTask` is re-implemented over the runtime's `measureTask` so the two seams
share one implementation and one label convention.

### 6.2 Coverage

`coverage` in the minute record is the bucket sum over the busy time derived from
utilization. Because `sql` nests inside `rpc`, `timers` and the WebSocket buckets, the
bucket sum can exceed busy time; the record therefore also carries `nestedBuckets: ['sql']`
so a reader subtracts it. A coverage below 0.5 is the signal that the next seam is missing,
which is the reading rule established by POD-1931.

### 6.3 Daemon parity

The daemon gains `attributeTasks()` at start (level `attribution`+), the same
`resetTaskAttribution` cadence the server has, and a `SIGUSR2` handler that dumps task
totals and control-type costs through the logger. The daemon has no SQL, so `sql` stays
absent from its records rather than zero.

## 7. Exposure

### 7.1 Daemon to server

`HostMetricsWire` gains an optional `loop?: LoopMinute` carrying the daemon's most recent
completed minute. The daemon attaches it on every host metrics push (15 s cadence), so the
same minute repeats up to four times; the server keeps only the newest per machine by `at`.
An older server ignores the field; an older daemon never sends it. The Zod schema in
`packages/protocol/src/messages/host.ts` is widened first and the daemon sends the value in
the same change, which is safe because the field is optional on the receiving parser.

### 7.2 Perf snapshot

`PerfSnapshot` gains:

```ts
loop?: {
  level: LoopProfileLevel
  server: { windows: LoopWindow[]; minutes: LoopMinute[] }   // rings, newest last
  daemons: Record<MachineId, LoopMinute>                     // latest per machine
}
```

Filled from the server's accounting handle and the hosts service's latest-per-machine map.
Absent at level `off`. No web rendering in this cut.

### 7.3 CLI

A `perf` command group in `apps/cli/src/perf-cli.ts`:

- `podium perf paths` prints the minute files and the profile directory for this instance,
  as JSON on `--json` and one path per line otherwise.
- `podium perf profile <server|daemon> [--seconds N]` sends `SIGUSR2` to the component's
  pid from the run registry (`<stateDir>/run/<component>.pid`) with the duration carried
  through a small side file (`<stateDir>/perf/profile-request.json`, consumed by the
  handler), then waits for the profile file to appear and prints its path. At level `off` or
  `accounting` the command exits 2 with one line saying the level and how to raise it.
- `podium perf level` prints the resolved level and which source decided it.

The group appears in `podium --help` only when the `podium-development` feature is enabled,
through the existing `resolveCliFeatures` gate that already hides `specs` and `workflows`.
The commands run regardless of that flag.

## 8. Profile capture (level `attribution` and above)

Bun's in-process sampling profiler (`bun:jsc` `startSamplingProfiler` /
`samplingProfilerStackTraces`) is the capture primitive; `bun --cpu-prof` only writes at
exit and Linux `perf` is unavailable on the reference host and cannot name JIT frames.

- **Triggers:** `SIGUSR2`, and — only when the install asks for it — a long tick over
  `profileStallMs` (default 1000 ms). The stall trigger arms the profiler *after* the stall
  (the stall itself is over), on the premise established by every measured incident that
  stalls recur in bursts; the record says `trigger: 'stall'` and names the stall that armed
  it. It is OFF by default (`config.profileOnStall`, `PODIUM_LOOP_PROFILE_ON_STALL`)
  because arming cannot be undone — see **Cost** below (POD-3834).
- **Duration:** 10 s default, 1–60 s on request.
- **Rate limit:** one capture per 5 minutes per component; a trigger inside the window is
  counted in the minute record as `profileSuppressed`.
- **Output:** the stack-trace text from `samplingProfilerStackTraces()` wrapped in a JSON
  envelope with component, level, trigger, timestamps, and the minute record that contained
  the trigger. The format is what Bun returns; converting to the Chrome `.cpuprofile`
  format is out of scope until a reader needs it.
- **Size:** a profile is held under 4 MB by keeping an evenly spread sample of the window's
  traces (`traceCount`, `tracesSampled`, `tracesDropped` say what happened), and a
  component's profiles together under 64 MB. Unbounded, the reference install wrote files
  of 2.0–30.6 MB and 112 MB of directory in half an hour (POD-3834).
- **Cost:** the sampling profiler runs on a separate thread and CANNOT BE STOPPED, so the
  first arming is a commitment for the life of the process, and every drain afterwards is
  main-thread work proportional to the traces in the buffer. Measured on the reference
  server (2026-09-10, 19 minutes at `attribution`, ~67 % busy loop): a mean 2427 ms per
  minute — 4.05 % of wall, worst minute 6350 ms — against a budget of 0.5 %.

  The **sample period** is the only lever that reduces that: cost is traces-per-second
  times microseconds-per-trace, and draining more often does not do less work (interleaved
  A/B: 5.2 ms per busy second at a 1000 ms drain interval, 5.9 ms at 250 ms). It cannot be
  set from inside the process — `startSamplingProfiler` takes a directory, a number passed
  to it is accepted and ignored, and `process.env` assigned before the first call is too
  late — only through `BUN_JSC_sampleInterval` (microseconds) in the environment at
  startup. The supervisor states 10 ms to every child it spawns; a capture is REFUSED, with
  a record saying what to set, when the sampler would run at a period nothing asked for.
  The drain interval adapts to hold ONE drain near 5 ms, which bounds latency rather than
  cost, so the diagnostic cannot itself appear as a stall.

  A capture is also refused when `startSamplingProfiler` is absent (non-Bun runtime), and
  the record says so.

## 9. Testing

Unit, in `packages/runtime/src`:

- `loop-accounting.test.ts`: fake clock, fake `/proc` readers, fake sink. Asserts window
  math (utilization from tick deltas, blocked from probe lateness, self cost present), the
  minute rollup (percentiles from the reservoir, `coverage` and `nestedBuckets`), ring wrap
  at 120 and 60, and that level `off` registers nothing (spy on `setInterval`).
- `loop-profile.test.ts`: the resolver's precedence table, rejection of non-level env values, the
  channel default for `stable`, `edge`, `dev`, and the source-run sentinel, the test-run
  default of `off` and both layers still outranking it, and the parent's stated level
  winning inside a child.
- `loop-minute-sink.test.ts`: rotation at the size threshold, one generation kept, directory
  created only above `off`.
- Existing `loop-metrics.test.ts`, `task-attribution.test.ts`, `loop-stall.test.ts` keep
  passing through the compatibility wrapper.

Protocol: round-trip tests for `HostMetricsWire.loop` and the `PerfSnapshot.loop` section,
plus a parse of a frame without the field.

Daemon: `loop-attribution.test.ts` extended for `attributeTasks` installation and the
`SIGUSR2` dump; a test that the `frames` and `tails` seams call `attribute`.

Server: a test that `perf.snapshot` carries `loop` at level `accounting` and omits it at
`off`; a hosts-service test that the newest daemon minute wins by `at`.

CLI: `perf-cli.test.ts` for `paths`, `level`, the level-2 exit of `profile`, and the help
gate through a fake features client.

Live: after landing, restart the reference install, confirm `perf/loop-server.ndjson` and
`perf/loop-daemon.ndjson` grow by one line per minute, confirm `selfCostPct` is under 0.1 at
level `attribution` on the server, run `podium perf profile server` once, and record the
observed utilization for both components in this issue's state. That measurement is the
first "as of" for the core/real-time split decision.

## 10. Rollout

1. Land with the channel default. The reference install's temporary drop-in
   (`podium.service.d/91-loop-profile.conf`, value `1`) is deleted in the same landing step,
   because `1` is no longer a value and the `dev` channel default now covers it.
2. Cloud host units add `Environment=PODIUM_LOOP_PROFILE=accounting` in their unit
   templates, in a separate change once the cloud unit renderer exists.
3. Customer installs see no change.

## 11. Non-goals

- A hot toggle without restart. The level is a process property; a runtime RPC to change it
  is a later issue if the restart cost proves annoying.
- Web UI rendering of the loop section.
- Converting profiles to Chrome format.
- Instrumenting async I/O completions through `async_hooks`. Coverage below 0.5 is the
  signal to revisit that, per §6.2.
- Any change to what the janitor or publish workers do; the accounting observes the main
  thread only.
