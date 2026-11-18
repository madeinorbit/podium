# Client cache caps and startup

**Draft: the phone startup series is complete; web, desktop renderer, deck, operator search and final validation remain open. The measured phone cold-start regression does not clear the live update.** Phone x1 cold paint rises from 6.16 to 17.70 s and peak renderer RSS from 537.3 to 576.4 MiB; warm paint improves from 5.35 to 4.35 s. Before phone x10 has only one admitted pair because two reconnect; its spread remains unresolved.

## What a user will feel

Values are median (minimum–maximum). Paint is in **seconds** and peak renderer RSS in **MiB**. Each cell schedules three interleaved cold/warm pairs per arm; the exact admitted/rejected counts are below.

| Surface | History | Cold first paint, before → after | Warm first paint, before → after | Peak renderer memory, before → after |
| --- | --- | --- | --- | --- |
| Phone web proxy | x1 | 6.16 (6.02–6.16) → 17.70 (15.08–17.72) | 5.35 (5.11–5.89) → 4.35 (4.34–4.70) | 537.3 (534.1–540.4) → 576.4 (571.4–583.1) |
| Phone web proxy | x10 | 18.25 (one admitted sample) → 31.04 (30.64–34.27) | 13.94 (one admitted sample) → 4.94 (4.78–6.74) | 1112.6 (one admitted sample) → 624.2 (585.3–628.5) |
| Web | x1 | Pending → Pending | Pending → Pending | Pending → Pending |
| Web | x10 | Pending → Pending | Pending → Pending | Pending → Pending |

The operator-sized population and empty-device desktop renderer use the same series:

| Surface | Population | Cold first paint, before → after | Warm first paint, before → after | Peak renderer memory, before → after |
| --- | --- | --- | --- | --- |
| Phone web proxy | Operator-sized | 8.10 (8.01–9.30) → 16.05 (15.94–16.52) | 7.41 (7.38–7.43) → 4.22 (4.15–4.25) | 745.7 (737.8–773.9) → 578.6 (575.2–579.6) |
| Web | Operator-sized | Pending → Pending | Pending → Pending | Pending → Pending |
| Desktop renderer proxy | x1 | Pending → Pending | Pending → Pending | Pending → Pending |
| Desktop renderer proxy | x10 | Pending → Pending | Pending → Pending | Pending → Pending |
| Desktop renderer proxy | Operator-sized | Pending → Pending | Pending → Pending | Pending → Pending |

A fresh browser context supplies empty application storage. Warm is a retained-data reload after the cold corpus is durable; request routing disables HTTP caching on both. The boundary is an actual Chromium Paint after the first visible issue row and the boot splash disappears. Peak RSS includes cold navigation, durability verification and settling through the memory sample. The IndexedDB population probe itself reads the rows in the page, so these comparable instrumented peaks are not native-device or uninstrumented browser limits. Retained V8 heap is sampled after settling and two forced collections.

### Retained client memory

| Surface | Population | Heap after GC MiB, before → after | Renderer RSS MiB, before → after | Admitted pairs, before / after |
| --- | --- | --- | --- | --- |
| Phone web proxy | x1 | 182.1 (182.0–182.2) → 131.5 (131.4–132.3) | 392.1 (391.2–394.7) → 392.4 (382.0–392.7) | 3/3 / 3/3 |
| Phone web proxy | x10 | 542.1 (one admitted sample) → 137.0 (137.0–137.6) | 773.5 (one admitted sample) → 449.6 (433.5–451.2) | 1/3 / 3/3 |
| Web | x1 | Pending → Pending | Pending → Pending | Pending / Pending |
| Web | x10 | Pending → Pending | Pending → Pending | Pending / Pending |
| Phone web proxy | Operator-sized | 284.1 (283.9–284.3) → 124.3 (124.3–124.4) | 518.0 (517.9–518.3) → 377.7 (376.5–378.2) | 3/3 / 3/3 |
| Web | Operator-sized | Pending → Pending | Pending → Pending | Pending / Pending |
| Desktop renderer proxy | x1 | Pending → Pending | Pending → Pending | Pending / Pending |
| Desktop renderer proxy | x10 | Pending → Pending | Pending → Pending | Pending / Pending |
| Desktop renderer proxy | Operator-sized | Pending → Pending | Pending → Pending | Pending / Pending |

