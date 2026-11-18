# Client cache caps and startup

All startup and cold-memory samples use round 40. Each row compares its arms within one cohort. Final startup and memory compare product `af8b3091e0` with `17d01cd9c5`, three scheduled interleaved pairs per arm/cell on one authorized VM. POD-7119 and POD-7122 are included; POD-7148 is outside this fixed tip. Phone and desktop are renderer proxies.

## What a user will feel

Values are median (minimum–maximum). Paint is seconds; memory is MiB.

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

A new browser context supplies empty application storage; warm is a retained-data reload after cold data is durable. HTTP caching is disabled in both arms. The boundary is an actual Chromium Paint after an unobscured issue row and the boot splash disappearing. Three samples were scheduled per arm/cell. All 36 phone/web samples and 17 of 18 desktop samples passed admission; desktop 10x before has two admitted controls. Median and range use admitted captures only, and describe the observed spread, not a tail guarantee.

### Retained client memory

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

Peak RSS covers cold navigation, durable-population verification and settling through the memory sample, before the warm reload. The population probe reads rows in the page, so these comparable instrumented peaks are not uninstrumented or native-device limits. Retained V8 heap follows settling and two forced collections, between cold and warm in both arms. Compare warm with its new before controls, not the older timing-only baseline.

### Where startup time goes

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

| Surface | Population | Durable marker observed after cold Paint s, before → after |
| --- | --- | --- |
| Phone web proxy | 1x | 12.81 (12.50–13.29) → 10.78 (9.58–11.75) |
| Phone web proxy | 10x | 141.02 (134.30–164.14) → 21.13 (19.62–26.60) |
| Phone web proxy | Operator-sized | 36.43 (35.90–36.91) → 10.33 (10.01–10.92) |
| Web | 1x | 14.37 (13.99–15.19) → 23.98 (22.39–24.62) |
| Web | 10x | 158.69 (156.54–159.83) → 37.77 (28.52–39.45) |
| Web | Operator-sized | 38.32 (37.17–38.39) → 23.94 (17.93–24.13) |
| Desktop renderer proxy | 1x | 14.78 (14.55–14.89) → 25.63 (25.60–25.65) |
| Desktop renderer proxy | 10x | 147.98 (147.90–148.07) → 37.32 (36.50–37.58) |
| Desktop renderer proxy | Operator-sized | 38.48 (37.84–38.66) → 21.61 (15.29–24.46) |

CPU and fetch durations overlap and must not be added. Completed resources begun before Paint are sampled after the visible-row check; a request may finish after Paint, and unfinished requests are absent. Route totals cover replies completed before warm navigation. The real local server answers are augmented with deterministic rows, so these are not production-server synthetic-population throughput measurements. Fixture augmentation is reported separately. The durable marker observation is sampled by the post-Paint polling probe, not an exact commit timestamp, and includes probe/collector delay. Sync and IndexedDB timelines remain in the raw artifacts.

### Admission and provenance

- phone/h1a1/before: 3 admitted / 0 rejected.
- phone/h1a1/after: 3 admitted / 0 rejected.
- phone/h10a1/before: 3 admitted / 0 rejected.
- phone/h10a1/after: 3 admitted / 0 rejected.
- phone/operator/before: 3 admitted / 0 rejected.
- phone/operator/after: 3 admitted / 0 rejected.
- web/h1a1/before: 3 admitted / 0 rejected.
- web/h1a1/after: 3 admitted / 0 rejected.
- web/h10a1/before: 3 admitted / 0 rejected.
- web/h10a1/after: 3 admitted / 0 rejected.
- web/operator/before: 3 admitted / 0 rejected.
- web/operator/after: 3 admitted / 0 rejected.
- desktop/h1a1/before: 3 admitted / 0 rejected.
- desktop/h1a1/after: 3 admitted / 0 rejected.
- desktop/h10a1/before: 2 admitted / 1 rejected.
- desktop/h10a1/after: 3 admitted / 0 rejected.
- desktop/operator/before: 3 admitted / 0 rejected.
- desktop/operator/after: 3 admitted / 0 rejected.

