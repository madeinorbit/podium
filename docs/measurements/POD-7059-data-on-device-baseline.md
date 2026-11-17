# Data on device: memory and startup baseline

The BEFORE numbers for the data on device design
([POD-7059](../design/POD-7059-data-on-device-design.md), "What must be measured"), taken
by POD-7099 before any build task landed, and the rerun that takes the AFTER numbers at
the end of the phase. This is a small baseline, not a study: it repeats the method of
[startup-baseline.md](startup-baseline.md) (POD-5594) on a different host with fewer
samples. Its numbers are not comparable with POD-5594's, which ran on flatblock.

## What was measured

| | |
| --- | --- |
| Product commit | `17d01cd9c5` (dev/mw, the base of `integrate/4286-data-on-device`) |
| Measured commit | `2288954cbb`: that product commit, the design doc and this issue's harness changes. Kept as `refs/measurements/7099-baseline` in the local repository; the landed commits are rebased copies |
| Product tree | `f84fc0ddd4b8…` (SHA-256 of `git ls-tree -r` over `apps/web/src`, `apps/mobile/src`, `apps/mobile/app`, `packages`), the same at `17d01cd9c5` and at the measured commit |
| Host | `vega-agents`, the vega agents VM: AMD EPYC 7351P, 16 vCPU, 62 GB RAM, no swap, Ubuntu 24.04 |
| Lock | `test:vega-agents`, held by `remote-lane` for each step, one short window per step |
| Browser | Chromium `148.0.7778.96` (Playwright 1.60's Chromium, new headless mode) |
| Builds | normal production builds at the measured commit: web `bundle+kIFZj9ke`, phone `bundle+1f8f5d3ca6b7f58204d51e14506d73fb`; wire version 5, schema digest `ab2434260cb311c8` |
| Corpus | seed 4443. `h1a1`: 4,867 issues, 4,304 sessions, 21,958 wire rows, rows SHA-256 `337b2cb6…f3acb`. `h10a1`: 27,601 issues, 30,611 sessions, 136,128 wire rows, `3e2b65eb…6cf98` |
| Date | 2026-11-17, 18:27–19:22 UTC |

The full record, with every sample, load reading, build stamp and capture path, is
[summary.json](POD-7059-data-on-device-baseline/summary.json).

### Client memory after a cold start

One cold start per surface and cell. The V8 heap is the app page's. "Renderer" is the
app's renderer process. "Browser" is the whole Chromium process tree. Values in MiB.

| Surface | Cell | Heap after GC | Heap before GC | Renderer RSS | Renderer PSS | Renderer peak RSS | Browser RSS |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Web | `h1a1` | 203.6 | 268.3 | 432.4 | 356.9 | 583.5 | 1,111.0 |
| Web | `h10a1` | 569.5 | 643.5 | 820.5 | 744.6 | 1,197.8 | 1,557.4 |
| Phone web | `h1a1` | 182.0 | 220.7 | 382.4 | 312.2 | 537.0 | 1,034.2 |
| Phone web | `h10a1` | 542.1 | 615.6 | 768.4 | 697.2 | 1,094.5 | 1,498.0 |

Ten times the history, with the same active work, multiplies the heap after GC by 2.8
(web) and 3.0 (phone) and adds about 390 MiB of renderer RSS. The spread did not call for
a second run. Two h1a1 captures taken earlier on the polaris VM (198.6 and 179.0 MiB heap
after GC, web and phone) are within 3% of these.

### First paint from an empty device, and warm start

Seconds from navigation to the first real Chromium Paint after a visible issue row. Three
cold/warm pairs per cell and surface. A cell's medians cover its admitted pairs only.

| Surface | Cell | Admitted pairs | Cold, median (min–max) | Warm, median (min–max) | Cold samples | Warm samples |
| --- | --- | ---: | ---: | ---: | --- | --- |
| Web | `h1a1` | 3 of 3 | 5.81 (5.75–5.84) | 4.12 (4.11–4.56) | 5.81, 5.84, 5.75 | 4.11, 4.56, 4.12 |
| Web | `h10a1` | 2 of 3 | 18.64 (18.48–18.81) | 13.57 (13.23–13.91) | 18.48, 18.81 | 13.23, 13.91 |
| Phone web | `h1a1` | 3 of 3 | 5.89 (5.86–6.06) | 4.78 (4.47–4.93) | 5.86, 5.89, 6.06 | 4.78, 4.47, 4.93 |
| Phone web | `h10a1` | 2 of 3 | 17.95 (17.31–18.59) | 14.47 (14.33–14.62) | 18.59, 17.31 | 14.33, 14.62 |

Ten times the history raises the cold median from 5.81 to 18.64 s (web) and from 5.89 to
17.95 s (phone).

The third `h10a1` pair was rejected on both surfaces. In each, the client logged a socket
heartbeat timeout ("socket closed — reconnecting", `cause=heartbeat-timeout`,
`silentForMs=10000`), then reconnected and logged one failed resource load (404). On
phone this happened about 0.5 s before the cold Paint; on web, about 60 ms after it. The
pairs' values (web cold 18.70, warm 13.41; phone cold 18.41, warm 13.76) are in line with
the others but are not in the medians. The rule is POD-5594's: a reconnect invalidates
the pair. The cause, ten seconds without a heartbeat while 136,128 rows are applied, is
itself a data point for the design's "main-thread time spent applying the feed".

### Server side of the first download

Not measured; see "Not measured" below.

## Method

Everything runs on the VM, inside the checkout `remote-lane` makes
(`~/podium-test-<issue>`), through one driver,
[`apps/web/harness/data-on-device-baseline.py`](../../apps/web/harness/data-on-device-baseline.py).
Its steps are separate `remote-lane` calls, so the host lock is held for one short window
at a time (here 4 to 13 minutes) and released in between for other lanes:

- `prepare` installs Playwright's Chromium. On a VM without Chromium's system libraries
  (vega has none, and no sudo), it unpacks the Ubuntu packages into
  `~/.cache/podium-chromium-deps` with `apt-get download` and `dpkg -x`. Every capture
  records the library path it used (`browserLibraryPath`). It then builds `podium-host`
  from the vendored crate (the lane PATH has no cargo), makes the two production client
  builds and writes both corpus cells.
- `memory` runs one cold start per surface and cell (`cold-start.mjs --mode=memory`). A
  fresh browser context opens the production client and waits for the first visible issue
  row and for the complete corpus in IndexedDB. After 2 s it records the page's V8 heap
  (`Runtime.getHeapUsage`) before and after two forced collections, and `VmRSS`, `VmHWM`
  and `Pss` from `/proc` for every Chromium process the collector started.
- `timing` runs `startup-baseline.py`, which interleaves the cells (a rotating order, then
  its reverse) with one collector process tree alive at a time. Each collector runs one
  cold navigation and its warm reload. Cold is a fresh browser context; warm reloads it
  with the committed IndexedDB rows and preferences. The boundary is the first Chromium
  Paint after a visible, unobscured issue row, with the boot splash gone
  (`browser-paint.ts`). Web uses an 1800 × 1000 viewport. Phone is the production phone
  **web** client's Work tab at Playwright's Pixel 7 preset. Request routing disables the
  HTTP cache on both.
- `report` writes `.artifacts/7099/summary-r<round>.{json,md}` on the host. Each pair must
  pass `cold-start-guard.py`'s checks: complete, unprofiled, the full corpus durable before
  the reload, no unexpected browser errors, one cohort, host, lock, corpus, Chromium and
  collector. A rejected pair is listed with its reason and values.

These memory figures are the production clients' whole page, not an isolated pool. The
pool fixture of `pool-memory.ts` (POD-5133) compares a legacy arm that no longer exists.
`PODIUM_STARTUP_MEMORY=1` reports the Bun process of the no-wrong-number test, not a
client.

### Harness changes for the agent VMs

- `measure_hosts.py` lists the hosts and their locks, the same as `remote-lane`'s (vega:
  `test:vega-agents`, polaris: `test:polaris-agents`). `startup-baseline.py` and
  `cold-start-pair.py` take `--host` and `--lock`, plus `--local` (already on the host) and
  `--lock-held` (the caller, such as `remote-lane`, holds the lock). The default host is
  vega. `startup-baseline.py` also takes several checkouts and interleaves their cells in
  one schedule.