### Where startup time goes

These are renderer main-thread CPU time and completed collection resources that began before first paint. Fetch durations are summed across requests and overlap CPU and one another: **do not add the columns**. The route uses real local service answers augmented with the deterministic corpus; it does not time a production server sending that synthetic population. The second table records route augmentation overhead separately.

| Surface | Population | Cold CPU s, before → after | Warm CPU s, before → after | After fetches before cold Paint | After summed fetch time s |
| --- | --- | --- | --- | --- | --- |
| Phone web proxy | x1 | 5.39 (5.25–5.49) → 9.65 (9.53–9.92) | 4.79 (4.51–5.25) → 3.72 (3.71–4.07) | 57 (45–60) | 7.30 (5.96–7.65) |
| Phone web proxy | x10 | 15.44 (one admitted sample) → 15.05 (14.97–15.20) | 12.28 (one admitted sample) → 4.11 (4.02–4.12) | 130 (122–135) | 15.94 (15.71–16.87) |
| Web | x1 | Pending → Pending | Pending → Pending | Pending | Pending |
| Web | x10 | Pending → Pending | Pending → Pending | Pending | Pending |
| Phone web proxy | Operator-sized | 7.18 (7.11–7.84) → 9.37 (9.11–9.49) | 6.55 (6.54–6.71) → 3.61 (3.50–3.63) | 60 (60–63) | 6.19 (6.03–6.89) |
| Web | Operator-sized | Pending → Pending | Pending → Pending | Pending | Pending |
| Desktop renderer proxy | x1 | Pending → Pending | Pending → Pending | Pending | Pending |
| Desktop renderer proxy | x10 | Pending → Pending | Pending → Pending | Pending | Pending |
| Desktop renderer proxy | Operator-sized | Pending → Pending | Pending → Pending | Pending | Pending |

| Surface | Population | Cold collection replies through reload | Sum of cold route elapsed s | Cold fixture augmentation s | Bootstrap fixture augmentation s |
| --- | --- | --- | --- | --- | --- |
| Phone web proxy | x1 | 118 (99–120) | 15.95 (13.58–16.80) | 1.78 (1.56–1.85) | 0.15 (0.14–0.17) |
| Phone web proxy | x10 | 224 (207–226) | 31.55 (28.20–34.78) | 3.41 (3.15–3.42) | 0.39 (0.39–0.40) |
| Web | x1 | Pending | Pending | Pending | Pending |
| Web | x10 | Pending | Pending | Pending | Pending |
| Phone web proxy | Operator-sized | 132 (129–135) | 15.93 (14.24–16.72) | 1.50 (1.46–1.69) | 0.16 (0.15–0.18) |
| Web | Operator-sized | Pending | Pending | Pending | Pending |
| Desktop renderer proxy | x1 | Pending | Pending | Pending | Pending |
| Desktop renderer proxy | x10 | Pending | Pending | Pending | Pending |
| Desktop renderer proxy | Operator-sized | Pending | Pending | Pending | Pending |

Route replies are grouped by completion before the warm navigation, so a request straddling the reload belongs to the later interval. Complete per-resource timings, all raw samples and guard exclusions are retained in the issue artifacts. Both arms use the same collector and fixture bytes; only the controller changed to recover a saved complete pair after a teardown exit. Recovered pairs still pass the original admission guard.

Startup round 22 measured checkout commits: `009fd9776635602975d5c166b9cda7eb278d9821`, `17d01cd9c530eb22d902b352837cbfc9eb5a15a3`, `d182e3a9260b962eb2a71ee8eaeab595234b5337`. Product-tree digests: `8352ccf02e5c6ccb4b6d73dd1e5b9278a5263be2183d6f169853e0fe8adbb146`, `f84fc0ddd4b8afa27550335ea67831074569e229afdf2a69382b042082479d04`.

Rejected timing pairs stay in the evidence and out of the medians:

- `phone/h10a1/before` at 2026-11-18T10:24:36.612Z: cold 17.99 s, warm 13.97 s; unexpected browser errors invalidate startup evidence.
- `phone/h10a1/before` at 2026-11-18T10:55:08.233Z: cold 19.37 s, warm 15.46 s; unexpected browser errors invalidate startup evidence.


## Scope and provenance