Measured checkout commits: `17d01cd9c530eb22d902b352837cbfc9eb5a15a3`, `4fbaace5268fcfb6abc6a1977e248f52513acfda`, `c030eb8435702e4fa3663f5e57bcb94107edc185`. Product-tree SHA-256: `55857f26155f3cdc1555b322eaa73024bb413156ede33e2997ca7ba952c1bcca`, `f84fc0ddd4b8afa27550335ea67831074569e229afdf2a69382b042082479d04`. The production tree equals the specified arm. Within each surface, both arms share corpus, Chromium, collector and fixture bytes. Phone/web use collector checkout `4fbaace526`; desktop and operator search use `c030eb8435`, whose only runtime collector difference is a deck-control wait unused in startup. The saved schedule is resumed only at completed-pair boundaries; each short run releases its host lock.

Rejected captures are retained outside medians:

- r40/desktop/h10a1/before at 2026-11-18T19:04:34.365Z: unexpected browser errors invalidate startup evidence.

The old `726a06ad16` phone/web captures are [preserved separately](POD-7095-cache-cap-and-phone-memory/interim-startup.md). Phone memory there is limited observations after a retry-loop fixture fault; old phone CPU/request attribution is excluded. The final cohort uses the repaired synthetic-only envelope. Completed SQLite/feed/cache do not use that envelope.

## Scope and provenance

All builds and measurement workloads ran on an authorized, dedicated Linux agent VM under its shared host lock. None ran on the shared development host. Before is `17d01cd9c530eb22d902b352837cbfc9eb5a15a3` from `dev/mw`. The final startup, memory and operator-search product is `af8b3091e06e254d25809b66da8507a7e11d5478`. The earlier SQLite, cache and first-feed series measured the earlier policy product at `726a06ad16`; they are preserved rather than repeated. POD-7119's independent interleaved fixed-feed series qualifies the old first-feed regression below. Later commits used by this issue change measurement harnesses and reports; the only server edit is a policy comment. No wire version or suggested optimization was changed.

The phone proxy is the production phone web client in Chromium plus the real synchronous mobile SQLite adapter under `bun:sqlite`. The coordinator approved this because there is no native-device or simulator baseline for this phase. Desktop is the production web renderer using the desktop server policy, excluding Tauri startup. These results do not claim physical-phone, native SQLite bridge, disk-cold device or desktop-shell performance.

Seed 4443 produces `h1a1` (4,867 issues / 4,304 sessions / 21,958 wire rows) and `h10a1` (27,601 / 30,611 / 136,128), with active work fixed. The deterministic operator-sized set contains 8,687 issues / 6,941 sessions / 37,261 wire rows and disjoint 12-issue and 970-issue trees (9 and 922 closed). It matches populations, not the operator's text distribution, and never reads a live operator database. Its bodies are the existing corpus's short synthetic bodies; the cache sweep separately adds unique 2 KiB briefs.

| Input | Wire rows SHA-256 |
| --- | --- |
| h1a1 | `337b2cb6913d6906fd59e5e9520110e66555773b281b892caa43a73b9a1f3acb` |
| h10a1 | `3e2b65eb81e99dd4cbabe41a150f986337ccfa26fe107c87b7d540bc3746cf98` |
| operator | `ebc9141d0eb7a37c3015d978fea4f482e3a6f17ed8b7379ff06f6a23aabe1105` |

Three interleaved samples were scheduled per arm/cell; admission counts and the one desktop control exclusion are listed above. Every scheduled capture is retained. Values are median (minimum–maximum), in milliseconds unless stated otherwise. The VM uses Chromium 148.0.7778.96. Interleaved means the schedule rotates/reverses arms on the same VM; it does not run them concurrently. Three samples describe the observed range, not a tail-latency guarantee.


