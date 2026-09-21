# POD-4489 — quiet-window timing re-run (supersedes the withheld walls)

Supersession note (`POD-4514`, 2026-09-21): the §3 M2 1x cells below are
re-recorded at `7d5ef3afe` (current `integrate/4441-round-two` tip, which
adds the `POD-4503` #6d keeper-evict steps). The re-run lives in the three
M2 notes (`POD-4450/4451/4452-m2.md` §1–§2, each carrying its as-of SHA) —
read the M2 numbers there. Direction of movement at 1x: every M2 wall
cell is same-or-faster in the re-run (quieter box, max per-record load
7.98); rename commits still read 1/arm vs 346 control, clock 0 everywhere.
Growth cells (§4) and the bundle deltas (§5) stand as printed.

Issue: `POD-4489`. Runtime SHA `e426046d8` (= `integrate/4441-round-two` tip;
worktree clean, all three arms clean — the `POD-4458` TanStack experiment had
closed and its worktree is gone before the first record). Chromium
`148.0.7778.96`. Production build from this SHA; chunks byte-match the M3
notes (hand 51.68/13.23, mobx 76.16/21.69, tanstack 314.23/86.73, entrylib
602.34/175.75 kB raw/gzip — the +5 kB gzip profiling alias from `POD-4492`
included). No arm source touched: this issue produces measurements only.

JSON: 23 driver files, `browser-m2-*-1x-[ab].json` (M2 set) and
`browser-growth-*-{1,2,4}x.json` (growth set), attached to the issue
(`harness/browser/results/` is gitignored). Every record carries `loadavg`,
`uptime`, `runtimeSha` (driver-recorded, not transcribed).

## 1. What was withheld and what this run covers

| Withheld source | Status after this run |
|---|---|
| M2 browser walls, all 3 arms + control at 1x, rename/stagemove/clock (`POD-4450/4451/4452` §2, loads 7–12.5, p95≤8 ms NOT claimed) | VERDICT — same invocations, unchanged flags (`--samples 10`, two invocations per arm = n=20 per cell), quiet window below |
| M2 browser `commits` (all zeros — dead instrument, production React Profiler no-op) | CORRECTED — `POD-4492` fix in this SHA; rename reads 1/arm vs 346 control, clock 0 everywhere (both-ways proof from live records, not cited) |
| M3 growth walls at 1x/2x/4x, heartbeat/click/rename/stagemove (`POD-4453/4454/4455` §2) | VERDICT except: hand-1x heartbeat/click (n=6 quiet subset, stated), mobx-4x (WITHHELD, two contaminated attempts), control-2x (PROVISIONAL, n=4–5/cell), control-4x (WITHHELD, 7/40 quiet) |
| M3 lifecycle walls (principalSwitch ≤2×, coldBootstrap ≤1.1× + heap ≤1.1×, rescope ±5%) | STILL WITHHELD — no browser-harness method exists for them (`run.ts` covers event walls only); happy-dom table-equality proxies from the M3 notes stand |
| M3 `phaseMs` happy-dom splits | Unchanged — box-load proxies, not browser numbers; not re-run |

#2 phase-change has no browser scenario (driver offers
heartbeat/rename/stagemove/clock/click); it stays counts-carried, stated
plainly rather than proxied.

## 2. Load conditions (the bar: 1-min < 8 before AND after)

Window opened 16:38 UTC at 4.77 (first sub-8 reading in two days) after a
21.5 spike ~20 min earlier; it oscillated 5–9 throughout. Per-invocation
before/after (from shell `uptime`, per-record `loadavg` in JSON):

- M2 round A (H,M,T,C): 4.71→5.13→4.96→5.22→5.20→8.68→8.12→8.00. The 8.68 is
  tanstack-a's own clock cost heating the box (10 × ~1.5 s engine re-runs);
  control-a started 8.12 (marginally over — its records read 8.0–8.4).
- M2 round B (H,M,T,C): 5.79→6.79→6.79→7.99→8.07→7.44→7.24→8.15.
  Tanstack-b started 8.07, control-b ended 8.15 — both marginal, flagged, kept
  (per-record loads recorded; the pooled cells below show ranges).
- Growth-1x: mobx 6.41→6.90, tanstack 6.90→7.10, control 7.10→7.26 (all
  quiet); hand THREE attempts all caught spikes (8.79→8.89, 8.60→8.55,
  7.43→8.97) — the n=6 quiet subset (re2 samples 0–5, load 7.32) is reported
  as such, full-n stays withheld.
- Growth-2x: hand 7.04→9.58 (39/40 quiet, last record 9.59), mobx 6.28→7.29,
  tanstack 7.29→7.72, control 7.72→7.67 shell but per-record 7.6–8.5 (17/40
  quiet — PROVISIONAL).
