# POD-6140 result: server data access, measured against the baseline

The final measurement of POD-6140 (server data access and caching), step 4 of the design
([2026-10-15-server-data-access-design.md](../internal/superpowers/specs/2026-10-15-server-data-access-design.md) §7, §9),
against the fresh baseline in [pod-6140-baseline.md](pod-6140-baseline.md).

- **A** = `e05eeaf1688f92878974d4ce17b3e4104f119179`, the commit before the first copy removal (parent of
  `83b6ae6e65` "Remove the world index's users copy", the first C1 commit on `issue/6140-…`). It already has the
  foundations: prepared queries (POD-6147), indexes and planner statistics (POD-6148), statement-count tests (POD-6149).
- **B** = `ae0361d75f4c25e05037a94d65c896d0592bb49f`, the integration tip once POD-6210 and POD-6214 had landed: every copy removed.
- **As of:** bench runs 2026-10-17T09:11Z to 11:09Z on the polaris agents VM (4 CPU, 12 GB); the live half is pending (§2).

## Summary

- **Memory no longer grows with data.** B's server RSS at the end of the load window is 326 MiB on the
  bench's small corpus and 334 MiB on the large one; A's grows from 457 to 1,188 MiB. Heap: 76 → 72 MiB in B,
  129 → 471 MiB in A.
- **Boot is faster, stalls are gone.** Boot to `listen` is 8% faster on the small corpus and 52% faster on the large
  one (9.4 s against 19.6 s). Stalls drop from 5 per minute to 0–1 on the small corpus and from 15 to 0 on the large one.
- **The database does more work.** Reads the copies used to answer now go to SQL: +29% statements per minute
  (89k against 69k) and +16% SQL wall time on the small corpus. The event loop is **busier** there: 48.9% against
  46.0% utilization (+6.3%, outside the ±1.5% noise band); on the large corpus it is less busy (49.2% against 52.7%).
- **Boot still grows with data** (1.8 s → 9.4 s in B): it still reads whole tables for the boot reconcile.
- **The remaining hot paths are known and filed**, one sub-issue each (§4). The largest predates this epic: the
  runtime-event board projection takes 40% of SQL wall in both arms.
- **The live half is pending** the operator's deploy (§2).

## 1. Bench: A against B

### What was run

