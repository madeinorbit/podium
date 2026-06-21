# Backend runtime perf — Node vs Bun baseline

Memory + CPU footprint of the split backend (`podium-server` + `podium-daemon`) under the
**same live workload**, to compare Node (tsx) against Bun for the migration.

## How it's captured

`scripts/profile-backend.sh <label> <duration_s> <interval_s>` resolves the two pids by
their listening ports (server `:18787`, daemon hook `:45777`) each sample and reads RSS +
CPU from `/proc`. Because it resolves by port, the **identical script** profiles either
runtime — only `ExecStart` differs. Run it while actually using Podium so the numbers
reflect real usage, not an idle box.

```sh
# Node (current default):
sh scripts/profile-backend.sh node-baseline 600 20
# Bun (after cutting the backend over — see docs/bun-migration-readiness.md):
sh scripts/profile-backend.sh bun 600 20
```

Each run writes `perf/<label>-samples.csv` (per-sample) and `perf/<label>-summary.json`
(avg/max). The abduco attach clients are an external C binary, identical under both
runtimes, so they're a constant (~42–44 here) and not the comparison target.

## Baseline — Node (tsx), 2026-06-21, 30 samples over 10 min, 42 live sessions

| Process | RSS avg | RSS max | CPU avg | CPU max |
|---|---:|---:|---:|---:|
| server  | 182.1 MB | 236.9 MB | 12.8% | 16.7% |
| daemon  | 316.7 MB | 353.0 MB | 14.3% | 17.4% |
| **total** | **~499 MB** | — | **~27%** | — |

Stable across the window — same pids throughout (no restarts), RSS plateaued, no leak.

## Bun comparison

_Pending a 10-min Bun run under the same workload._ Spot readings during the earlier Bun
cutover were server ~190 MB / ~20% and daemon ~290–320 MB / ~20% — same ballpark — but a
full `bun` profile with this script is needed for an apples-to-apples number. Compare the
two `*-summary.json` files; lower-or-equal RSS/CPU on Bun (plus a clean soak) is the bar.
