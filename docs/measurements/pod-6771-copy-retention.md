# Sync log retention measurement

Issue: POD-6771, under POD-6253. Timed candidate:
`a3b9a5069e815d8926efe134e1ad05ee5a1eb450`, based on parent
`96fcf8204c27ecd90d9c75bcf64ef73bda501ca6` on `integrate/6253-sync-log`.
The subsequent handoff changes only this report and the retention ADRs.

The durable `change_latest` table, its queries/writes, and the declared-change
capture/reconcile APIs are removed. Bootstrap and access checks build current
records from model rows; writes compare the records around their source write.
Defaults are 30 days and 500,000 rows per database feed, whichever removes more.
The current database has one feed. Tenant partitioning belongs to hosting;
these budgets must be applied per tenant feed there. Client wire version is 5.
The parent session activity publication behavior is preserved.

## Validation

All runtime checks, builds, and measurements ran on an isolated agents VM.
No full suite or ChatView test was run.

- Focused rerun: 504 passed, 13 failed. The migration drop/convergence,
  schema generation audit, query-plan guards, transaction/visibility/bootstrap
  coverage, kernel suites, and discovery statement-count tests passed.
- The coordinator authorized correcting missing paging methods on the layout
  and read-position repository fakes. Their two files then passed all 6 tests.
- All 10 remaining failures were run exactly once on the parent; all 10 fail
  there too. The per-test results below make the remaining limitation explicit.
- Lean gate green at `d32af5577d`: all 30 typecheck tasks, static checks,
  and 163 boot/wiring tests in the four selected files passed. The later
  `a3b9a5069e` change contains only the two test-fake corrections.
- Web and phone builds passed sequentially at `d32af5577d`; web bundle
  correctness passed. Both build stamps have wire schema `2140d2b5df97289f`.
- The scanResult discovery pin writes zero copy rows, appends once for 5 records
  and twice for 200 records, and keeps the remaining statement count fixed at 9.
  All 11 daemon-results statement-count cases pass.

## Existing failures on both revisions

All ten remaining failing test names were run exactly once on parent `96fcf8204c27ecd90d9c75bcf64ef73bda501ca6`. All ten failed there as well. No other tests were selected (202 skipped).

| Test | Parent result | Candidate result |
|---|---|---|
| server seq stays monotonic, the epoch does not bump, and the replay buffer survives a daemon disconnect + rebind | Failed | Failed |
| create → claim → comment → close yields identical rows, events, comments, and folded oplog via IssueService, the CLI command registry, and the tRPC router | Failed | Failed |
| assembles recovery-only over a query-only store without running writable boot repairs | Failed | Failed |
| replays buffered output to a client that attaches after frames were produced | Failed | Failed |
| resets the replay buffer on a screen clear so replay starts from the clear | Failed | Failed |
| attachClient welcomes the client, and its HTTP bootstrap carries the session and conversation snapshots | Failed | Failed |
| defers daemon inventory and idle-pressure writes across the transfer fence | Failed | Failed |
| resumes a Grok row admitted just before its child exit reaches the server | Failed | Failed |
| delivers once when bind/live metadata makes queued issue mail eligible | Failed | Failed |
| delivers a child worker's queued reply to the coordinator on the parent issue | Failed | Failed |


The additional three candidate bootstrap errors were missing paging methods on the layout/read-position fakes. The coordinator authorized their correction; the two files then passed all six tests.

## Disk budget and decision

As of 2026-11-11T13:32:19.897Z. Source: the stopped candidate's B1 database
from the A/B run below. Its latest 10,000 slim actions contained 9,350 session
and 650 issueProjection records, totaling 7,879,811 payload bytes (788 bytes
per action). The measurement replayed that observed mix into a temporary
SQLite table with the production columns and both indexes, up to 500,000 rows.
It compacted the file with `VACUUM` and measured `page_count × page_size`.
The temporary database was then removed; the source arm was opened read-only.

| Measurement | Value |
|---|---:|
| Empty table and indexes | 20,480 bytes |
| 500,000 rows and both indexes | 549,388,288 bytes / 523.94 MiB |
| Allocation per action above empty overhead | 1,098.74 bytes |
| Design rate | 15,549 actions/day |
| Projected 30-day rows | 466,479 |
| Projected 30-day allocation | 512,557,571 bytes / 488.81 MiB |
| Cap reached at design rate | 32.16 days |

Keep **30 days / 500,000 rows per feed**, whichever removes more, as recorded
in [ADR 2 Amendment 2](../adr/0002-sync-protocol-amendment-2.md). The measured
cap is about half a GiB for this slim-record mix. This is a compacted feed
allocation estimate; it excludes other model tables and WAL, and record sizes
and steady churn can change file allocation. It is not a byte quota.

Reproduce on an isolated bench VM with a stopped candidate arm:

```sh
bun --conditions=@podium/source scripts/server-data-bench/retention-disk.ts \
  --db="<bench-root>/runs/<run>/B-r1/state/podium.db" \
  --out="<bench-root>/runs/<run>/retention-disk.json"
```

## A/B interpretation

The SQL statement reduction is 3.013%, beyond the historical ±0.5% count band.
The measured copy writes fall from 3,370/min to zero, while log inserts stay at
3,344/min. Boot time falls 14.9%, boot RSS falls 27.6%, and blocked loop share
falls 4.9% at the same daemon throughput.