All builds and measurement workloads ran on an authorized, dedicated Linux agent VM under its shared host lock. None ran on the shared development host. Before is `17d01cd9c530eb22d902b352837cbfc9eb5a15a3` from `dev/mw`. After product is `726a06ad16f676c58fab051e477b0f1e18a92c7d`, the completed integration, now also landed on `dev/mw` by the operator. Later commits used by this issue change measurement harnesses and reports; the only server edit is a policy comment. No wire version or suggested optimization was changed.

The phone proxy is the production phone web client in Chromium plus the real synchronous mobile SQLite adapter under `bun:sqlite`. The coordinator approved this because there is no native-device or simulator baseline for this phase. Desktop is the production web renderer using the desktop server policy, excluding Tauri startup. These results do not claim physical-phone, native SQLite bridge, disk-cold device or desktop-shell performance.

Seed 4443 produces `h1a1` (4,867 issues / 4,304 sessions / 21,958 wire rows) and `h10a1` (27,601 / 30,611 / 136,128), with active work fixed. The deterministic operator-sized set contains 8,687 issues / 6,941 sessions / 37,261 wire rows and disjoint 12-issue and 970-issue trees (9 and 922 closed). It matches populations, not the operator's text distribution, and never reads a live operator database. Its bodies are the existing corpus's short synthetic bodies; the cache sweep separately adds unique 2 KiB briefs.

| Input | Wire rows SHA-256 |
| --- | --- |
| h1a1 | `337b2cb6913d6906fd59e5e9520110e66555773b281b892caa43a73b9a1f3acb` |
| h10a1 | `3e2b65eb81e99dd4cbabe41a150f986337ccfa26fe107c87b7d540bc3746cf98` |
| operator | `ebc9141d0eb7a37c3015d978fea4f482e3a6f17ed8b7379ff06f6a23aabe1105` |

Completed comparisons below use three interleaved samples per arm and cell, retaining every scheduled sample. Values are median (minimum–maximum), in milliseconds unless stated otherwise. The VM uses Chromium 148.0.7778.96. Interleaved means the schedule rotates/reverses arms on the same VM; it does not run them concurrently. Three samples describe the observed range, not a tail-latency guarantee.


## First feed and browser storage

The real IndexedDB adapter and replica receive the **same 100 sidebar issue updates** in every arm. The before engine has no per-client policy, so one full-history before arm is shared by the three policy candidates. The initial static policy projection is held fixed throughout this series; this is the first delta after that projection, not warmed steady-state feed throughput and not the cost of updating mounted UI models. Initial database population, model setup and settling are outside the timed region.

`receive` is replica application wall time; `durable wait` is the subsequent asynchronous settle wall time. `storage submit` sums synchronous IndexedDB put/delete/clear submissions on the main thread. `main thread` is Chromium's thread task time across parsing, application and durability; the columns overlap and must not be added. The setup may have an adapter backlog; the ledger keeps its full settle time. Each received result and durable cursor/title is checked.

| Corpus | Arm | Parse | Receive | Durable wait | Storage submit | Main thread |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| h1a1 | Before, all clients | 0.90 (0.60–1.10) | 8.80 (6.40–11.20) | 18.40 (8.50–60.70) | 5.90 (3.80–7.40) | 16.34 (10.96–18.38) |
| h1a1 | After, phone | 1.30 (1.30–1.40) | 52.30 (50.70–52.60) | 101.60 (85.30–114.20) | 3.60 (3.40–6.20) | 59.70 (58.78–61.42) |
| h1a1 | After, browser | 1.30 (0.90–1.50) | 87.90 (81.10–88.50) | 108.50 (96.70–112.50) | 4.10 (4.10–4.20) | 154.10 (151.02–156.77) |
| h1a1 | After, desktop | 1.30 (1.30–1.50) | 91.80 (81.40–105.30) | 99.60 (96.10–129.00) | 3.80 (3.60–5.70) | 162.58 (88.43–177.00) |
| h10a1 | Before, all clients | 1.10 (0.80–1.90) | 12.60 (11.20–13.50) | 257.10 (18.00–361.80) | 7.40 (7.20–9.60) | 22.39 (22.32–24.71) |
| h10a1 | After, phone | 1.40 (0.80–2.90) | 73.20 (66.20–110.60) | 195.60 (104.70–206.00) | 5.10 (4.70–6.80) | 162.54 (72.32–174.97) |
| h10a1 | After, browser | 1.40 (1.30–1.40) | 108.30 (98.80–127.50) | 218.50 (212.00–245.50) | 4.00 (3.80–4.60) | 153.21 (117.53–180.93) |
| h10a1 | After, desktop | 1.30 (0.70–2.20) | 117.90 (104.30–139.00) | 109.60 (91.60–200.60) | 4.60 (3.70–5.60) | 124.21 (110.23–144.02) |
| operator | Before, all clients | 0.80 (0.60–1.30) | 7.80 (5.70–17.60) | 144.40 (128.10–145.40) | 4.90 (3.40–13.10) | 14.29 (12.90–26.31) |
| operator | After, phone | 1.20 (0.50–1.30) | 53.50 (52.60–54.50) | 122.00 (103.70–147.50) | 4.00 (3.40–6.80) | 61.03 (60.83–67.46) |
| operator | After, browser | 1.20 (1.10–1.30) | 80.80 (80.30–84.80) | 123.30 (121.50–161.20) | 3.80 (3.60–5.10) | 146.88 (90.48–154.13) |
| operator | After, desktop | 1.20 (1.10–1.50) | 83.10 (82.90–92.80) | 90.80 (71.80–109.60) | 4.10 (3.70–4.20) | 154.81 (89.28–167.21) |

