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

- `memory --heap-timeline` (POD-7115) also records, from navigation to the forced
  collection, the page's V8 heap and every renderer's RSS every 250 ms, and a V8 sampling
  heap profile per phase (start, IndexedDB count, settle, collection) that keeps objects
  later collected, so garbage counts too. `heap-timeline.md` beside `run.json` gives the
  peaks, the sync requests with their times, and the allocating code by frame, resolved
  through the build's hidden source maps. `--cells` and `--surfaces` limit the step to
  named cells and surfaces. The heap "before GC" in the table is one sample 2 s after the
  corpus is durable, not a peak; the timeline's peak is.

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

**Interim at `726a06ad16`: cold-paint and feed regressions do not clear the live update.** These observations compare base `17d01cd9c530eb22d902b352837cbfc9eb5a15a3` with product `726a06ad16f676c58fab051e477b0f1e18a92c7d`, plus measurement-only commits. The coordinator stopped the web cohort at 12/18 pairs while POD-7119 and POD-7122 prepare their product fixes. One final phone/web startup series against the fixed tip will replace this interim for the operator’s update decision.

Values are median (minimum–maximum), in seconds for Paint and MiB for memory. Both arms are interleaved on each cohort’s single authorized VM. Phone uses the BEFORE host (VM A); web uses added capacity (VM B), as directed by the coordinator. Historical BEFORE tables above stay unchanged.

| Surface | Population | Cold Paint, before → after | Warm Paint, before → after | Peak renderer RSS, before → after |
| --- | --- | --- | --- | --- |
| Phone web proxy (VM A) | `h1a1` | 6.16 (6.02–6.16) → 17.70 (15.08–17.72) | 5.35 (5.11–5.89) → 4.35 (4.34–4.70) | 537.3 (534.1–540.4) → 576.4 (571.4–583.1)‡ |
| Web (VM B) | `h1a1` | 5.71 (5.60–5.82) → 36.89 (35.21–38.57) | 4.78 (4.65–4.91) → 5.43 (5.25–5.62) | 581.2 (579.8–582.6) → 551.9 (437.7–666.0) |
| Phone web proxy (VM A) | `h10a1` | 18.25 (one admitted sample) → 31.04 (30.64–34.27) | 13.94 (one admitted sample) → 4.94 (4.78–6.74) | 1112.6 (one admitted sample) → 624.2 (585.3–628.5)‡ |
| Web (VM B) | `h10a1` | 18.69 (18.26–19.11) → 57.44 (49.85–65.04) | 14.44 (13.97–14.91) → 5.87 (5.67–6.06) | 1123.3 (1084.3–1162.2) → 621.8 (564.2–679.4) |
| Phone web proxy (VM A) | `operator` | 8.10 (8.01–9.30) → 16.05 (15.94–16.52) | 7.41 (7.38–7.43) → 4.22 (4.15–4.25) | 745.7 (737.8–773.9) → 578.6 (575.2–579.6)‡ |
| Web (VM B) | `operator` | 7.93 (7.83–8.03) → 33.41 (32.37–34.44) | 5.88 (5.81–5.94) → 4.98 (4.94–5.03) | 771.1 (768.0–774.2) → 621.0 (597.5–644.5) |

| Surface | Population | Retained heap after GC MiB, before → after | Admitted pairs before / after |
| --- | --- | --- | --- |
| Phone web proxy (VM A) | `h1a1` | 182.1 (182.0–182.2) → 131.5 (131.4–132.3)‡ | 3/3 / 3/3 |
| Web (VM B) | `h1a1` | 203.6 (203.5–203.6) → 197.1 (197.0–197.3) | 2/2 / 2/2 |
| Phone web proxy (VM A) | `h10a1` | 542.1 (one admitted sample) → 137.0 (137.0–137.6)‡ | 1/3 / 3/3 |
| Web (VM B) | `h10a1` | 569.1 (568.9–569.4) → 202.4 (202.3–202.4) | 2/2 / 2/2 |
| Phone web proxy (VM A) | `operator` | 284.1 (283.9–284.3) → 124.3 (124.3–124.4)‡ | 3/3 / 3/3 |
| Web (VM B) | `operator` | 292.3 (292.3–292.3) → 182.8 (182.7–182.8) | 2/2 / 2/2 |

‡ Earlier phone-after memory is retained **only as limited observations**: a malformed synthetic-only collection envelope caused retries. POD-7122 repaired the fixture and found phone x1 cold Paint unchanged in its diagnostic (17.44 → 17.48 s); the old phone collection counts and CPU attribution are excluded. The coordinator directed no corrected memory recapture on this old product. Corrected web captures use the repaired fixture in both arms. Two original before phone x10 captures failed admission after heartbeat reconnects; they remain in the evidence and out of these medians.

The collector records an actual Chromium Paint after an unobscured visible issue row. Cold uses fresh application storage; warm retains the durable corpus, with HTTP caching disabled on both. Memory follows durable-population verification, settling and two forced collections before warm reload, unlike the historical timing-only captures. Peak RSS includes the verification probe reading rows in the page. These are instrumented Chromium renderer proxies, not native-phone or Tauri measurements.

The [complete measurement report](POD-7095-cache-cap-and-phone-memory.md) contains collection/resource timings, retained RSS, source/fixture digests, all exclusions, cache caps, feed/storage CPU and synchronous SQLite block. Its [public sample summary](POD-7095-cache-cap-and-phone-memory/summary.json) retains each attempt. Complete ledgers and operational host details are private issue artifacts.

Use `apps/web/harness/data-on-device-baseline.py` through `remote-lane` on the authorized VM, from committed source. Run `prepare --host="$measurement_vm" --base=17d01cd9c5 --cells=h1a1,h10a1,operator`, then `timing` on one surface with a fresh `--round`, `--samples=3 --measure-memory --max-pairs=6`; resume that same schedule in short windows. Each call releases its host lease. Read both the issue inbox and session-addressed thread inbox before every call. The final fixed-tip cohort has not run yet.