- Growth-4x: hand 7.67→8.11 (39/40 quiet), mobx 7.16→8.48 (1/40 quiet —
  WITHHELD) then re-run 6.30→9.44 (17/40 — WITHHELD), tanstack 5.70→7.36
  (40/40 quiet), control 6.93→7.80 shell but per-record 7.79–9.23 (7/40 —
  WITHHELD).

Sampling/ordering: one driver invocation per (arm, scale) — never looped
pairs in-process (F1 lesson); scenarios rotate round-robin per sample inside
each invocation; invocations interleaved H,M,T,C then H,M,T,C per scale, so
drift hits every arm. Statistics are linear-interpolation p50/p95 over the
stated n (with n=10, p95 ≈ 2nd-highest — never presented as anything else).

## 3. M2 1x verdict (n=20 per cell, pooled a+b; per-record loads in §2 table)

`actionMs` = in-page sync pipeline + microtask drain; `taskMs` bounds the
wall to paint. Budget (harness doc): hot-path ≤ 8 ms p95 on `taskMs`.

| Arm | Scenario | actionMs p50 / p95 / max | taskMs p50 / p95 / max | commits | longTasks /20 | per-record load |
|---|---|---|---|---|---|---|
| hand | rename | 9.6 / 22.2 / 23.3 | 21.1 / 39.6 / 40.9 | 1 | 0 | 5.1–6.8 |
| hand | stagemove | 7.2 / 13.7 / 16.8 | 18.4 / 26.6 / 29.6 | 0–1* | 0 | 5.1–6.8 |
| hand | clock | 2.2 / 3.4 / 3.5 | 12.6 / 20.6 / 23.0 | 0 | 0 | 5.1–6.8 |
| mobx | rename | 16.2 / 57.5 / 131.8 | 27.1 / 83.5 / 161.6 | 1 | 3 | 4.8–8.0 |
| mobx | stagemove | 12.9 / 25.5 / 39.5 | 25.8 / 47.2 / 48.6 | 0–1* | 0 | 4.8–8.0 |
| mobx | clock | 49.3 / 113.2 / 116.8 | 62.7 / 126.5 / 128.2 | 0 | 0 | 4.8–8.0 |
| tanstack | rename | 88.3 / 108.2 / 110.4 | 101.6 / 118.4 / 120.1 | 1 | 18 | 5.9–8.2 |
| tanstack | stagemove | 33.1 / 81.6 / 126.7 | 46.1 / 96.0 / 145.2 | 0–1* | 5 | 5.9–8.2 |
| tanstack | clock | 1529.5 / 2037.3 / 2196.7 | 1537.5 / 2047.3 / 2210.6 | 0 | 0 | 6.4–8.7 |
| control | rename | 190.6 / 260.4 / 264.8 | 199.0 / 276.0 / 286.8 | 346 | 20 | 7.1–8.4 |
| control | stagemove | 192.4 / 330.5 / 434.3 | 204.2 / 341.5 / 522.2 | 346 | 20 | 7.1–8.4 |
| control | clock | 0.0 / 0.1 / 0.2 | 13.8 / 18.0 / 19.5 | 0 | 0 | 7.1–8.4 |

\* Stagemove `0` commits are the known fold-blocked shape (needsHuman/asking
rows keep `closed` false and settle without commit — same shape all three M2
notes reported); rotating fresh rows per sample.

Budget verdicts (quiet conditions — these ARE the findings):

- **p95 ≤ 8 ms hot-path: NOT MET on any arm for rename/stagemove, INCLUDING
  by hand** (hand rename actionMs p95 22.2, taskMs 39.6). The line the M2
  notes rightly refused to claim under load still fails quiet. Not softened.
- Hand clock actionMs p95 3.4 is the only sub-8 ms pipeline number, but the
  budget asserts `taskMs` (p95 20.6 — paint + CDP heap GC dominate) → FAIL
  as stated. No cell passes on `taskMs`.
- MobX F-clock price confirmed quiet: clock actionMs p50 49.3 (~3× its
  rename 16.2), 0 commits — settled-body re-runs, as the M2 note priced it.
- TanStack F-clock-wall separated quiet: clock p50 ~1.53 s with **0
  longTasks and 0 commits** — engine fn re-run cost, NOT frame starvation.
  The withheld question is answered against the arm, plainly.
- Load-robust ratios (interleaved, both sides same window): hand ~20×,
  mobx ~12×, tanstack ~2× faster than control at rename p50; longTasks
  0 / 3 / 23 vs 40 over the 60 hot-path records. Control derives 346 rows
  per rename/stagemove (whole-world); arms derive 1.

