# Client cache caps and startup

**Measurement in progress; no update-safety conclusion yet.** The user-facing comparison must lead with cold and warm first paint for phone and web at today's history and ten-times history, followed by peak renderer memory. Those final interleaved captures are pending. Do not treat an incomplete series or a single sample as a release result.

The scoped Podium relay stopped answering before the second corrected cache window on 2026-11-18. Inbox reads and the required measurement-host lock timed out; the next workload did not start. Completed SQLite and feed samples are retained below. Application startup, peak memory, first deck opening, operator search, the rest of the corrected cache sweep, and final validation remain open. This issue is not READY.

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

## What a user will feel

| Surface | History | Cold first paint, before → after | Warm first paint, before → after | Peak renderer memory, before → after |
| --- | --- | --- | --- | --- |
| Phone proxy | x1 | Pending | Pending | Pending |
| Phone proxy | x10 | Pending | Pending | Pending |
| Web | x1 | Pending | Pending | Pending |
| Web | x10 | Pending | Pending | Pending |

The same cold/warm/peak captures are also required on the operator-sized set and for the desktop-renderer empty-device first paint. A fresh browser context provides empty application storage; bootstrap routing disables HTTP caching. Warm is a retained-data reload after durable storage settles. The boundary is an actual Chromium Paint after the first visible issue row. Peak is the app renderer's `/proc` high-water RSS through cold bootstrap; retained V8 heap is sampled separately after settling and two forced collections. Fixture preparation time and collection fetch count/time are recorded so synthetic routing overhead cannot be mistaken for client work.

The old partial startup attempt is excluded: it did not finish the requested series and its deck probe watched a collapsed flight deck. The corrected collector expands the deck and preserves the server's collection/stage order. A separate deck series prevents a deck-selector failure from invalidating startup pairs.

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

## Cache policy — corrected sweep incomplete

Candidate starting caps remain phone **1,000**, browser **5,000**, desktop **10,000 full cached records**. Policy rows, compact issue stubs and open views are excluded; bodies and companions count, and eviction trims complete instances. Proposed incremental allowances for this fixture are 8 / 32 / 64 MiB. These are recommendations to evaluate, not agreed native-memory budgets or byte limits: arbitrarily large bodies can exceed them.

The first 10 corrected cases below include the complete companion rows certified by every marker. They are **one sample per setting**, not accepted medians/spreads. The previous provisional three-sample sweep is superseded because it certified companion markers without all corresponding full rows. The remaining 20 scheduled cases are pending.

| Client | Cache cap | Retained fixture heap MiB, one sample | Increment over zero cap | Trim ms |
| --- | ---: | ---: | ---: | ---: |
| phone | 0 | 42.50 | 0.00 | 155.80 |
| phone | 500 | 43.95 | 1.45 | 160.10 |
| phone | 1,000 | 45.32 | 2.83 | 178.90 |
| phone | 2,000 | 48.13 | 5.63 | 208.10 |
| browser | 0 | 60.48 | 0.00 | 227.80 |
| browser | 2,500 | 69.29 | 8.81 | 271.00 |
| browser | 5,000 | 76.16 | 15.68 | 341.10 |
| desktop | 0 | 60.50 | 0.00 | 226.90 |
| desktop | 5,000 | 76.16 | 15.65 | 313.00 |
| desktop | 10,000 | 90.05 | 29.54 | 443.00 |

Round 28 source: `56ffd62844394cc2480d42292d1469db68a7656a`. The real memory store, trim, facade, row source and model pool remain reachable during two forced collections. The core includes ten-times-history stubs and policy rows; cache issues carry distinct 2 KiB briefs. These are data-layer retained V8 bytes, not whole-page, peak RSS or native totals. The final recommendations must use the completed spread and whole-page memory together.

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
