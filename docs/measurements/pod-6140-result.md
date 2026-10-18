# POD-6140 result: server data access, measured against the baseline

The final measurement of POD-6140 (server data access and caching), step 4 of the design
([2026-10-15-server-data-access-design.md](../internal/superpowers/specs/2026-10-15-server-data-access-design.md) §7, §9),
against the fresh baseline in [pod-6140-baseline.md](pod-6140-baseline.md).

- **A** = `e05eeaf1688f92878974d4ce17b3e4104f119179`, the commit before the first copy removal (parent of
  `83b6ae6e65` "Remove the world index's users copy", the first C1 commit on `issue/6140-…`). It already has the
  foundations: prepared queries (POD-6147), indexes and planner statistics (POD-6148), statement-count tests (POD-6149).
- **B** = `ae0361d75f4c25e05037a94d65c896d0592bb49f`, the integration tip once POD-6210 and POD-6214 had landed: every copy removed.
- **As of:** bench runs 2026-10-17T09:11Z to 11:09Z on the polaris agents VM (4 CPU, 12 GB); the live half is pending (§2).

**Re-measured after the F lanes (§5, POD-6230):** the same A against B = `7c3a9e912b`, every F lane landed.
The busy share is now better than A's (43.4% against 44.7% on the small corpus, 42.9% against 52.0% on the large one),
SQL is down 14% in statements and 36% in wall time, and memory, boot and stalls stay better. Every design §9 measurement
criterion is met on the bench; what is still open is boot's whole-table reads (POD-6221) and the live half.
The change-log insert's 2.7x cost in that B came from a savepoint journal spilling to disk after POD-6160's sessions
indexes, not from the sync copy removals; POD-6232 fixed it (§5, SQL wall −5.9%).
Sections 1–4 are the first result and are kept as they were.

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

## 5. Re-measure after the F lanes (POD-6230)

The F lanes (POD-6216 to POD-6231, design §11) fixed the hot paths of §4. This section repeats §1's bench
against the same A, with every F lane landed.

- **A** = `e05eeaf1688f92878974d4ce17b3e4104f119179`, as in §1.
- **B** = `7c3a9e912b0d8fde40054fdab5f322159fd95e02`, the integration tip once F1–F5, F7–F11, F13 and F14 had landed.
- **As of:** bench runs 2026-10-17T22:07Z to 23:24Z on the polaris agents VM (4 CPU, 12 GB). The live half is still
  pending (§2).
- **Template:** since a10462026a (POD-6223) the bench seeds an analysed template (`-t2`) and B drops the statistics
  of tables under 1,000 rows. Each arm boots its own template of the same corpus, so compare these numbers only
  within this A/B, not with §1.

### What was run

The recipe of §1, at 1x load, 4 measured minutes per round, realistic session-write targeting (95% to live sessions).
One `polaris-lane` call per round; no gap between rounds was over 5 minutes.

| run | corpus | rounds | round windows (UTC, start–end) | evidence on the VM (`~/server-data-bench/runs/…`) |
|---|---|---|---|---|
| 1 (main) | h1a1 | 3 per arm, A B A B A B | A1 22:07, B1 22:13, A2 22:19, B2 22:25, A3 22:31, B3 22:37–22:42 | `2026-10-17T22-05-30-788Z-final2-h1a1-running` |
| 2 | h10a1 | 1 per arm | A1 22:49, B1 22:55–23:00 | `2026-10-17T22-43-21-774Z-final2-h10a1-running` |
| 3 | h1a1, plus 120 mails/min to 5 live sessions | 1 per arm | A1 23:01, B1 23:07–23:12 | `2026-10-17T23-00-14-743Z-final2-h1a1-running-mail` |
| 4 | h1a1, `--profile=full` (caller stacks; its times are not comparable) | 1 per arm | A1 23:13, B1 23:19–23:24 | `2026-10-17T23-12-20-402Z-final2-profile-h1a1-running` |

### Run 1: small corpus (the main result)

