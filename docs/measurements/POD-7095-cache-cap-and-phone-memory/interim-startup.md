# Client cache caps and startup

**Interim at product `726a06ad16`: cold-start and feed regressions do not clear the live update.** The corrected web cohort stopped at 12/18 pairs by coordinator direction, ahead of the separate product fixes. Original phone memory is limited observations after a fixture fault; request/CPU attribution is excluded. Deck, search and desktop follow, then one final phone/web startup series on the fixed integration tip. That series replaces the planned old-product phone x10 replacement.

## What a user will feel

These are interim observations of the original product, not the forthcoming fixed tip. Values are median (minimum–maximum). Paint is in **seconds** and peak renderer RSS in **MiB**. Each cell schedules three interleaved cold/warm pairs per arm; the exact admitted/rejected counts are below.

| Surface | History | Cold first paint, before → after | Warm first paint, before → after | Peak renderer memory, before → after |
| --- | --- | --- | --- | --- |
| Phone web proxy (VM A) | x1 | 6.16 (6.02–6.16) → 17.70 (15.08–17.72) | 5.35 (5.11–5.89) → 4.35 (4.34–4.70) | 537.3 (534.1–540.4) → 576.4 (571.4–583.1)‡ |
| Phone web proxy (VM A) | x10 | 18.25 (one admitted sample) → 31.04 (30.64–34.27) | 13.94 (one admitted sample) → 4.94 (4.78–6.74) | 1112.6 (one admitted sample) → 624.2 (585.3–628.5)‡ |
| Web (VM B) | x1 | 5.71 (5.60–5.82) → 36.89 (35.21–38.57) | 4.78 (4.65–4.91) → 5.43 (5.25–5.62) | 581.2 (579.8–582.6) → 551.9 (437.7–666.0) |
| Web (VM B) | x10 | 18.69 (18.26–19.11) → 57.44 (49.85–65.04) | 14.44 (13.97–14.91) → 5.87 (5.67–6.06) | 1123.3 (1084.3–1162.2) → 621.8 (564.2–679.4) |

The operator-sized population and empty-device desktop renderer use the same series:

| Surface | Population | Cold first paint, before → after | Warm first paint, before → after | Peak renderer memory, before → after |
| --- | --- | --- | --- | --- |
| Phone web proxy (VM A) | Operator-sized | 8.10 (8.01–9.30) → 16.05 (15.94–16.52) | 7.41 (7.38–7.43) → 4.22 (4.15–4.25) | 745.7 (737.8–773.9) → 578.6 (575.2–579.6)‡ |
| Web (VM B) | Operator-sized | 7.93 (7.83–8.03) → 33.41 (32.37–34.44) | 5.88 (5.81–5.94) → 4.98 (4.94–5.03) | 771.1 (768.0–774.2) → 621.0 (597.5–644.5) |
| Desktop renderer proxy | x1 | Pending → Pending | Pending → Pending | Pending → Pending |
| Desktop renderer proxy | x10 | Pending → Pending | Pending → Pending | Pending → Pending |
| Desktop renderer proxy | Operator-sized | Pending → Pending | Pending → Pending | Pending → Pending |

A fresh browser context supplies empty application storage. Warm is a retained-data reload after the cold corpus is durable; request routing disables HTTP caching on both. The boundary is an actual Chromium Paint after the first visible issue row and the boot splash disappears. Peak RSS includes cold navigation, durability verification and settling through the memory sample. The IndexedDB population probe itself reads the rows in the page, so these comparable instrumented peaks are not native-device or uninstrumented browser limits. Retained V8 heap is sampled after settling and two forced collections. The forced collections occur between the cold capture and warm reload in both arms; compare these warm values with their new interleaved before controls, rather than directly with the older timing-only baseline.

### Retained client memory

| Surface | Population | Heap after GC MiB, before → after | Renderer RSS MiB, before → after | Admitted pairs, before / after |
| --- | --- | --- | --- | --- |
| Phone web proxy (VM A) | x1 | 182.1 (182.0–182.2) → 131.5 (131.4–132.3)‡ | 392.1 (391.2–394.7) → 392.4 (382.0–392.7)‡ | 3/3 / 3/3 |
| Phone web proxy (VM A) | x10 | 542.1 (one admitted sample) → 137.0 (137.0–137.6)‡ | 773.5 (one admitted sample) → 449.6 (433.5–451.2)‡ | 1/3 / 3/3 |
| Web (VM B) | x1 | 203.6 (203.5–203.6) → 197.1 (197.0–197.3) | 437.7 (436.6–438.8) → 437.0 (435.5–438.4) | 2/2 / 2/2 |
| Web (VM B) | x10 | 569.1 (568.9–569.4) → 202.4 (202.3–202.4) | 817.3 (816.3–818.2) → 443.0 (442.4–443.5) | 2/2 / 2/2 |
| Phone web proxy (VM A) | Operator-sized | 284.1 (283.9–284.3) → 124.3 (124.3–124.4)‡ | 518.0 (517.9–518.3) → 377.7 (376.5–378.2)‡ | 3/3 / 3/3 |
| Web (VM B) | Operator-sized | 292.3 (292.3–292.3) → 182.8 (182.7–182.8) | 545.3 (544.8–545.8) → 421.5 (419.0–424.0) | 2/2 / 2/2 |
| Desktop renderer proxy | x1 | Pending → Pending | Pending → Pending | Pending / Pending |
| Desktop renderer proxy | x10 | Pending → Pending | Pending → Pending | Pending / Pending |
| Desktop renderer proxy | Operator-sized | Pending → Pending | Pending → Pending | Pending / Pending |

### Where startup time goes