## First feed and browser storage

POD-7119 subsequently fixed held-instance index rebuilds and repeated cutoff evaluation. Reuse of its independent three-arm series avoids repeating the completed feed series. All values below are milliseconds, median (minimum–maximum), three interleaved samples on the same VM per arm/client. Sources: before `17d01cd9c5`; before fix `726a06ad16`; fixed `13d8d5e881` (same feed product as landed `4aa12ffe1a`, plus measurement-only changes). Update-ID digest matches this issue's completed series.

| History | Arm | Client | n | Receive (apply) | Parse | Durable wait | Storage submit | Checks | Cleanup | Main thread (all) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1x | Before phase (`17d01cd9c5`) | all clients | 3 | 11.60 (10.80–22.10) | 1.30 (1.20–1.40) | 111.20 (22.00–125.30) | 7.90 (7.40–16.00) | 0.80 (0.60–0.90) | 0.80 (0.70–1.00) | 19.41 (18.00–33.14) |
| 1x | Before fix (726a06ad16) | phone | 3 | 63.30 (61.00–79.20) | 1.20 (0.70–1.20) | 124.50 (66.30–131.80) | 3.90 (3.60–4.90) | 0.80 (0.70–0.90) | 1.00 (0.40–1.10) | 70.06 (61.42–84.71) |
| 1x | Before fix (726a06ad16) | browser | 3 | 102.00 (92.40–119.00) | 1.40 (1.30–1.50) | 100.90 (91.20–131.20) | 4.60 (3.50–6.30) | 0.80 (0.50–2.20) | 1.00 (1.00–1.10) | 164.03 (107.91–217.30) |
| 1x | After both fixes | phone | 3 | 22.80 (18.40–26.20) | 1.00 (0.70–1.00) | 164.80 (146.70–176.30) | 5.50 (5.00–8.60) | 0.50 (0.40–0.60) | 0.60 (0.60–0.70) | 31.21 (24.89–33.24) |
| 1x | After both fixes | browser | 3 | 30.70 (26.00–36.60) | 1.10 (0.70–1.40) | 150.00 (8.60–165.00) | 5.60 (4.70–8.20) | 0.60 (0.50–0.70) | 0.50 (0.40–0.80) | 36.37 (31.44–44.83) |
| 10x | Before phase (`17d01cd9c5`) | all clients | 3 | 14.10 (7.40–18.40) | 1.00 (0.90–1.30) | 322.20 (196.00–521.50) | 4.70 (4.60–9.40) | 1.40 (0.80–4.40) | 0.80 (0.40–1.10) | 23.45 (21.54–99.75) |
| 10x | Before fix (726a06ad16) | phone | 3 | 89.20 (76.20–96.60) | 1.60 (1.40–1.70) | 88.90 (81.00–204.30) | 6.50 (4.90–6.80) | 0.50 (0.50–0.60) | 0.60 (0.60–0.70) | 98.76 (80.97–103.05) |
| 10x | Before fix (726a06ad16) | browser | 3 | 115.50 (97.00–126.80) | 1.00 (0.70–1.90) | 233.40 (85.70–269.60) | 4.50 (3.50–4.60) | 1.30 (1.20–3.40) | 1.00 (1.00–2.10) | 123.50 (106.07–167.85) |
| 10x | After both fixes | phone | 3 | 32.60 (17.60–34.30) | 1.10 (0.60–1.30) | 275.00 (239.00–394.70) | 5.60 (4.40–7.50) | 0.80 (0.30–0.90) | 0.90 (0.50–2.50) | 42.89 (40.72–121.68) |
| 10x | After both fixes | browser | 3 | 25.40 (18.00–36.10) | 0.80 (0.60–1.20) | 236.70 (153.40–320.70) | 7.60 (6.20–8.70) | 0.70 (0.70–0.90) | 0.80 (0.70–0.90) | 31.97 (23.17–46.11) |