Commit correction: every M2 `commits: 0` is superseded — rename commits
exactly 1 row on all three arms (in-page stats match the count harness:
1+3 hand/mobx bodies, 1+5 tanstack), control 346; clock commits 0 on all
four. The stale zeros in `POD-4450/4451/4452-m2.md` §2 must now be read
through this note.

## 4. Growth walls (quiet medians; actionMs p50 unless noted)

1x heartbeat/click (n=10/cell; hand n=6 subset, load 7.32):

| Arm | heartbeat action p50/p95 | click inputToPaint p50/p95 | heartbeat commits |
|---|---|---|---|
| hand† | 22.8 / 54.1 | 12.1 / 154.6 | 0 |
| mobx | 21.6 / 29.8 | 11.3 / 45.9 | 0 |
| tanstack | 37.8 / 109.0 | 16.8 / 43.1 | 0 |
| control | 88.8 / 138.6 | 14.0 / 138.1 | 346 |

† n=6 quiet subset of three contaminated attempts — provisional, full-n withheld.

2x (n=10/cell; hand stagemove n=9, control PROVISIONAL n=4–5/cell):

| Arm | heartbeat | rename | stagemove | click inputToPaint p50/p95 |
|---|---|---|---|---|
| hand | 23.7 / 35.1 | 14.1 / 19.4 | 11.6 / 17.6 | 14.4 / 43.2 |
| mobx | 36.8 / 46.6 | 32.9 / 93.8 | 22.8 / 74.6 | 17.1 / 45.6 |
| tanstack | 53.1 / 123.5 | 50.4 / 124.5 | 43.6 / 171.1 | 13.6 / 49.1 |
| control‡ | 211 / 374 | 498 / 565 | 560 / 794 | 9.4 / 61.7 |

‡ 17/40 records quiet — thin, provisional.

4x (n=10/cell; hand stagemove n=9; mobx WITHHELD; control WITHHELD 7/40):

| Arm | heartbeat | rename | stagemove | click inputToPaint p50/p95 |
|---|---|---|---|---|
| hand | 42.6 / 99.6 | 29.9 / 76.3 | 29.3 / 41.8 | 11.5 / 42.0 |
| tanstack | 93.7 / 200.3 | 81.7 / 119.7 | 83.4 / 128.9 | 12.3 / 48.1 |

Wall-slope (actionMs p50, 1x→2x→4x): hand rename 9.6→14.1→29.9,
stagemove 7.2→11.6→29.3; mobx rename 16.2→32.9, heartbeat 21.6→36.8;
tanstack heartbeat 37.8→53.1→93.7, stagemove 33.1→43.6→83.4. Walls scale
~2–4× for a 4× corpus while ROWS COMMITTED stay flat (counts slope ≤ 1.2
PASS, load-independent, from the M3 notes) — the wall slope is the named
INHERENT per-read rebuilds (`order-snapshot` = V exactly, `groups-bucket`
= V), not new work. Control walls scale with N (heartbeat 88.8→211→~696,
rename 190→498→~2006; commits 346→692→1384 exactly) — whole-world, as designed.

Budget verdicts:

- **Click ≤ 16 ms p95 at 1x inputToPaint: NOT MET anywhere** (mobx 45.9,
  tanstack 43.1, control 138.1; hand subset 154.6). Medians sit 11–17 ms —
  near the line — but every file has ONE slow first click (60–196 ms:
  cold-list warm-up, present on all four pages including control), which
  single-handedly blows p95 at n=10. Finding, not tuning.
- **Click ≤ 32 ms at 4x: NOT MET** (hand 42.0, tanstack 48.1).
- Slope ≤ 1.2: PASS on counts (all arms, all scales — carries the verdict);
  walls scale super-linearly per the named rebuild costs. Both stated.

## 5. What stays withheld (for the record, not the drawer)

1. MobX 4x event walls (two attempts: 1/40 then 17/40 quiet — the runs
   self-heat; needs a deeper-quiet window or fewer samples per invocation).
2. Control 4x (7/40 quiet) and control-2x full-n (17/40; thin subset above).
3. Hand-1x heartbeat/click full-n (three attempts, all spiked; n=6 subset above).
4. Lifecycle walls — principalSwitch ≤2×, coldBootstrap ≤1.1× + heap ≤1.1×,
   rescope ±5%: still no browser method. Next owner either builds the
   page-load/CDP-heap lane or keeps the happy-dom proxies with this note.
5. Bundle deltas stand as built (same chunks): hand +11.21 kB gzip PASS,
   mobx +19.72 PASS, tanstack +84.76 FAIL — unchanged since M3, reproduced
   by this run's build.