Five runs, all with A against B on the same machine, the recipe of [baseline §2](pod-6140-baseline.md#2-the-server-data-bench)
at 1x load (28,000 daemon frames/min, 1,860 session renames and 220 issue updates per minute, 4 clients), 4 measured
minutes per round:

| run | corpus | session-write targeting | rounds | as of (UTC) | evidence on the VM (`~/server-data-bench/runs/…`) |
|---|---|---|---|---|---|
| 1 (main) | h1a1: 4,867 issues, 4,304 sessions | realistic: 95% to the 84 live sessions | 3 per arm, A B A B A B | 2026-10-17T09:49Z | `2026-10-17T09-09-56-051Z-final-h1a1-running` |
| 2 | h10a1: 27,601 issues, 30,611 sessions | realistic | 1 per arm, A B | 10:06Z | `2026-10-17T09-50-16-328Z-final-h10a1-running` |
| 3 | h1a1 | uniform (the baseline's; ~98% parked) | 3 per arm | 10:44Z | `2026-10-17T10-08-17-264Z-final-h1a1-uniform` |
| 4 | h10a1 | uniform | 1 per arm | 10:56Z | `2026-10-17T10-44-06-478Z-final-h10a1-uniform` |
| 5 | h1a1 | realistic, plus 120 mails/min to 5 live sessions | 1 per arm | 11:09Z | `2026-10-17T10-57-25-815Z-final-h1a1-running-mail` |

One `polaris-lane` call per round, so the shared lock was released between rounds; no gap between rounds
was over 5 minutes. **Session-write targeting** is new in this issue (`--session-write-targeting`, 88ba2a24d1): the
baseline renamed sessions uniformly over the table, so almost every rename hit a parked session, which costs B
more than a running one (POD-6210). The realistic split is an assumption (95% live; the live database is not scanned),
and runs 3 and 4 keep the old profile for comparison.

### Run 1: small corpus, realistic writes (the main result)

| metric | A e05eeaf168 median (min–max) | B ae0361d75f median (min–max) | B vs A | what it counts |
|---|---:|---:|---:|---|
| bootListenMs | 2002 (1953–2023) | 1839 (1783–1846) | -8.1% | process start to the `listen` boot stage (server:boot log), ms |
| rssAfterBootMiB | 486 (412–503) | 360 (308–375) | -25.9% | server RSS when startServer resolved, MiB |
| rssEndMiB | 457 (449–471) | 326 (322–333) | -28.6% | server RSS at the end of the load window, MiB |
| heapEndMiB | 129 (125–137) | 76.2 (67.4–78.9) | -41.1% | server heap used at the end of the load window, MiB |
| utilizationPct | 46.0 (45.4–46.1) | 48.9 (47.7–48.9) | +6.3% | event-loop utilization, median of window minutes (loop-server.ndjson) |
| blockedPct | 25.8 (25.7–26.1) | 26.6 (25.7–26.7) | +3.2% | share of the minute the loop was blocked, median of window minutes |
| stallsPerMin | 4.97 (4.96–5.45) | 0.00 (0.00–0.99) | -100.0% | event-loop stalls per 60 s of wall time, median of window minutes |
| minuteSpanS | 60.6 (60.5–60.6) | 60.5 (60.5–60.6) | -0.0% | wall seconds one loop minute (60 sample windows) took, median; >60 means the sampler ran late |
| sqlStatementsPerMin | 69125 (69124–69145) | 89308 (89304–89311) | +29.2% | SQL statements per minute over the exact window (attribution totals diff) |
| sqlWallMsPerMin | 8601 (8554–8614) | 9956 (9933–9977) | +15.7% | SQL wall ms per minute over the window (attribution totals diff) |
| daemonFramesPerMin | 28072 (28069–28073) | 28073 (28068–28073) | +0.0% | daemon WebSocket frames handled per minute over the window (ws.message.daemon task count) |
| daemonWallMsPerMin | 1206 (1182–1216) | 1064 (1057–1078) | -11.7% | ms per minute handling daemon frames over the window (ws.message.daemon task wall) |
| clientFramesPerMin | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) | – | client WebSocket frames handled per minute over the window (ws.message.client task count) |
| daemonReconnects | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) | – | times the server dropped a fake daemon during the round (each reconnects after 1 s); 0 unless overloaded |
| framesDroppedPerMin | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) | – | daemon frames per minute that came due while their daemon was disconnected (not sent) |
| windowSqlPerDaemonFrame | 2.46 (2.46–2.46) | 3.18 (3.18–3.18) | +29.2% | all SQL statements in the window / daemon frames in the window |
| sqlPerDaemonFrame | 2.46 (2.46–2.46) | 3.18 (3.18–3.18) | +29.2% | SQL statements per daemon frame per loop minute (sql / ws.daemon bucket counts), median — the live figure's definition |

### Runs 2–5, the main metrics

| metric | run 2 h10a1 A | B | B vs A | run 3 h1a1 uniform A | B | B vs A | run 4 h10a1 uniform A | B | B vs A |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bootListenMs | 19,561 | 9,401 | −51.9% | 2,033 | 1,829 | −10.0% | 19,952 | 9,597 | −51.9% |
| rssEndMiB | 1,188 | 334 | −71.9% | 474 | 324 | −31.5% | 1,324 | 351 | −73.5% |
| heapEndMiB | 471 | 72.1 | −84.7% | 135 | 72.8 | −46.0% | 646 | 81.0 | −87.5% |
| utilizationPct | 52.7 | 49.2 | −6.6% | 45.3 | 49.6 | +9.5% | 50.5 | 49.9 | −1.3% |
| blockedPct | 32.9 | 26.7 | −19.0% | 25.0 | 26.8 | +7.1% | 30.8 | 27.5 | −10.7% |
| stallsPerMin | 15.3 | 0.00 | −100% | 4.95 | 0.99 | −80% | 16.3 | 1.48 | −91% |
| sqlStatementsPerMin | 68,996 | 89,544 | +29.8% | 69,035 | 100,631 | +45.8% | 68,731 | 100,928 | +46.8% |
| sqlWallMsPerMin | 8,059 | 10,042 | +24.6% | 8,620 | 10,068 | +16.8% | 8,126 | 10,183 | +25.3% |
| daemonWallMsPerMin | 1,099 | 1,086 | −1.2% | 1,200 | 1,041 | −13.2% | 1,128 | 1,055 | −6.5% |