The fixed phone apply is 22.80 / 32.60 ms at 1x/10x, against 11.60 / 14.10 ms before the phase. Main-thread windows are 31.21 / 42.89 ms; cleanup is about 1 ms and checks under 1.5 ms. This keeps worker investigation relevant, without attributing durability waits entirely to CPU. The original operator and desktop feed values below predate that fix.

### Original first-feed series, before the separate feed fix

The real IndexedDB adapter and replica receive the **same 100 sidebar issue updates** in every arm. The before engine has no per-client policy, so one full-history before arm is shared by the three policy candidates. The initial static policy projection is held fixed throughout this series; this is the first delta after that projection, not warmed steady-state feed throughput and not the cost of updating mounted UI models. Initial database population, model setup and settling are outside the timed region.

`receive` is replica application wall time; `durable wait` is the subsequent asynchronous settle wall time. `storage submit` sums synchronous IndexedDB put/delete/clear submissions on the main thread. `main thread` is Chromium's task time across parsing, application, durability, row checks and the final replica disconnect/store close. It is a window including cleanup, not pure per-delta CPU; the columns overlap and must not be added. Setup awaits store and replica settling before timing. Its ledger records the resident-row count, not setup elapsed time. The durable wait in the table is the subsequent post-delta storage settle. Each received result and durable cursor/title is checked.

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

This is a regression in the measured feed window (which includes cleanup): for example phone x1 is 59.70 ms versus 16.34 ms, and phone x10 is 162.54 ms versus 22.39 ms. Receive wall time, measured before durability/checks/cleanup, independently regresses on phone from 8.80 / 12.60 ms to 52.30 / 73.20 ms at x1/x10. Smaller retained history has not made the first delta cheaper. POD-7119 owns the fix; this report records the measured values without adding an optimization.

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

Both fixture trees start unopened. Search/sidebar preparation is outside input-to-Paint. The collector observes an unobscured child belonging to the target tree, rejects any pre-input tree request and requires a tree request in the policy arm; it saves request specifications, resources and a screenshot. Phone measures the Mission details deck; web/desktop measure the expanded flight deck. These are flat, session-free trees, 12/970 total with 9/922 long-closed members. The 12 tree runs first; the 970 tree is unopened but shared module code may already be warm.

| Surface | Tree size | First deck Paint ms, before → after | Main-thread window ms, before → after | Admitted captures, before / after |
| --- | ---: | --- | --- | --- |
| Phone web proxy | 12 | Pending | Pending | Pending |
| Phone web proxy | 970 | Pending | Pending | Pending |
| Web | 12 | Pending | Pending | Pending |
| Web | 970 | Pending | Pending | Pending |
| Desktop renderer proxy | 12 | Pending | Pending | Pending |
| Desktop renderer proxy | 970 | Pending | Pending | Pending |

The corrected-tip series is pending POD-7165 and the coordinator’s source pin. At the original startup tip `af8b3091e0`, phone 12 opened in 1,158 ms and the 970 tree never reached its visible target before the 60 s wait expired; it is censored at **more than 60 s**. Its 2,629-row tree reply took 246 ms, followed by repeated tree/record requests. POD-7155 owns the visible-holding/refetch fix. A separate web observation at the same original tip opened 12 in 1,832 ms and 970 in **92,068 ms**, with a 91,947 ms main-thread window; POD-7165 owns the remaining install/notify cost. These are single observations, not medians. The base phone observations were 927 / 3,982 ms for 12/970. The web r41 control missed a late-mounted expand control and is excluded as a collector failure; r44 was externally interrupted before deck Paint and supplies no product timing. Raw attempts and screenshots remain issue artifacts.