- `cold-start.mjs`: `--host` and `--lease` name the host and its lock, since both VMs
  report the hostname `agents`. `--mode=memory` records the memory above. Chromium is
  Playwright's own, unless flatblock's pinned build or `PODIUM_CHROMIUM` is present.
- `cold-start-guard.py` admits a `bench:` or `test:` timing lock on any named host, never
  mixing hosts or locks in one comparison. The minimum sample count comes from the ledger.
- `flatblock-budget.py` runs on any host. Its swap floor applies only where there is swap.
- `old-vs-new-corpus.mjs` drops the acceptance seed's `checkout`, `pin` and
  `machineAccess` rows, which the sync wire no longer carries (527 rows per cell). The
  wire row counts that remain equal POD-5594's.

The report code was revised after these captures: it now admits each pair on its own,
and `--memory-round` was added. The collector, `cold-start.mjs`, is the one that took
the captures.

## Not measured

- **The server side of the first download** (bytes sent, time to the last bootstrap
  row). The harness does not report it: the collector assembles the bootstrap from the
  fixture rows inside Playwright's request routing, so the server never sends the corpus.
  No new instrument was built. For scale, the fixture's wire rows take 7.6 MB of JSON
  (`h1a1`) and 47.6 MB (`h10a1`).
- The native iOS and Android apps, transcript search, the main-thread time spent applying
  the feed, the cache cap, the first flight deck open, and server search at ten times the
  history. The harness cannot measure any of them on the VM without new tooling.