SQL wall time increases **159.22 ms/min (+1.537%)**, just beyond the historical
±1.5% band. This is a marginal increase to flag in review, not a SQL timing
improvement. Most of the higher measured cost is in existing offers, drafts,
observation-checkpoint and event SELECTs whose frequencies are unchanged;
those query paths are unchanged by this issue. The lower overall blocked share
and boot/memory costs support the copy removal while making this component
tradeoff explicit. End RSS and daemon handling wall time remain within their
noise bands. Compare against the [recorded bands](pod-6140-baseline.md#3-noise-band-and-first-ab),
which are historical measurements rather than a fresh same-code noise run.

All six rounds have four complete loop minutes, zero socket errors, zero daemon
reconnects and zero dropped frames. Each has one `issues.update` HTTP 409
revision conflict, alongside 10,812–10,813 successful RPC writes. The same
conflict occurs in every parent and candidate round; the workload comparison
includes it. The comparison covers the stated h1a1/1x workload.

Evidence directory on the bench VM:
`~/server-data-bench/runs/2026-11-11T13-18-08-573Z-pod-6771-copy-retention/`.
The issue artifacts contain this report and aggregate JSON measurements;
raw server and test logs are not attached.

## Server data bench 2026-11-11T13-18-08-573Z-pod-6771-copy-retention

As of 2026-11-11T14:00:02.503Z on the isolated agents VM. A = 96fcf8204c27ecd90d9c75bcf64ef73bda501ca6, B = a3b9a5069e815d8926efe134e1ad05ee5a1eb450.
Cell h1a1 seed 4443 (4867 issues, 4304 sessions, 84 live on 6 machines).
Load 1x: 28000 daemon frames/min, 1860 session + 220 issue writes/min (session writes targeted 95% to live sessions), 4 clients; 4 measured minutes per round, 3 rounds per arm, order A B A B A B; issue-map comparison A off, B off (PODIUM_ISSUE_MAP_PARITY); session-map comparison A off, B off (PODIUM_SESSION_MAP_PARITY).
Per-round values are medians over that round's whole minutes; the table shows the median over rounds and the min–max over rounds.
Round windows (start UTC): A1 13:20, B1 13:26, A2 13:35, B2 13:41, A3 13:49, B3 13:55; no gaps over 5 min.

| metric | A 96fcf8204c median (min–max) | B a3b9a5069e median (min–max) | B vs A | what it counts |
|---|---:|---:|---:|---|
| bootListenMs | 883 (838–934) | 751 (745–775) | -14.9% | process start to the `listen` boot stage (server:boot log), ms |
| rssAfterBootMiB | 292 (229–300) | 212 (209–215) | -27.6% | server RSS when startServer resolved, MiB |
| rssEndMiB | 392 (385–394) | 371 (362–392) | -5.5% | server RSS at the end of the load window, MiB |
| heapEndMiB | 102 (98.6–106) | 84.0 (83.5–102) | -17.8% | server heap used at the end of the load window, MiB |
| utilizationPct | 45.1 (44.7–45.2) | 44.4 (43.8–44.6) | -1.4% | event-loop utilization, median of window minutes (loop-server.ndjson) |
| blockedPct | 21.8 (21.5–22.0) | 20.7 (20.7–20.9) | -4.9% | share of the minute the loop was blocked, median of window minutes |
| stallsPerMin | 0.99 (0.50–1.98) | 0.50 (0.00–1.49) | -49.8% | event-loop stalls per 60 s of wall time, median of window minutes |
| minuteSpanS | 60.5 (60.5–60.5) | 60.5 (60.5–60.6) | -0.1% | wall seconds one loop minute (60 sample windows) took, median; >60 means the sampler ran late |
| sqlStatementsPerMin | 109736 (109723–109747) | 106429 (106388–106435) | -3.0% | SQL statements per minute over the exact window (attribution totals diff) |
| sqlWallMsPerMin | 10358 (10325–10464) | 10517 (10477–10521) | +1.5% | SQL wall ms per minute over the window (attribution totals diff) |
| daemonFramesPerMin | 28069 (28069–28071) | 28070 (28070–28071) | +0.0% | daemon WebSocket frames handled per minute over the window (ws.message.daemon task count) |
| daemonWallMsPerMin | 1119 (1094–1127) | 1107 (1101–1119) | -1.1% | ms per minute handling daemon frames over the window (ws.message.daemon task wall) |
| clientFramesPerMin | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) | – | client WebSocket frames handled per minute over the window (ws.message.client task count) |
| daemonReconnects | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) | – | times the server dropped a fake daemon during the round (each reconnects after 1 s); 0 unless overloaded |
| framesDroppedPerMin | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) | – | daemon frames per minute that came due while their daemon was disconnected (not sent) |
| windowSqlPerDaemonFrame | 3.91 (3.91–3.91) | 3.79 (3.79–3.79) | -3.0% | all SQL statements in the window / daemon frames in the window |
| sqlPerDaemonFrame | 3.91 (3.90–3.91) | 3.79 (3.79–3.79) | -3.0% | SQL statements per daemon frame per loop minute (sql / ws.daemon bucket counts), median — the live figure's definition |

Statements per minute by operation kind (verb + first table; lifetime attribution totals diffed over the window, median over rounds):

| kind | A | B |
|---|---:|---:|
| select sessions | 11246 | 11245 |
| select queued_messages | 8689 | 8689 |
| select session_observation_checkpoints | 7756 | 7756 |
| select podium_events | 7753 | 7753 |
| select offers | 6634 | 6634 |
| select runtime_event_checkpoints | 6634 | 6634 |
| select session_drafts | 6634 | 6634 |
| select conversation_segments | 6617 | 6616 |
| select issues | 6526 | 6527 |
| select messages | 4125 | 4135 |
| insert change_latest | 3370 | 0 |
| insert changes | 3344 | 3344 |
| select users | 3203 | 3203 |
| insert sessions | 3127 | 3127 |
| select changes | 2328 | 2372 |
