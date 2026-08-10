# POD-1816 test lane timing and memory baseline

Date: 2026-08-10, Ludovico, commit `b8be49ea6` unless noted.

## Bottom line

The default package gate took **27m07.8s cold** and **18m00.5s warm**. The warm run
replayed 18 of 27 tasks from cache but was only **1.51x faster** (33.6% less wall time),
because all nine red tasks ran again and several of them are the longest tasks. A red task is
never cached.

The default lane's direct process-tree peak was **4.83 GiB PSS cold** and **4.26 GiB
PSS warm**, with no swap used. This is not a host-wide `free` reading: every sample sums
`Pss` and `SwapPss` from `/proc/<pid>/smaps_rollup` for the command and its descendants.
PSS apportions shared mappings instead of counting the same pages once per process.

The dominant remaining memory test is `scripts/rearch-audit.test.ts`. It retains a full
repository scan in the Vitest worker while CLI cases start another full scan in child
processes. The measured cold tree reached 4.83 GiB PSS; the largest single worker was
2.76 GiB PSS. A direct sample while one CLI case was active measured about 4.56 GiB
combined PSS (2.82 GiB retained worker plus 1.74 GiB child).

## Cold/warm measurements completed

Relative comparisons are primary. Absolute times are observations on a shared six-core host;
red-baseline reruns and host load make them noisier than the ratios and task shares.

| Root lane | Cold | Warm | Relative | Direct peak PSS | Result / interpretation |
| --- | ---: | ---: | ---: | ---: | --- |
| `test` | 27m07.8s, 0/27 cached | 18m00.5s, 18/27 cached | **1.51x**; 33.6% saved | 4.83 / 4.26 GiB | 18 green, 9 baseline-red tasks; target changes green |
| `test:unit` | alias of `test` | alias of `test` | identical by construction | identical | `package.json` invokes the same `scripts/test.ts` |
| `test:cached` | 6m22.2s, 0/2 cached | 7m03.6s, 0/2 cached | **0.90x**; warm 10.8% slower | 846 / 812 MiB | web and mobile are both red, so neither result is cacheable |
| `test:web` | 325.36s task time | 373.69s task time | **0.87x**; warm 14.9% slower | about 471 MiB isolated | Exact same Turbo task measured inside `test:cached`; 85.2% of its cold task time |
| `test:mobile` | 53.53s task time | 47.04s task time | **1.14x**; 12.1% saved | below 846 MiB combined-lane peak | Exact same Turbo task measured inside `test:cached`; 14.0% of its cold task time |
| `test:affected` | 2.83s | 2.47s | **1.15x** | 124 / 124 MiB | Clean tree selected zero packages; this measures selection overhead, not a test fan-out |
| `test:changed` | 1.09s | 1.38s | **0.79x** | 107 / 97 MiB | Clean tree selected zero tests; difference is startup noise |
| `test:related -- removal-family.test.ts` | 41.85s process wall; 5.04s Vitest | 43.61s process wall; 5.31s Vitest | **0.96x** process wall | 1.02 GiB / 954 MiB | 12/12 pass; stable ~37s between Vitest completion and process exit |
| `test:perf:sync` | stopped at 16.17s by a 2 GiB PSS safety limit | not repeated | bounded evidence, not a completion time | **2.07 GiB tree**, 1.93 GiB worker at cutoff | Deliberately quadratic benchmark; a prior unbounded worker reached 7.79 GiB PSS + 4.82 GiB SwapPss |

The direct sampler is deliberately separate evidence from Vitest's JavaScript heap. The
original runaway reported only about 35 MiB JS heap while its Bun worker grew beyond 7 GiB
RSS; heap logging alone could not identify it.

## Default cold task ranking

Task durations below are native Vitest durations divided by the 1,627.77s default wall.
They run serially, so shares are meaningful even though transform/import subtotals can overlap
inside each two-worker task.

| Rank | Task or group | Duration | Share of default wall |
| ---: | --- | ---: | ---: |
| 1 | all five `@podium/server` shards | 516.0s | **31.7%** |
| 2 | `@podium/web` | 323.45s | **19.9%** |
| 3 | `@podium/scripts` | 289.90s | **17.8%** |
| 4 | server boundary shard | 216.20s | **13.3%** |
| 5 | server store shard | 144.47s | **8.9%** |
| 6 | server services shard | 104.02s | **6.4%** |
| 7 | `@podium/client-core` | 92.27s | **5.7%** |
| 8 | `@podium/daemon` | 65.84s | **4.0%** |

Web and scripts alone account for **37.7%** of the full wall. Server is large in aggregate
but not a memory runaway: an isolated boundary sample was about 417 MiB PSS. Web was about
471 MiB PSS. Their problem is duration; scripts is both duration and memory.