| metric | A e05eeaf168 median (min–max) | B 7c3a9e912b median (min–max) | B vs A | noise band | what it counts |
|---|---:|---:|---:|---:|---|
| bootListenMs | 2,064 (1,912–2,069) | 1,741 (1,705–1,743) | −15.6% | ±8% | process start to the `listen` boot stage, ms |
| rssAfterBootMiB | 521 (512–522) | 355 (316–355) | −32.0% | ±9% | server RSS when `startServer` resolved |
| rssEndMiB | 465 (452–497) | 320 (313–329) | −31.2% | ±9% | server RSS at the end of the load window |
| heapEndMiB | 129 (122–130) | 70.1 (66.4–79.6) | −45.8% | ±12% | server heap used at the end of the load window |
| utilizationPct | 44.7 (44.5–45.9) | 43.4 (42.6–44.5) | **−2.9%** | ±1.5% | event-loop utilization, median of window minutes |
| blockedPct | 23.8 (23.7–26.2) | 20.3 (20.2–21.3) | −14.8% | ±2% | share of the minute the loop was blocked |
| stallsPerMin | 5.94 (4.96–6.44) | 0.00 (0.00–0.00) | −100% | ±40% | stalls per 60 s of wall time |
| minuteSpanS | 60.6 (60.5–60.6) | 60.4 (60.4–60.4) | −0.3% | – | wall seconds per loop minute |
| sqlStatementsPerMin | 69,119 (69,114–69,139) | 59,516 (59,497–59,524) | −13.9% | ±0.5% | SQL statements per minute, exact window |
| sqlWallMsPerMin | 8,604 (8,490–8,796) | 5,492 (5,471–5,582) | −36.2% | ±1.5% | SQL wall ms per minute, exact window |
| daemonFramesPerMin | 28,070 (28,070–28,071) | 28,071 (28,071–28,073) | +0.0% | (load) | daemon frames handled per minute |
| daemonWallMsPerMin | 1,209 (1,201–1,219) | 1,238 (1,222–1,251) | +2.4% | ±3% | ms per minute in daemon frame tasks (synchronous part) |
| sqlPerDaemonFrame | 2.46 | 2.12 | −13.9% | ±0.5% | SQL statements per daemon frame (the live figure's definition) |

### Runs 2 and 3, the main metrics

| metric | run 2 h10a1 A | B | B vs A | run 3 mail A | B | B vs A |
|---|---:|---:|---:|---:|---:|---:|
| bootListenMs | 20,772 | 8,618 | −58.5% | 2,033 | 1,765 | −13.2% |
| rssEndMiB | 1,207 | 347 | −71.3% | 483 | 342 | −29.3% |
| heapEndMiB | 464 | 66.5 | −85.7% | 139 | 79.3 | −43.1% |
| utilizationPct | 52.0 | 42.9 | −17.6% | 48.3 | 44.1 | −8.7% |
| blockedPct | 32.7 | 20.9 | −36.1% | 27.9 | 22.6 | −19.2% |
| stallsPerMin | 14.8 | 0.00 | −100% | 5.92 | 0.00 | −100% |
| sqlStatementsPerMin | 68,983 | 59,719 | −13.4% | 75,082 | 65,139 | −13.2% |
| sqlWallMsPerMin | 8,090 | 5,518 | −31.8% | 10,254 | 6,370 | −37.9% |
| daemonWallMsPerMin | 1,148 | 1,203 | +4.8% | 1,103 | 1,125 | +1.9% |

Mail adds about 50 statements per message in A and 47 in B (run 3 against run 1, at 120 messages/min).
Statements per minute still do not grow with data: B runs 59,516 on h1a1 and 59,719 on h10a1 (+0.3%).

### The daemon wall rise: the loop is less busy, not more work per frame

POD-6219 and POD-6223 saw `daemonWallMsPerMin` +3–5% in their own A/B runs. It shows here too (+2.4%, +4.8%, +1.9%),
so I took the profiled pair (run 4) and compared every run on this VM. The cause is that **the time per daemon frame
falls as the loop gets busier with other work**, and B's loop is the least busy. B does no extra work per frame.

Daemon frame time per frame (daemon wall / frames handled, µs), the same code with and without mail load:

| build | h1a1 | h1a1 + 120 mails/min | h10a1 | SQL wall ms/min, h1a1 |
|---|---:|---:|---:|---:|
| A `e05eeaf168` (this run) | 43.1 (42.8–43.4) | 39.3 | 40.9 | 8,604 |
| B `7c3a9e912b` (this run) | 44.1 (43.5–44.6) | 40.1 | 42.9 | 5,492 |
| B `ae0361d75f` (§1) | 37.9 (37.7–38.4) | 34.9 | 38.7 | 9,956 |

- **Same code, busier loop, cheaper frames.** Mail adds no daemon frames (28,069–28,071/min in every round), yet it
  cuts the time per frame by 8–9% in all three builds. The larger corpus does the same for A, whose loop is busier there.
- **Across builds it follows the load.** The §1 B was the busiest build (10.0 s of SQL per minute) and had the lowest
  time per frame; this B is the least busy (5.5 s) and has the highest. A's own figure is stable across runs
  (1,206 ms/min in §1, 1,209 here).
- **The lanes' readings fit.** POD-6223's run was repeated with the arms swapped and both times the build that removed
  2.6 s/min of SQL (the slow runtime-event list read) had 5–7% more daemon wall (`…T14-52-23-533Z-dc82fc3c-f8007289`,
  `…T16-37-27-583Z-f8007289-dc82fc3c`). POD-6222, whose change runs only at boot, also read +7%
  (`…T14-37-14-277Z-pod6222-ref-backfill`). A lane's ±5% on this metric is not evidence of new work by itself.
- **The profile shows no new work inside a frame.** Under `--profile=full`, the only statement whose caller stack
  runs synchronously inside the daemon frame task is the observation checkpoint read, with the same count in both
  arms (5,785). Task wall counts only a callback's synchronous part, so SQL after the first `await` is not in this figure.
- **Not proven:** why one frame costs more on an idler loop. A likely reason is that a frame is more often handled
  alone, from cold caches, than back to back with others. It does not change the verdict: total utilization is what
  fell.

### The `setTimeout(0)` jump: the coalesced delivery flush (POD-6219)

| | A median (min–max) | B median (min–max) |
|---|---:|---:|
| `setTimeout(0) <anonymous>` tasks/min | 1,750 (1,749–1,765) | 3,417 (3,412–3,421) |
| their wall ms/min | 10 | 63 |
| flush target checks (`MessagesRepository.pendingTargets`) per min | 0 | 1,497 (1,488–1,499) |
| their SQL wall ms/min | 0 | 99 |

The extra timers are the delivery flush. Before POD-6219 (197ab798ca) a trigger counted its target's pending mail
and armed nothing when the count was 0. Now every trigger queues without a read and arms the zero-delay flush
(`DeliveryScheduler.scheduleDeliveryFlush`, `modules/messages/scheduler.ts:154`). It does coalesce: one timer for
every target queued in the same task, then one check statement for all of them (2 or more targets per check here).
So about 1,500 flushes per minute, one per write that queued targets, against +1,667 timers per minute. Cost: +53 ms/min
of timer wall and 99 ms/min of check SQL, in place of the ~8,000 counts per minute that the triggers ran before (§4 rank 5).
Not filed.

### The sixth `podium_events` index: append cost

003daba66d (POD-6224) added `idx_podium_events_kind_subject_id (kind, subject, id)`. Per append, run 1 (all six rounds):

| | A | B |
|---|---:|---:|
| `insert into podium_events` per minute | 1,671 | 1,671 |
| µs per insert, per round | 449, 442, 454 | 499, 502, 534 |
| SQL wall ms/min, median | 751 | 839 |

An append costs about 53 µs more (+12%), 88 ms per minute at this rate. The read the index serves (a session's newest
runtime events) went from 2,238 calls at 1,274 µs (2,851 ms/min) in A to 1,119 calls at 131 µs (146 ms/min) in B;
POD-6216 also halved its calls. The append is the most expensive statement in both arms, at about 0.5 ms each.

### Where B's SQL time goes now

Run 1, B round 2: 5,471 ms/min of SQL wall, 59,516 statements/min. No statement takes more than 15%.

| statement | per min | ms/min | µs each | in A (per min / ms/min) |
|---|---:|---:|---:|---|
| `insert into podium_events` | 1,671 | 839 | 502 | 1,671 / 739 |
| `insert into changes` (the change log) | 3,342 | 563 | 168 | 3,342 / 205 |
| issue row by id | 3,301 | 460 | 139 | 3,238 / 393 |
| `insert into sessions` (session upsert) | 3,121 | 449 | 144 | 3,541 / 410 |
| grants read, one per session rename | 1,860 | 438 | 235 | other shapes in A |
| session row by id | 3,216 | 328 | 102 | 3,121 / 288 |
| earliest admin with its row (POD-6218) | 1,346 | 203 | 151 | 4,489 / 408 (id only) |
| grants read, a second shape | 2,853 | 186 | 65 | other shapes in A |

**The change-log insert, slower per row in B (POD-6232, fixed):** 168 µs against 61 µs, at the same 3,342 per minute
(+358 ms/min, 10% of B's SQL wall). It is not the sync copy removals (C3), and not the insert itself:

- *Same statement, same rows.* The SQL text is the same one-row `insert into changes` in both arms. Two rounds that kept
  their databases (1cbe48131b, 0c37f9eb50) appended the same rows: 10,037 and 10,038 session upserts, average payload
  847 bytes in both, provenance columns empty in both. The table and its indexes are the same in both templates.
- *Where it started.* The bench history on the VM has the insert at 55–58 µs on the C3 commits themselves
  (`e1db4b96b6`, `20d4821b12`), which already read `change_latest` before each append. A bisect over the session map
  removal puts the jump at `b2c0dd190c` (POD-6160, D2a/D2b): 57 µs on its parent `1cbe48131b`, 136 µs on it, 130–170 µs
  on every later commit.
- *Why.* `b2c0dd190c` added five indexes on `sessions`. A session rename runs `Authority.commit` inside the rename's own
  transaction, so its sessions upsert runs inside a savepoint, and the change append opens a second one. SQLite copies
  every page first written inside a savepoint to the sub-journal, which stays in memory up to 64 KiB and then spills
  to a temp file (create, unlink, the 64 KiB, close). The five more index pages put the rename's write over 64 KiB, and
  the spill happens inside the next statement: the change-log insert.
- *How that was shown* (diagnostic builds, 2-minute rounds, h1a1, realistic targeting; parent `1cbe48131b` against
  `b2c0dd190c`):

  | build | `insert into changes`, µs each | what it rules in or out |
  |---|---:|---|
  | probe times only the synchronous driver call | 52 → 133 | the time is SQLite's, not other work charged to the statement's `await` |
  | 64 MiB page cache | 45 → 129 | not page-cache misses |
  | `temp_store = MEMORY` | 51 → 46 | the sub-journal's temp file |

  With each write tagged by its open savepoints (tip `331ed4ee41`): on the rename path (1,860/min) the sessions upsert
  runs at depth 1 (149 µs) and the insert at depth 2 (247 µs). On daemon-frame session writes (1,485/min) the commit is
  top level: upsert at depth 0, insert at depth 1, 57 µs. Weighted, 163 µs, the 168 µs above.
- *Fix* (POD-6232): the store connection keeps temp files in memory (`temp_store = MEMORY`) once it is open for traffic
  (`serveTrafficTempStore`, last step of `SessionStore.open`). Migrations, boot repairs, the full-text setup and the
  opening statistics run before that with temp files on disk, and so does the hourly statistics refresh
  (`withFileTempStore`), because an index build sorts in temp and over the 2 GB `applied_mutations` table that sort must
  be able to spill. The server creates no temp tables. `store-lifecycle.test.ts` shows the spill on a migration-time
  connection, none on a store open for traffic, and the refresh running with temp files on disk.
- *Measured* (3 rounds per arm, A B A B A B, h1a1, realistic targeting, 4 minutes each, one `polaris-lane` call per round;
  A = `331ed4ee41`, B = `fcf97276ac`; rounds 2026-10-18T01:11Z to 01:46Z; `2026-10-18T01-09-49-795Z-pod6232-guarded-h1a1-running`):

  | metric (median, min–max) | A `331ed4ee41` | B `fcf97276ac` | B vs A |
  |---|---:|---:|---:|
  | `insert into changes`, µs each | 167 (165–170) | 62 (61–63) | −63% |
  | `insert into changes`, ms/min | 558 | 207 | −351 |
  | `insert into change_latest`, µs each | 42 | 32 | −24% |
  | SQL wall, ms/min | 5,437 (5,349–5,500) | 5,116 (5,088–5,122) | −5.9% |
  | SQL statements/min | 59,528 | 59,542 | +0.0% |
  | utilization, % | 43.1 (42.8–44.1) | 43.0 (42.6–43.2) | −0.4% |
  | end RSS, MiB | 325 (321–328) | 330 (319–344) | +1.6% |
  | boot to `listen`, ms | 1,786 (1,757–1,841) | 1,707 (1,707–1,744) | −4.4% |

  The insert is back at A's cost (61 µs in the run-1 table above). Statement counts do not change, so no pin moves.
- *A possible follow-up, not built:* the sessions upsert sets every column, so each of the sessions indexes is rewritten
  on every write, changed or not. Writing only the changed columns would also cut the upsert's own cost (about
  150 µs) and the pages a rename journals.
- *Found on the way:* 555 `podium_events` inserts per minute run outside any transaction, at 1,295 µs each against 76 µs
  inside one: a WAL sync per insert, about 720 ms/min. Filed as POD-6233.

**Looked at, not filed:**
- *The earliest admin cache* (§4 "Caches"): after POD-6218 it is one read of 1,346 per minute at 203 ms/min, 3.7% of SQL
  wall. No cache is needed.

### Design §9, re-checked

| # | criterion (design §9) | verdict now | evidence |
|---|---|---|---|
| 1 | No whole-table copy in memory; memory grows with live activity; boot loads no whole table | **Partly met (unchanged).** No copy is left and memory is flat; boot still reads whole tables | End RSS in B: 320 MiB (h1a1) and 347 MiB (h10a1); A: 465 and 1,207. Heap in B 70 and 67 MiB; A 129 and 464. Boot still grows with the corpus, 1.7 s → 8.6 s in B, from the boot reconcile's whole-table reads: POD-6221, deferred (sync scope, the operator decides). |
| 2 | Every operation's statement count is pinned by a test and does not grow with data | **Met** | 23 statement-count test files. No pin is skipped: §3's skipped pin (POD-6229, mail to an issue holding queued mail) runs since 798f8b30c0, and the sender pin skipped there runs since 7c3a9e912b (POD-6231). The open growth is POD-6228 (one `change_latest` upsert per discovered conversation), deferred (sync scope). On the bench, statements per minute do not grow with data (59,516 → 59,719, +0.3%, h1a1 → h10a1). Boot is not pinned (criterion 1). |
| 3 | Every repository query is served by an index | **Met, with listed exceptions (unchanged)** | `store/query-plan-audit.test.ts` as in §3. Since a10462026a (POD-6223) the server also drops the planner statistics of tables analysed while under 1,000 rows, so a table analysed while tiny does not mislead the planner when it grows. |
| 4 | The old-versus-new comparison stays clean for each removed copy | **Met for the tests.** The development-build runtime checks can no longer run | The parity tests of §3 stand. `PODIUM_ISSUE_MAP_PARITY` and `PODIUM_SESSION_MAP_PARITY` are gone from the server source along with the copies they compared, so no soak result can be added now; the parity tests are the record. |
| 5 | Measured against the baseline: memory, boot time, busy share and stalls no worse, and better at the end | **Met on the bench.** Live pending | All three runs, B against A: end RSS −29% to −71%, boot −13% to −59%, stalls 5–15 per minute → 0, utilization −2.9% (h1a1, outside the ±1.5% band), −17.6% (h10a1) and −8.7% (mail), blocked −15% to −36%. §1's small-corpus busy share regression (+6.3%) is gone. Daemon frame wall is +2–5%, a side effect of the idler loop (above). Live: §2, pending the operator's deploy. |

**Sub-issues:** none filed by the re-measure. Every criterion that is not met is already filed (POD-6221 boot whole-table reads, POD-6228 change
log upserts, both deferred to the operator) or waits on the operator (the live half, §2). Since then: POD-6232 fixed the
change-log insert (above) and filed POD-6233 (autocommit runtime-event appends).