The two-axis server search service is byte-identical between the before and after products. The coordinator approved reuse of [POD-7089's search evidence](issue-search-7089.md), source `33f4ab4f16`, which contains 11 warm samples per query. This is shared unchanged-service evidence, not newly interleaved before/after application traffic. Its reported spread is p95 (largest of 11), as recorded in that report.

| Query | h1a1 median / p95 ms | h10a1 median / p95 ms |
| --- | ---: | ---: |
| No match | 35.5 / 37.7 | 196.4 / 201.9 |
| Specific title | 41.2 / 43.4 | 216.4 / 222.5 |
| Description | 42.1 / 43.0 | 230.4 / 240.4 |
| Unique brief | 30.3 / 31.0 | 160.2 / 164.8 |
| Broad title | 894.5 / 931.4 | 7433.8 / 8091.1 |

The broad query returns 3,253 / 18,426 hits; full normalization is included. The service files are byte-identical from `17d01cd9c5` to `af8b3091e0`. This is reused unchanged-service evidence; no new two-axis search was run.

### Operator-sized server search

Three fresh SQLite stores per arm are interleaved. Each query is warmed once before timing, with title/description/brief fixtures and full normalization; the expected hit count is checked. This is service time, excluding transport and client display.

| Query | Before ms, median (min–max) | After ms, median (min–max) | Hits before / after |
| --- | ---: | ---: | ---: |
| no-match | 62.41 (62.26–63.22) | 60.51 (60.34–65.13) | 0 / 0 |
| specific-title | 57.71 (53.11–67.33) | 54.56 (53.43–55.08) | 4 / 4 |
| description | 102.03 (100.58–107.51) | 104.95 (102.61–111.71) | 111 / 111 |
| brief | 50.60 (49.76–51.41) | 48.50 (48.12–50.72) | 1 / 1 |
| broad-title | 1841.52 (1755.75–1882.76) | 1742.85 (1624.33–1886.20) | 6135 / 6135 |

Source product is `17d01cd9c5` versus `af8b3091e0`; harness checkout matches the final series. Raw samples and the six-case schedule are preserved. SQLite only.

## Decisions requested by the design

No optimization in this table is built by this issue. There is no agreed native-phone total-memory budget. The recommended 8 MiB incremental phone-cache allowance is justified by the retained-cache sweep, not a claim about physical-device limits.

| Item | Answer | Measurement behind the recommendation |
| --- | --- | --- |
| Disk-only cache | No, retain the current design | Phone cap 1,000 adds 2.88 MiB (2.83–2.90) of retained fixture heap, below the proposed 8 MiB increment. Final phone heap at 1x→10x is 127.1 (127.1–127.2) → 133.3 (133.3–133.3) MiB (1.05x), rather than tracking full history. Revisit with an on-device budget or oversized bodies. |
| Sync engine in a worker | Yes, investigate | Fixed phone apply remains 22.80 / 32.60 ms at 1x/10x; main-thread windows 31.21 / 42.89 ms. SQLite startup still blocks 113.57 / 339.19 ms. A worker will not move screen models or indexes and must be measured on-device. |
| Preload trees | No | 8.40 (8.25–8.52) → 4.90 (4.83–5.16) s phone startup. The original large web deck spent 91,947 of 92,068 ms in the main-thread window after a small tree reply. Preloading would move that install work into startup; repair and measure install cost first (POD-7155 / POD-7165). The corrected deck table will qualify this conclusion; the fixtures are flat and session-free. |
| Remaining startup index work | Yes, profile the bounded startup work | Final 1x cold CPU is 5.53 (5.44–5.67) → 4.28 (4.15–4.90) s on phone and 5.68 (5.49–5.72) → 6.21 (5.92–6.37) s on web. The original all-history indexes are gone; these totals do not prove another index is the cause. |
| Re-run per-record memory work (POD-5157 / POD-5539 / POD-5952) | Yes, re-measure the new bounded working set | Final phone heap is 542.2 (542.2–542.3) → 133.3 (133.3–133.3) MiB at 10x; the 1,000-record cache adds only 2.88 MiB in isolation. Re-profile remaining retained objects before choosing another ownership or representation change. |

## Rerun and validation

Follow [startup-baseline.md](startup-baseline.md) for Paint and admission. Every build, measurement and validation goes through `remote-lane` on an authorized VM, from committed HEAD, one call at a time. Use a scratch worktree at collector `4fbaace526` to reproduce the fixed product; for a fresh candidate, record its product digest. Resolve private host aliases/lock mapping from the issue artifact; they are deliberately absent here.

```sh
# Set an authorized measurement VM and a never-used round number.
measurement_vm=vega2
fresh_round=100
# At collector 4fbaace526 for phone/web, c030eb8435 for desktop/search:
remote-lane "$measurement_vm" 7095 run python3 apps/web/harness/data-on-device-baseline.py prepare --host="$measurement_vm" --base=17d01cd9c5 --cells=h1a1,h10a1,operator
remote-lane "$measurement_vm" 7095 run python3 apps/web/harness/data-on-device-baseline.py timing --host="$measurement_vm" --base=17d01cd9c5 --surface=phone --cells=h1a1,h10a1,operator --samples=3 --round="$fresh_round" --measure-memory --max-pairs=3
# Continue that same saved schedule in five further sequential short windows:
remote-lane "$measurement_vm" 7095 run python3 apps/web/harness/data-on-device-baseline.py timing --host="$measurement_vm" --base=17d01cd9c5 --surface=phone --cells=h1a1,h10a1,operator --samples=3 --round="$fresh_round" --measure-memory --max-pairs=3 --resume
# Use the same sequence for --surface=web and --surface=desktop.
# Decks: use the corrected product/collector pin recorded with their table.
fresh_round=101
remote-lane "$measurement_vm" 7095 run python3 apps/web/harness/data-on-device-baseline.py timing --host="$measurement_vm" --base=17d01cd9c5 --surface=phone --cells=operator --samples=3 --round="$fresh_round" --decks --max-pairs=3
# One further identical call with --resume completes that deck surface; use
# fresh surface ledgers for web and desktop. Do not reuse a startup ledger.
remote-lane "$measurement_vm" 7095 run python3 apps/web/harness/device-cost-series.py search --host="$measurement_vm" --base=17d01cd9c5 --samples=3 --round="$fresh_round"
# In a separate checkout, use the original SQLite/feed/cache source product
# 726a06ad16 with the archived cost-series collector, as recorded in its samples.
fresh_round=102
remote-lane "$measurement_vm" 7095 run python3 apps/web/harness/device-cost-series.py build --host="$measurement_vm" --base=17d01cd9c5 --round="$fresh_round"
remote-lane "$measurement_vm" 7095 run python3 apps/web/harness/device-cost-series.py sqlite --host="$measurement_vm" --base=17d01cd9c5 --clients=phone --samples=3 --round="$fresh_round"
remote-lane "$measurement_vm" 7095 run python3 apps/web/harness/device-cost-series.py feed --host="$measurement_vm" --base=17d01cd9c5 --samples=3 --round="$fresh_round" --max-cases=6
# Resume the unchanged feed schedule in bounded windows until complete.
remote-lane "$measurement_vm" 7095 run python3 apps/web/harness/device-cost-series.py cache --host="$measurement_vm" --samples=3 --round="$fresh_round" --max-cases=6
# Resume the unchanged 30-case cap sweep in bounded windows until complete.
```

Before each call, read both issue and session inboxes and preserve the source, VM, corpus and saved schedule. Complete each command before launching the next. A new product, collector or cell list needs a fresh round. The fixed-feed replacement is POD-7119’s independent series; use its report’s commands and pins rather than attributing the original feed runner to that fix.

The single end validation is pending the corrected deck series and final integration rebase. No READY or gate pass is claimed yet.
