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

Final product `af8b3091e0` (POD-7119 feed apply and POD-7122 cold paint) against `17d01cd9c5`, matched collector and corpus within each surface, three scheduled interleaved samples per arm/cell on one authorized VM. POD-7148 is outside this fixed tip. This replaces the earlier interim observations; they remain in [the interim appendix](POD-7095-cache-cap-and-phone-memory/interim-startup.md) and raw artifacts.

| Surface | Population | Cold first paint s, before → after | Warm first paint s, before → after | Peak renderer RSS MiB, before → after |
| --- | --- | --- | --- | --- |
| Phone web proxy | 1x | 6.22 (6.18–6.42) → 5.22 (4.99–5.85) | 5.46 (5.45–5.53) → 4.55 (3.83–4.63) | 553.0 (549.8–553.1) → 508.1 (504.6–509.0) |
| Phone web proxy | 10x | 18.86 (18.82–19.28) → 5.91 (5.83–6.05) | 14.85 (14.46–15.34) → 5.14 (4.77–5.44) | 1106.3 (1085.2–1118.2) → 556.3 (553.9–558.7) |
| Phone web proxy | Operator-sized | 8.40 (8.25–8.52) → 4.90 (4.83–5.16) | 7.92 (7.35–7.95) → 4.50 (4.28–4.69) | 737.5 (702.8–747.1) → 510.5 (507.4–541.2) |
| Web | 1x | 6.15 (6.00–6.19) → 7.00 (6.59–7.13) | 4.99 (4.69–5.03) → 5.64 (5.39–5.73) | 582.0 (581.4–588.4) → 599.8 (591.2–603.5) |
| Web | 10x | 20.58 (19.15–21.59) → 7.95 (7.93–8.71) | 14.82 (14.37–15.25) → 6.19 (6.11–6.36) | 1093.0 (1073.2–1105.0) → 653.4 (623.2–786.5) |
| Web | Operator-sized | 7.97 (7.78–8.95) → 6.49 (6.13–6.63) | 6.00 (5.64–6.20) → 5.11 (4.77–5.18) | 780.6 (639.4–791.0) → 594.2 (582.7–596.1) |
| Desktop renderer proxy | 1x | 6.13 (6.06–6.23) → 6.83 (6.46–6.98) | 4.79 (4.63–5.09) → 5.30 (5.14–5.35) | 580.5 (580.5–581.9) → 603.9 (578.1–612.5) |
| Desktop renderer proxy | 10x | 19.14 (19.05–19.24) → 7.70 (7.67–7.99) | 14.53 (14.40–14.65) → 5.83 (5.82–6.22) | 1202.0 (1196.5–1207.6) → 640.4 (629.8–658.5) |
| Desktop renderer proxy | Operator-sized | 8.01 (7.61–8.43) → 6.29 (6.04–6.34) | 6.09 (5.88–6.15) → 4.93 (4.84–5.15) | 787.7 (781.5–792.8) → 589.4 (579.0–606.2) |

| Surface | Population | Heap after GC MiB, before → after | Renderer RSS MiB, before → after |
| --- | --- | --- | --- |
| Phone web proxy | 1x | 182.1 (182.1–182.3) → 127.1 (127.1–127.2) | 390.6 (390.2–391.3) → 332.7 (331.7–333.3) |
| Phone web proxy | 10x | 542.2 (542.2–542.3) → 133.3 (133.3–133.3) | 775.6 (771.9–775.7) → 347.6 (346.9–348.9) |
| Phone web proxy | Operator-sized | 284.1 (269.9–284.1) → 120.5 (120.5–120.5) | 516.5 (495.4–516.6) → 326.7 (326.0–330.9) |
| Web | 1x | 203.6 (203.5–203.6) → 190.4 (190.4–190.4) | 437.3 (437.2–439.3) → 426.6 (425.9–427.8) |
| Web | 10x | 569.4 (569.4–569.5) → 195.8 (195.7–196.4) | 816.6 (816.2–818.7) → 443.9 (442.7–445.4) |
| Web | Operator-sized | 292.4 (292.4–294.1) → 176.8 (176.8–176.9) | 547.2 (543.9–547.3) → 410.8 (408.7–410.8) |
| Desktop renderer proxy | 1x | 203.6 (203.5–203.6) → 190.4 (190.3–190.4) | 437.0 (436.5–437.9) → 425.2 (424.5–426.9) |
| Desktop renderer proxy | 10x | 569.3 (569.2–569.4) → 195.9 (195.8–195.9) | 821.9 (816.0–827.9) → 441.9 (441.3–445.3) |
| Desktop renderer proxy | Operator-sized | 292.4 (292.4–292.4) → 176.8 (176.7–176.9) | 544.9 (544.3–547.2) → 409.6 (408.5–410.6) |