Run 5 (mail): A 75,056 and B 96,142 statements/min, utilization 47.7% and 50.1%, RSS 465 and 334 MiB. Against run 1,
mail adds about 49 statements per message in A and 57 in B (§4, POD-6218).

### Reading it

- **Memory and stalls scale with activity now.** B's end RSS is 322–351 MiB in every run, whatever the corpus;
  A's follows the corpus. The baseline's live server sat at 1.4–1.5 GB with 7.2k issues and 6k sessions.
- **Statements no longer grow with data.** B runs 89,308 statements/min on h1a1 and 89,544 on h10a1 (+0.3%),
  and the same per frame (3.18 and 3.18). So does A; its copies held the growth in memory instead.
- **Parked writes.** Uniform targeting costs B 11.3k more statements per minute than realistic targeting
  (100,631 against 89,308), about 6.5 per parked rename (one row read plus satellite reads, as POD-6210 found),
  and A nothing (its session map held parked sessions). At the realistic 5% parked share that is about 600
  statements per minute.
- **Busy share on the small corpus is worse than the noise band.** The extra time is SQL (+1.4 s/min of SQL wall in
  run 1); daemon frame handling itself got cheaper (−12%). The live corpus (7.2k issues, 6k sessions) is closer to h1a1
  than to h10a1, so expect live utilization to rise slightly unless the hot paths in §4 are fixed.
- **Where B's extra 20k statements per minute come from** (run 1, round 2 of each arm, per minute, A → B; statement
  keys compared in full, since the "select" kind with a cut-off table hides several tables in A): pending-mail counts
  0 → 6,610 (the pending counters left memory; POD-6219); grant reads 3,541 → 8,062 (POD-6217); the sync commit's
  `change_latest` read 0 → 3,122 (the change baseline left memory; sync scope); machine rows 0 → 1,860 (one per
  session command); issue rows by worktree path 0 → ~1,300 (session activity and delivery). Session rows (~3.2k),
  issue rows (~3.2k), observation checkpoints and pending interactions (1.1k each) were read in both arms. Each
  round's `round.json` lists the top 40 statements with rates and wall time.

## 2. Live server