These are renderer main-thread CPU time and completed collection resources that began before first paint. Fetch durations are summed across requests and overlap CPU and one another: **do not add the columns**. The route uses real local service answers augmented with the deterministic corpus; it does not time a production server sending that synthetic population. The second table records route augmentation overhead separately. Resources are sampled after the visible-row check: the filter is request start before Paint, so a duration can extend past Paint, and a request still unfinished at sampling is absent from that table.

| Surface | Population | Cold CPU s, before → after | Warm CPU s, before → after | After fetches before cold Paint | After summed fetch time s |
| --- | --- | --- | --- | --- | --- |
| Phone web proxy (VM A) | x1 | 5.39 (5.25–5.49) → excluded† | 4.79 (4.51–5.25) → excluded† | excluded† | excluded† |
| Phone web proxy (VM A) | x10 | 15.44 (one admitted sample) → excluded† | 12.28 (one admitted sample) → excluded† | excluded† | excluded† |
| Web (VM B) | x1 | 5.23 (5.17–5.28) → 21.11 (20.91–21.31) | 4.30 (4.13–4.48) → 4.85 (4.68–5.02) | 1 (1–1) | 0.17 (0.14–0.20) |
| Web (VM B) | x10 | 16.02 (15.68–16.36) → 26.32 (24.88–27.76) | 12.59 (12.04–13.14) → 5.12 (4.89–5.36) | 1 (1–1) | 0.17 (0.16–0.18) |
| Phone web proxy (VM A) | Operator-sized | 7.18 (7.11–7.84) → excluded† | 6.55 (6.54–6.71) → excluded† | excluded† | excluded† |
| Web (VM B) | Operator-sized | 7.15 (7.06–7.23) → 17.57 (17.36–17.78) | 5.30 (5.24–5.36) → 4.45 (4.38–4.52) | 1 (1–1) | 0.12 (0.12–0.13) |
| Desktop renderer proxy | x1 | Pending → Pending | Pending → Pending | Pending | Pending |
| Desktop renderer proxy | x10 | Pending → Pending | Pending → Pending | Pending | Pending |
| Desktop renderer proxy | Operator-sized | Pending → Pending | Pending → Pending | Pending | Pending |

| Surface | Population | Cold collection replies through reload | Sum of cold route elapsed s | Cold fixture augmentation s | Bootstrap fixture augmentation s |
| --- | --- | --- | --- | --- | --- |
| Phone web proxy (VM A) | x1 | excluded† | excluded† | excluded† | 0.15 (0.14–0.17) |
| Phone web proxy (VM A) | x10 | excluded† | excluded† | excluded† | 0.39 (0.39–0.40) |
| Web (VM B) | x1 | 2 (2–2) | 0.30 (0.27–0.32) | 0.02 (0.02–0.03) | 0.19 (0.19–0.19) |
| Web (VM B) | x10 | 2 (2–2) | 0.28 (0.28–0.29) | 0.03 (0.03–0.03) | 0.38 (0.38–0.38) |
| Phone web proxy (VM A) | Operator-sized | excluded† | excluded† | excluded† | 0.16 (0.15–0.18) |
| Web (VM B) | Operator-sized | 2 (2–2) | 0.23 (0.21–0.25) | 0.02 (0.02–0.02) | 0.20 (0.19–0.21) |
| Desktop renderer proxy | x1 | Pending | Pending | Pending | Pending |
| Desktop renderer proxy | x10 | Pending | Pending | Pending | Pending |
| Desktop renderer proxy | Operator-sized | Pending | Pending | Pending | Pending |

Route replies are grouped by completion before the warm navigation, so a request straddling the reload belongs to the later interval. Complete per-resource timings, all raw samples and guard exclusions are retained in the issue artifacts. Both arms use the same collector and fixture bytes; only the controller changed to recover a saved complete pair after a teardown exit. Recovered pairs still pass the original admission guard.

‡ Earlier phone memory is retained only as limited observations: its after arm includes the synthetic-reply retry loop. The coordinator directed retaining these observations without a corrected recapture on this old product. † Earlier phone-after CPU attribution and collection counts/totals are excluded as production evidence: a synthetic-only reply lacked its envelope and caused retries. POD-7122 repaired that fixture and found phone x1 Paint unchanged (17.44 versus 17.48 s), with 5 collection POSTs. Its diagnostic trace attributes the late paint to about 3.4 s installing chunks, about 10 s waiting for 346 IndexedDB transactions / 20,202 requests, then about 1.9 s publishing. This is one diagnostic capture, not a median/spread from this series. Corrected new cohorts use the repaired envelope in both arms.

Startup rounds 22 and 24 measured checkout commits: `009fd9776635602975d5c166b9cda7eb278d9821`, `17d01cd9c530eb22d902b352837cbfc9eb5a15a3`, `be20f115d09374bdb6d82998dba5c0fd373f542b`, `d182e3a9260b962eb2a71ee8eaeab595234b5337`. Product-tree digests: `8352ccf02e5c6ccb4b6d73dd1e5b9278a5263be2183d6f169853e0fe8adbb146`, `f84fc0ddd4b8afa27550335ea67831074569e229afdf2a69382b042082479d04`.

Rejected timing pairs stay in the evidence and out of the medians:

- `r22/web/h10a1/before` at 2026-11-18T12:11:24.838Z: cold 21.09 s, warm 14.00 s, observed renderer peak 1137.4 MiB; unexpected browser errors invalidate startup evidence.
- `r22/phone/h10a1/before` at 2026-11-18T10:24:36.612Z: cold 17.99 s, warm 13.97 s, observed renderer peak 1108.0 MiB; unexpected browser errors invalidate startup evidence.
- `r22/phone/h10a1/before` at 2026-11-18T10:55:08.233Z: cold 19.37 s, warm 15.46 s, observed renderer peak 1046.3 MiB; unexpected browser errors invalidate startup evidence.