| Surface | Population | Cold CPU s, before → after | Warm CPU s, before → after | Collection resources begun before cold Paint, before → after | Summed fetch duration s, before → after |
| --- | --- | --- | --- | --- | --- |
| Phone web proxy | 1x | 5.53 (5.44–5.67) → 4.28 (4.15–4.90) | 4.84 (4.68–4.89) → 3.96 (3.26–3.98) | 0 (0–0) → 1 (1–1) | 0.00 (0.00–0.00) → 0.07 (0.06–0.07) |
| Phone web proxy | 10x | 16.16 (16.16–16.46) → 4.76 (4.75–4.97) | 12.87 (12.68–12.87) → 4.36 (4.03–4.57) | 0 (0–0) → 1 (1–1) | 0.00 (0.00–0.00) → 0.09 (0.07–0.09) |
| Phone web proxy | Operator-sized | 7.47 (7.35–7.54) → 4.04 (4.02–4.32) | 7.14 (6.55–7.19) → 3.86 (3.65–4.00) | 0 (0–0) → 1 (1–1) | 0.00 (0.00–0.00) → 0.08 (0.07–0.09) |
| Web | 1x | 5.68 (5.49–5.72) → 6.21 (5.92–6.37) | 4.57 (4.27–4.58) → 5.10 (4.77–5.18) | 0 (0–0) → 0 (0–0) | 0.00 (0.00–0.00) → 0.00 (0.00–0.00) |
| Web | 10x | 17.44 (16.65–18.40) → 6.94 (6.82–7.51) | 13.17 (12.57–13.21) → 5.57 (5.43–5.58) | 0 (0–0) → 0 (0–0) | 0.00 (0.00–0.00) → 0.00 (0.00–0.00) |
| Web | Operator-sized | 7.23 (6.93–8.20) → 5.73 (5.42–5.83) | 5.42 (5.04–5.57) → 4.55 (4.27–4.69) | 0 (0–0) → 0 (0–0) | 0.00 (0.00–0.00) → 0.00 (0.00–0.00) |
| Desktop renderer proxy | 1x | 5.63 (5.56–5.64) → 6.16 (5.81–6.27) | 4.42 (4.19–4.65) → 4.77 (4.70–4.78) | 0 (0–0) → 0 (0–0) | 0.00 (0.00–0.00) → 0.00 (0.00–0.00) |
| Desktop renderer proxy | 10x | 16.46 (16.37–16.55) → 6.72 (6.68–6.96) | 12.90 (12.78–13.01) → 5.07 (5.06–5.32) | 0 (0–0) → 0 (0–0) | 0.00 (0.00–0.00) → 0.00 (0.00–0.00) |
| Desktop renderer proxy | Operator-sized | 7.30 (6.91–7.73) → 5.65 (5.39–5.66) | 5.57 (5.27–5.59) → 4.39 (4.31–4.58) | 0 (0–0) → 0 (0–0) | 0.00 (0.00–0.00) → 0.00 (0.00–0.00) |

| Surface | Population | Cold collection replies through reload, before → after | Summed cold route elapsed s, before → after | Fixture augmentation s, before → after |
| --- | --- | --- | --- | --- |
| Phone web proxy | 1x | 0 (0–0) → 3 (3–3) | 0.00 (0.00–0.00) → 0.18 (0.17–0.20) | 0.00 (0.00–0.00) → 0.01 (0.01–0.01) |
| Phone web proxy | 10x | 0 (0–0) → 3 (3–3) | 0.00 (0.00–0.00) → 0.20 (0.19–0.20) | 0.00 (0.00–0.00) → 0.01 (0.01–0.01) |
| Phone web proxy | Operator-sized | 0 (0–0) → 4 (3–4) | 0.00 (0.00–0.00) → 0.23 (0.18–0.24) | 0.00 (0.00–0.00) → 0.01 (0.01–0.01) |
| Web | 1x | 0 (0–0) → 1 (1–1) | 0.00 (0.00–0.00) → 0.13 (0.11–0.16) | 0.00 (0.00–0.00) → 0.01 (0.01–0.01) |
| Web | 10x | 0 (0–0) → 1 (1–1) | 0.00 (0.00–0.00) → 0.13 (0.12–0.13) | 0.00 (0.00–0.00) → 0.01 (0.01–0.02) |
| Web | Operator-sized | 0 (0–0) → 1 (1–1) | 0.00 (0.00–0.00) → 0.13 (0.12–0.19) | 0.00 (0.00–0.00) → 0.01 (0.01–0.01) |
| Desktop renderer proxy | 1x | 0 (0–0) → 1 (1–1) | 0.00 (0.00–0.00) → 0.12 (0.09–0.12) | 0.00 (0.00–0.00) → 0.01 (0.01–0.01) |
| Desktop renderer proxy | 10x | 0 (0–0) → 1 (1–1) | 0.00 (0.00–0.00) → 0.15 (0.13–0.16) | 0.00 (0.00–0.00) → 0.02 (0.01–0.02) |
| Desktop renderer proxy | Operator-sized | 0 (0–0) → 1 (1–1) | 0.00 (0.00–0.00) → 0.13 (0.11–0.15) | 0.00 (0.00–0.00) → 0.00 (0.00–0.01) |

All startup and memory cells use round 40, with no cross-cohort pooling. All 36 phone/web captures and 17 of 18 desktop captures passed admission; desktop 10x before has two admitted controls, with one unexplained HTTP 404 excluded and retained in raw evidence. The phone and desktop are Chromium renderer proxies, excluding native phone/SQLite bridge and Tauri startup. Empty application storage, disabled HTTP cache; warm follows durable storage. Peak includes population verification and settling; retained V8 heap follows two forced collections. The final series, admission counts, commit and corpus digests, fetch attribution, cache caps, SQLite blocking startup and limitations are in [the measurement report](POD-7095-cache-cap-and-phone-memory.md). New results are not pooled with the older host or product.