After source: `3afa48321d82c684c4682d7639d3825e2cd8e64c`; before source: `17d01cd9c530eb22d902b352837cbfc9eb5a15a3`. Round 26 is complete: 36 cases, with unchanged fixture source throughout. The update-ID digest is `994d22e96ea881e153690014672ee5e4587b00553d382a25319eb447977c7c8a` for both two-axis cells and `a8b7df58faadb372515af9abdc64e56edbdc97fe1ced35b6a042a72e8a4be9b0` for the operator set.

This is a regression in feed application CPU: for example phone x1 is 59.70 ms versus 16.34 ms, and phone x10 is 162.54 ms versus 22.39 ms. Smaller retained history has not made the first delta cheaper. This report records it without adding an optimization.

## Synchronous phone SQLite startup

This uses `packages/sync/src/adapters/mobile-sqlite/sql.ts` and the real `SqliteSyncStore`, with a timing wrapper around `bun:sqlite`. The startup blocking call is the synchronous portion of `SqliteSyncStore.open`, measured **before awaiting its returned promise**. It includes SQL, JSON decoding, mirror/index construction and the startup secret scrub. SELECT time is nested within the blocking call, not extra. Reopening uses a fresh adapter/connection with warm OS file caches.

The before fixture contains all wire rows; the after fixture is the static initial phone-policy projection. This isolates adapter costs from the browser app and does not replace whole-app/native-phone startup measurement. Initial durable write and a separate 100-row write are included for storage attribution.

| Corpus | Arm | Startup blocking call | SELECT inside startup | Initial durable write | 100-row durable write |
| --- | --- | ---: | ---: | ---: | ---: |
| h1a1 | Before | 160.56 (156.74–185.33) | 30.78 (30.65–31.87) | 622.27 (607.67–626.48) | 33.42 (32.66–45.27) |
| h1a1 | After | 113.57 (109.11–119.45) | 14.62 (14.47–15.17) | 414.46 (410.76–416.21) | 33.98 (33.93–40.55) |
| h10a1 | Before | 812.21 (804.18–820.20) | 149.47 (146.85–152.09) | 3370.07 (3236.97–3380.62) | 42.51 (32.77–43.48) |
| h10a1 | After | 339.19 (330.11–341.73) | 46.58 (45.91–48.51) | 1082.68 (1076.32–1126.98) | 35.96 (35.01–43.51) |
| operator | Before | 238.85 (238.12–256.75) | 42.65 (41.33–51.70) | 966.49 (962.60–984.15) | 26.42 (25.74–36.02) |
| operator | After | 148.28 (141.79–174.85) | 20.71 (18.54–22.92) | 513.77 (498.42–522.82) | 34.53 (34.47–38.84) |

Round 21 has 18 samples. After source: `ae42bf74fa6c955a23956bae6abb75f2b96a7e1a`; before source: `17d01cd9c530eb22d902b352837cbfc9eb5a15a3`. No native bridge or physical-device multiplier has been assumed. At x10 the measured synchronous block falls from 812.21 ms to 339.19 ms, still a visible app-thread stall if reproduced on-device.