## The long scripts lane

`scripts/rearch-audit.test.ts` took **255.966s**, which is **88.3% of the scripts
lane** and **15.7% of the entire default wall**. Its slow cases were:

| Case | Time | Share of rearch file |
| --- | ---: | ---: |
| `an output flag cannot disable the gate` | 78.884s | 30.8% |
| `gates a phase whose items are still alive...` | 74.939s | 29.3% |
| `fails CLOSED on a well-formed phase that maps to no items` | 29.252s | 11.4% |
| `exits 0 when the tree matches the committed baseline` | 27.436s | 10.7% |
| `an output flag cannot swallow the baseline write` | 25.321s | 9.9% |

The first two cases alone are **60.1% of the file** and **9.45% of the default
wall**. The file repeatedly executes `runAudit(loadContext(repoRoot))` in-process and also
uses `spawnSync` to run the CLI against the real tree. The worker retains its repository
graph while the child creates another; this explains both the elapsed time and the PSS peak.

The highest-leverage change is to avoid simultaneous full-tree graphs: keep one real-tree
baseline smoke, exercise CLI flag/exit-code wiring on a small fixture, and isolate any remaining
real-tree child cases from a worker that already loaded the tree. The second lever is making the
scripts task green: while it is red, Turbo reruns all 290 seconds and the memory spike on every
warm default invocation.

## The web lane

Web's cold task reported 325.36s total, with 103.33s in test bodies, 290.49s in imports,
162.63s in environments, and 40.08s in transforms (two workers make these accumulated
subtotals exceed wall time). There is no single assertion comparable to rearch-audit. The
duration target is repeated file/module/environment setup across 247 files, followed by safe
sharding or more parallel capacity on a dedicated runner—not raising concurrency on the shared
live host.

## Removal-family fix: what the test measures

The harness fix adds only the missing initial-world delivery:

```ts
client.sink.connected()
client.pushWorld()
await client.replica.settled()
```

No assertion or product path was weakened. `pushWorld()` still passes through the test
authority's wire mapping, `FeedSink`, `PushedBootstrapSource`, the kernel Replica, and the real
IndexedDB/SQLite backend. The 12 cases still measure delete versus revoke, facade visibility,
pending state, watermark/no-heal behavior, present-to-absent transitions, durability, and both
web and mobile storage engines. The fixed file passes 12/12 in 258–532ms of test bodies and
peaks around 343 MiB PSS when run with the bounded focused harness.

The bug prevented ten parameterized online cases from reaching those assertions. Two
no-network `answers undefined` cases do not call `online()` and were unaffected. Instead of
measuring removal semantics, the broken cases measured an invalid setup: `settled()` waits
forever after `FeedSink.connected()` promises an initial world that the harness never sends.

What this unit test still does **not** measure is the production transport boundary that
automatically sends the first world after a socket connects. The harness models that event by
calling `pushWorld()`; SocketHub/server delivery belongs to integration coverage. It also does
not prove a real second-account authentication boundary—the file uses feed principals under the
current device-grade identity model.

## Lane inventory not yet timed in this session

No completion time is claimed for the rows below. They were not started after the operator
asked for a status and the already-running measurements had consumed several hours.

| Lane | Why a cold/warm pair remains expensive or non-comparable |
| --- | --- |
| `test:watch` | Non-terminating; only startup-to-ready can be measured, then it must be stopped |
| `test:perf:frontend`, `perf:typing` | Performance probes, not result-cached gates |
| `test:integration` | Runs integration Vitest and then the acceptance lane |
| `test:acceptance`, `test:acceptance:process` | Real process/PTY load; no result cache |
| `test:e2e` | Full-stack real-process lane; no result cache |
| `test:multi-instance` | Starts independent concurrent runtimes and installer coverage |
| `test:browser` | Builds packages/web/mobile and runs the Playwright census; tens of minutes |
| `test:bun`, `test:bun:unit` | Bun-native process/runtime lanes; no Turbo result cache |
| `test:smoke:agents` | Starts real agent CLIs and consumes LLM quota; should not be repeated merely to create a warm label |
| `oracle` | Aggregate of typecheck, test, integration, e2e, and multi-instance; derive from components instead of duplicating all five |

For non-cached process lanes, “warm” can only mean a second back-to-back observation benefiting
from OS/module/build caches; it is not equivalent to Turbo's result-cache hit. Future measurements
should record that distinction explicitly and run one direct-PSS pass plus lightweight timing
passes, rather than attaching the relatively expensive `/proc` sampler to every repeat.