**Pending the operator's deploy.** The merged build is not deployed yet (coordinator, 2026-10-17), so the live
half cannot run. When it is deployed and has run at least 24 hours on one build, read the live server exactly as
the baseline did ([baseline §1, "Reproducing the live tables"](pod-6140-baseline.md#reproducing-the-live-tables)),
with the same three windows: **24 h**, **1 h**, and **since the last restart**, each ending at the same
`--end`. Only light reads on ludovico (copy the minute file, export the journal); the analysis runs on the VM.

```sh
# on ludovico, read-only
mkdir -p /tmp/lr && cp ~/.podium/perf/loop-server.ndjson /tmp/lr/
journalctl --user -u podium.service --since "<end - 25 h>" -o cat -g '"loop minute"' \
  | grep '"component":"server"' | jq -c '{at,v}' > /tmp/lr/minute-versions.ndjson
journalctl --user -u podium.service --since "<end - 24 h>" --until "<end>" -o cat \
  -g 'server event-loop stall' > /tmp/lr/stalls-24h.ndjson
journalctl --user _PID=$(cat ~/.podium/run/server.pid) --since "<restart>" --until "<restart + 3 min>" -o cat > /tmp/lr/boot.log
scp /tmp/lr/* polaris-agents:server-data-bench/live-result/
# on the VM
bun scripts/server-data-bench/live-baseline.ts --minutes=~/server-data-bench/live-result/loop-server.ndjson \
  --versions=~/server-data-bench/live-result/minute-versions.ndjson --end=<end ISO> --since-restart=<restart ISO>
bun scripts/issue-stall-composition.ts --top=12 < ~/server-data-bench/live-result/stalls-24h.ndjson
grep 'boot stage completed' ~/server-data-bench/live-result/boot.log | jq -c '{stage, stageDurationMs, durationMs}'
```

Then fill this table next to the baseline (baseline values from [baseline §1](pod-6140-baseline.md#1-live-baseline)):

| metric | baseline 24 h median | result 24 h median | baseline 1 h median | result 1 h median | baseline since-restart median | result since-restart median |
|---|---:|---:|---:|---:|---:|---:|
| utilizationPct | 51.9 | – | 57.3 | – | 58.7 | – |
| blockedPct | 15.1 | – | 24.6 | – | 22.0 | – |
| stalls/min | 17 | – | 27 | – | 24 | – |
| SQL statements/min | 35,302 | – | 40,624 | – | 45,518 | – |
| SQL wall ms/min | 3,164 | – | 4,813 | – | 4,668 | – |
| `ws.daemon` frames/min | 27,896 | – | 29,299 | – | 33,827 | – |
| SQL statements per daemon frame | 1.25 | – | 1.45 | – | 1.28 | – |
| RSS MiB | 1,414 | – | 1,497 | – | 1,460 | – |
| heap used MiB | 588 | – | 573 | – | 562 | – |
| boot to `listen` (ms, process uptime) | 15,138 | – | | | | |

Read it with care: live load changes from day to day (frames roughly tripled from September to October), so a
live number moves for reasons other than the code. Compare statements per daemon frame and memory first; they
depend least on load.

## 3. Design §9, criterion by criterion

| # | criterion (design §9) | verdict | evidence |
|---|---|---|---|
| 1 | No whole-table copy in memory: memory grows with live activity, not with total issues and sessions; boot loads no whole table | **Partly met.** No copy is left and memory is flat across corpus sizes; boot still reads whole tables | Every §6 copy is deleted: users 83b6ae6e65, grants 6547237af0, machines 6848269105, pending counters bdafc80949, folder lookup and the world index 656db88df5, observation checkpoint map 18ea93d33c, raw `change_latest` copy b258585562, change baseline e1db4b96b6, issue map e61e461a2a, session map down to running sessions 932d0f34f0 / 0c37f9eb50 / 1ffea032ab. Bench: B's RSS 326 → 334 MiB from h1a1 to h10a1 (A 457 → 1,188). Not met: boot reads every session, issue, issue user state, dep, machine, ship order and automation once to feed the ledger reconcile and then drops them (`relay.ts:518-568`, `issues/service/core.ts:667-747`, `sessions/repository.ts:1274,1289`), listed as `WHOLE_TABLE_READS` in `store/query-plan-audit.test.ts:518-643`; boot grows 1.8 s → 9.4 s with the corpus. Filed as POD-6221. Runtime whole-table reads remain for client sync bootstrap (`installedWorld`, `sync-worker/visibility.ts:28`, sync scope) and the deck and issue tree (`deck.ts:70`, `reads.ts:605`). |
| 2 | Every operation's statement count is pinned by a test and does not grow with data | **Pinned for every listed operation; two growths filed (POD-6228, POD-6229)** | 22 statement-count test files (harness `test-support/statement-count.ts`: the same count at 5 and 200 rows; `expectArmed` proves a pin armed by planting a read per row on the operation's own path, which must fail it). Pinned before POD-6227: daemon frames (most kinds), feed visibility, issue listings and writes, session records, parked rename, message delivery and flush, host sample, steward poll, covered-prefix recovery, request credential (POD-6220), grant reads incl. tRPC `issues.update` and `sessions.rename` (POD-6217), board drain (POD-6216), boot ref backfill (POD-6222), search (POD-6214). POD-6227 adds, each armed: session create (in process 39 and 40 on an issue, tRPC `sessions.create` 38); mail send to a running session (tRPC 67, relay 61) and to an issue (tRPC 19, relay 25, `issues.mailSend` 33); the sync feed: `hello` 1 (2 with a cursor), the worker's bootstrap 8 and delta 8 counted on the worker's own read-only connection (raw statements included), in-process `syncChangesSince` 7 (snapshot) and 8 (delta); `agentFrameBatch` 0, `title` 10, `hostMetrics` 2, `inventoryReport` 19 (6 when unchanged); all 44 correlated `*Result` replies 0, `approvalExecResult` 19, `sessionKillResult`, `sessionOpenUrlResult` and the headless results 0, `scanResult` / `conversationsChanged` of known conversations 5. Fixed in POD-6227: a conversation discovery registered and indexed each conversation on its own (about 4 statements per conversation, every sweep re-offers the whole corpus) and now writes each kind once per report (`ConversationRegistryRepository.ensureMany`, one-statement index upsert); a feed admission read the change-log head a second time for a trace that is off by default (`hello` 2 → 1). Filed, with numbers: a discovery of N new conversations still upserts `change_latest` once per change (5 → 200; sync behaviour, POD-6228, deferred); a send to a session whose issue holds queued mail re-attempts each held message on its own (100 → 1,272 statements at 5 → 200 held messages before POD-6219 landed, POD-6229, `it.skip` in `mail-send.statement-count.test.ts`). Reads that page or chunk grow by one per page or chunk by design (change-log pages of 500/1000, IN lists per 250/500 keys, `changes` appends per 100 rows). Boot is not pinned: it reads whole tables (criterion 1, POD-6221). On the bench, statements per minute do not grow with data (89,308 → 89,544, +0.3%, h1a1 → h10a1). |
| 3 | Every repository query is served by an index | **Met, with listed exceptions** | `store/query-plan-audit.test.ts:1050-1218` runs `EXPLAIN QUERY PLAN` on every `prepared` / `preparedFamily` query in `apps/server/src/store` and `packages/sync/src/adapters/sqlite` (over 500) and fails on any unexplained scan or temporary sort; it also proves itself with a planted unindexed query. Explained exceptions: 4 low-selectivity columns, 25 small tables, about 50 bounded sorts, 31 whole-table reads (criterion 1), and 2 shape debts waiting on full-text search (POD-5617). Raw SQL outside the repositories is censused since POD-6227 (`rawSqlSites`, same test file): 63 raw statements in the server's and the sync package's source, the 7 that run on the server schema at run time (the sync worker's 5, the update recovery checkpoint's 2) planned like repository queries, the rest exempt with a reason (drivers, migrations and one-time boot imports, the phone replica's own database). |
| 4 | The old-versus-new comparison stays clean for each removed copy | **Met for the tests; the development-build runtime checks have no recorded result** | Folder lookup 28447e4de4 (`folder-owner-parity.test.ts`, corpus and edge cases; one deliberate difference pinned in 656db88df5). Raw `change_latest` copy ecc1c21e82 (`feed-visibility-anchors-parity.test.ts`: 8,755 refs, 3,063 edges, every value agree). Change baseline 884d4a4d25 (`authority-dedup-replay.test.ts`: byte-identical except the order of removes inside one reconcile). Issue map: `PODIUM_ISSUE_MAP_PARITY` (a83627bb4d, 566bb451da, ecbfe91388, 4b299555e5, fc6697a791; listings 553 calls, hierarchy 996 reads, boot reconcile 4,867 issues, no difference). Session map: `records.parity.test.ts` over all 4,304 corpus sessions and 4,600 selections (b2c0dd190c). Smaller removals: checkpoint map 7b7e85ef3c, grants a7fd798d74, machines 257d265e38, pending counts 99fe7e2414. The issue-map and session-map runtime checks in development builds (`PODIUM_ISSUE_MAP_PARITY`, `PODIUM_SESSION_MAP_PARITY`) existed before deletion, but no soak result is recorded in a commit or doc. |
| 5 | Measured against the fresh baseline: memory, boot time, busy share and stalls no worse after each landing, and better at the end | **Memory, boot and stalls: met. Busy share: not met on the small corpus**; live pending | Run 1 (h1a1, realistic, 3 rounds per arm): end RSS −28.6%, heap −41.1%, boot −8.1%, stalls 4.97 → 0 per minute, all outside the noise band; utilization **+6.3%** (46.0 → 48.9%) and blocked +3.2%, outside the ±1.5% / ±2% band. Run 2 (h10a1): utilization −6.6%, blocked −19%, boot −52%, RSS −72%. The cause is the extra SQL (+29% statements, +16% SQL wall), ranked in §4. Live: §2, pending the deploy. |

## 4. Remaining hot paths

Ranked by SQL wall time per minute in B, run 1 (B total: 9,956 ms/min of SQL wall, 89,308 statements/min), with
callers from a `--profile=full` round at 88ba2a24d1 (the same server code on these paths;
`~/server-data-bench/runs/2026-10-17T08-37-19-369Z-profile-tip-h1a1-running/A-r1/stacks.json`). One sub-issue of
POD-6140 per hot path, each with its numbers in the brief.

| rank | hot path | B statements/min | B SQL ms/min | share of SQL wall | in A? | sub-issue |
|---:|---|---:|---:|---:|---|---|
| 1 | Runtime-event board projection: `listRuntimeEventsAfter` at ~1.2 ms per call plus one cursor write transaction per record (`runtime-event-gate.ts:529-545`) | 5,595 | ~4,020 | 40% | yes, equal | POD-6216 |
| 2 | Grant reads per change batch (feed visibility `forBatch` and the session projection pass) | 8,062 | 981 | 10% | 3,541 / 354 | POD-6217 |
| 3 | Earliest admin per session read (`view.ts:293 defaultPrincipal`), ~4 per runtime event, plus 4 per mail delivery | ~9,400 | ~500 | 5% | yes | POD-6218 |
| 4 | Credential resolved twice per tRPC request (4 `cli_sessions` reads, user, credentials) | ~12,500 | ~450 | 4.5% | yes, equal | POD-6220 |
| 5 | Pending-mail counts on every eligibility change (session and issue, plus an issue lookup) | ~8,000 | ~400 | 4% | no (in-memory counters) | POD-6219 |
| 6 | Boot whole-table reconcile: 9.4 s boot on h10a1, of which 6.5 s whole-table reads | (boot) | (boot) | – | yes, slower | POD-6221 |

**Looked at, not filed:**
- *Parked session writes* (the POD-6210 report): ~6.5 extra statements per parked rename, ~600 statements/min at
  the realistic share. POD-6210 already halved the row reads; too small to rank now.
- *Per-attempt recipient reads in mail delivery* (coordinator note from POD-6174): shows (4 earliest-admin lookups
  and 3 session reads per message), about 1k statements/min at 120 mails/min; folded into POD-6218, which fixes the
  same lookup.
- *Sync commit reads* (`change_latest` read per commit 3,122/min at 128 ms; retention floor `min(seq)` per publish
  3,634/min at 77 ms): sync-system paths, out of POD-6140's scope and cheap per call.
- *Machine row per session command* (`machine-access.ts:132`, 1,860/min at 153 ms): a point read, 1.5%.

**Caches.** None is proposed outright. The one candidate is POD-6218 (the earliest admin): it is asked about 4 times
per runtime event across separate operations, so a per-operation memo may not be enough. If it still shows after that
fix, it would be the first cache through the cache interface (POD-6150), declared with key = the instance's earliest
active admin, one entry per instance, removed after a committed write to `users`. Every other hot path is a query
or batching fix.