- Cells `h1a4` and `h10a4`, which the brief does not name.

Earlier attempts are kept as a record. On the polaris VM, prepare and the first two memory
captures ran before the coordinator moved the baseline to vega; their numbers are not
part of this baseline. On vega, memory round 1 failed before measuring anything
(`podium-host` was missing), so the memory captures are round 2 and the timing captures
round 1.

## The AFTER run

Run it on **the same host (vega)** from the candidate's issue checkout, once the phase's
build tasks have landed on `integrate/4286-data-on-device`. The base and the candidate are
measured side by side, in one interleaved schedule, so the host's drift cancels. The base
is `17d01cd9c5`, with the candidate's `apps/web/harness` and `apps/mobile/harness` laid
over it. Both arms run the same collector, and the base's product tree is exactly the one
measured here.

```sh
# From the candidate's issue worktree on ludovico; <issue> is that issue's number.
# Commit first: remote-lane pushes the committed HEAD. One remote-lane call at a time,
# and no commit between the calls (each build is stamped with the HEAD it measures).
R="python3 apps/web/harness/data-on-device-baseline.py"
O="--host=vega --base=17d01cd9c5 --round=11"
LANE_LOCK_TTL=40m LANE_TIMEOUT=2400 remote-lane vega <issue> run $R prepare $O
LANE_LOCK_TTL=40m LANE_TIMEOUT=2400 remote-lane vega <issue> run $R memory $O
LANE_LOCK_TTL=40m LANE_TIMEOUT=2400 remote-lane vega <issue> run $R timing --surface=web $O
LANE_LOCK_TTL=40m LANE_TIMEOUT=2400 remote-lane vega <issue> run $R timing --surface=phone $O
remote-lane vega <issue> run $R report $O --product-base=17d01cd9c5
remote-lane vega <issue> run $R clean $O
```

`--base` checks the base out at `~/podium-test-<issue>-base`, beside the candidate's
checkout, and every step then covers both. The report keys the arms
`podium-test-<issue>-base/<cell>` and `podium-test-<issue>/<cell>`, and states whether the
product base's tree equals a measured tree, which should be true for the base arm only.
In this baseline, one surface's six pairs took 13 minutes of lock time. With two
checkouts, a timing step holds the lock for about 26 minutes. Round numbers are never
reused: captures are not overwritten. The report prints the Markdown tables and a
`SUMMARY_JSON` line.

Without `--base`, the same commands measure the current checkout alone, as here. `all`
runs every step in one call; use it only on an otherwise idle host, since it holds the
lock for the whole run.