## Cache policy

Recommended starting caps are phone **1,000**, browser **5,000**, desktop **10,000 full cached records**, matching the server policy. Policy rows, compact issue stubs and open views are excluded; bodies and companions count, and eviction trims complete instances. Proposed incremental cache allowances are **8 / 32 / 64 MiB** for this fixture. These are recommendations, not agreed native-memory budgets or byte limits: arbitrarily large bodies can exceed them.

The corrected sweep is complete: three interleaved samples per setting, all with the complete companion rows certified by every marker. The earlier provisional sweep is superseded because it certified markers without all corresponding full rows.

| Client | Cache cap | Retained fixture heap MiB | Increment over zero cap MiB | Trim ms |
| --- | ---: | ---: | ---: | ---: |
| phone | 0 | 42.46 (42.43–42.50) | 0.00 (0.00–0.00) | 157.70 (155.80–174.90) |
| phone | 500 | 43.95 (43.95–43.95) | 1.49 (1.45–1.52) | 160.10 (155.00–164.60) |
| phone | 1,000 | 45.34 (45.32–45.34) | 2.88 (2.83–2.90) | 178.90 (168.70–184.90) |
| phone | 2,000 | 48.08 (48.07–48.13) | 5.63 (5.62–5.64) | 208.10 (199.20–830.10) |
| browser | 0 | 60.47 (60.46–60.48) | 0.00 (0.00–0.00) | 266.20 (227.80–271.90) |
| browser | 2,500 | 69.30 (69.29–69.53) | 8.83 (8.81–9.07) | 271.00 (262.00–280.50) |
| browser | 5,000 | 76.15 (76.15–76.16) | 15.68 (15.68–15.69) | 341.10 (306.90–341.60) |
| desktop | 0 | 60.48 (60.48–60.50) | 0.00 (0.00–0.00) | 226.90 (213.90–237.90) |
| desktop | 5,000 | 76.16 (76.16–76.16) | 15.67 (15.65–15.69) | 308.20 (292.30–313.00) |
| desktop | 10,000 | 90.05 (90.03–90.16) | 29.55 (29.54–29.68) | 409.70 (375.50–443.00) |

Round 28 measured sources: `53bed5e07bd1b67b148a0c80dbf8359e8ad9f21c`, `56ffd62844394cc2480d42292d1469db68a7656a`. The harness digest is identical in all 30 cases. The real memory store, trim, facade, row source and model pool remain reachable during two forced collections. The core includes ten-times-history stubs and policy rows; cache issues carry distinct 2 KiB briefs. These are data-layer retained V8 bytes, not whole-page, peak RSS or native totals. Incremental values subtract the zero-cap sample in the same sample round.

## First flight deck and search

The pending first-opening series uses disjoint synthetic 12-issue and 970-issue trees on the operator-sized population, three interleaved cold pairs per arm/client. The tree starts unopened; sidebar/search preparation is outside the click-to-Paint region. No tree is preloaded. The measured click includes the actual loader fetch and completion of the visible deck boundary.

The two-axis server search service is byte-identical between the before and after products. The coordinator approved reuse of [POD-7089's search evidence](issue-search-7089.md), source `33f4ab4f16`, which contains 11 warm samples per query. This is shared unchanged-service evidence, not newly interleaved before/after application traffic. Its reported spread is p95 (largest of 11), as recorded in that report.

| Query | h1a1 median / p95 ms | h10a1 median / p95 ms |
| --- | ---: | ---: |
| No match | 35.5 / 37.7 | 196.4 / 201.9 |
| Specific title | 41.2 / 43.4 | 216.4 / 222.5 |
| Description | 42.1 / 43.0 | 230.4 / 240.4 |
| Unique brief | 30.3 / 31.0 | 160.2 / 164.8 |
| Broad title | 894.5 / 931.4 | 7433.8 / 8091.1 |

The broad query returns 3,253 / 18,426 hits; full normalization is included. The operator-sized before/after search series remains pending. No Postgres test, dependency or harness was added.

## Decisions requested by the design

No optimization in this table is implemented by this issue. A pending conclusion is not a “no”.

| Item | Current answer | Number and limit of the evidence |
| --- | --- | --- |
| Disk-only cache | Pending | Corrected caps have only one sample; whole-page peak memory is not captured yet. |
| Sync engine in a worker | Yes, investigation warranted | Phone first-feed CPU 59.70 / 162.54 ms at x1/x10; synchronous SQLite startup still 113.57 / 339.19 ms. This does not prove a worker alone fixes mounted UI or bridge costs. |
| Preload trees | Pending; none added | The 12/970 first-opening series is not captured yet. |
| Remaining startup index work | Pending | Need startup phase CPU/collection timing, rather than attributing elapsed time from feed data alone. |
| Re-run per-record memory work (POD-5157 / POD-5539 / POD-5952) | Pending | Need final retained/peak app memory and the completed full-companion cap sweep. |

## Rerun and finish

Follow [startup-baseline.md](startup-baseline.md) for admission and Paint boundaries. Use the authorized VM alias and host choice provided privately by the coordinator; never run these workloads on the shared development host. Every command goes through `remote-lane`, from a committed issue HEAD. Read the issue inbox before each call; only one call may be queued/running. The baseline product remains `17d01cd9c5`; the after product remains `726a06ad16` plus recorded harness-only commits, even though the operator has moved local `dev/mw`.

Set `measurement_vm` to the authorized VM choice. The completed corpora/builds already exist in the issue's isolated remote checkouts. Keep raw failed and partial rounds; use a fresh round for a changed hypothesis, or `--resume` only for the identical saved plan. Each window releases the VM lock when it exits.

```sh
# Refresh harnesses and certify or rebuild the production clients.
remote-lane "$measurement_vm" 7095 run python3 apps/web/harness/device-cost-series.py build --host="$measurement_vm"

# Finish the unchanged corrected cap plan, 10 cases per short lock window.
remote-lane "$measurement_vm" 7095 run python3 apps/web/harness/device-cost-series.py cache --host="$measurement_vm" --round=28 --max-cases=10 --resume
# Repeat once to reach 30/30 cases.

# Each surface uses 18 cold/warm pairs: three samples x three corpora x two arms.
# Run surfaces sequentially: phone, web, desktop. Resume twice per surface.
remote-lane "$measurement_vm" 7095 run python3 apps/web/harness/data-on-device-baseline.py timing --host="$measurement_vm" --base=17d01cd9c5 --round=22 --surface=phone --samples=3 --cells=h1a1,h10a1,operator --measure-memory --max-pairs=6
# Same arguments with --resume, then the next surface without --resume.

# Separate first-deck series: operator population contains both target trees.
remote-lane "$measurement_vm" 7095 run python3 apps/web/harness/data-on-device-baseline.py timing --host="$measurement_vm" --base=17d01cd9c5 --round=30 --surface=phone --samples=3 --cells=operator --decks --max-pairs=6
# Repeat sequentially for web and desktop.

remote-lane "$measurement_vm" 7095 run python3 apps/web/harness/device-cost-series.py search --host="$measurement_vm" --round=31
```

To reproduce completed adapter/feed evidence, use fresh round numbers with `device-cost-series.py sqlite` / `feed` (same cells, three samples, short `--max-cases` windows and `--resume`). Each ledger records the arm SHA, fixture digest, schedule, process and raw metrics. Feed checks use the same exact update-ID digest; the explicit empty async iterator avoids the separately filed bundling issue POD-7117.

After all implementation is frozen, run the single authorized final validation window through `remote-lane`: focused files `scripts/device-measurement.test.ts`, `scripts/cold-start-guard.test.ts`, `packages/sync/src/replica/holdings.test.ts` and `tests/worklist/harness/src/startup/no-wrong-number.test.ts`; run that last safety file at the other three two-axis cells with `PODIUM_STARTUP_CELL` set to `h10a1`, `h1a4`, `h10a4`; then the lean gate `bun run test`, sequentially. Use `bun run test:file -- <paths>`. One fix round and one focused rerun of exactly the failures are permitted. No validation result is claimed yet.

Raw SQLite round 21, feed round 26 and cache round 28 ledgers are retained in the private issue evidence workspace. The final report must replace the provisional artifacts, attach its completed evidence, update the AFTER section of [the phase baseline](POD-7059-data-on-device-baseline.md), rebase onto the integration tip, and send the coordinator one READY handoff. None of those completion steps is implied by this draft.
