# Tenant sync feed measurement and handoff

Issue: POD-6775, under POD-6253. Base: `7a3633c4de99bab3514c72afe3d766aa90d56010`
on `integrate/6253-sync-log`. Measured candidate:
`f8ee17baf9f2fea24600eae4d8aaefe6ce47cad9`. Application code is identical to
`f14548725ead3d7efbbcf661382f68519c33c313`, which passed the lean gate and both
client builds. Between those two revisions, only the measurement harness changes.

The tenant reservation adds one SQL statement per append batch. At matched load,
total statements increase **3.18%**; total SQL wall time changes
**-0.53%**, within the observed variation. Feed-append SQL wall time rises
from **177.50 to 269.99 ms/minute** (**+92.50 ms/minute, +52.11%**).
The cap-sized preserving migration blocks startup for a median **4.92 seconds**
on the synthetic fixture described below.

`changes` and `sync_kind` now have composite tenant keys. `sync_feed` owns the
opaque identity, head and oldest retained sequence. Each append reserves its
numbers by updating the tenant feed row inside the same transaction as the
source write and log inserts. Rollback returns the reservation; retention locks
the same row and updates its floor with the delete. The worker captures head
and floor in one repository read. No runtime head read uses sqlite_sequence.

## Identity and migration

One self-hosted instance is one tenant (`local`); its members share its feed.
This matches PDM-107's `LOCAL_WORKSPACE_ID`, identity memberships and invitations.
`users.id` remains the member, and `identity_user.id` remains the account. Neither
is a tenant key. PDM-107 was inspected read-only on
`integrate/pdm-107-shared-sign-in` (observed tip `93007d2c3d334f29b3c051cc8c9a167b15f256d0`).
See [ADR 13](../adr/0013-tenant-sync-feeds.md) for the shared-store decision,
authorization boundary, staged rollout and Postgres portability work, including
padded checkout upserts from POD-6806.

The coordinator authorized the preserving SQLite rebuild needed to replace the
old single-column primary keys. Its one migration copies every retained action,
provenance value and generation to `local`, preserves feed identity and epoch,
seeds head from sqlite_sequence before dropping the old table, and recreates
both lookup indexes with tenant first. It preserves the head of a fully pruned
log. No model row is rewritten, so this migration requires no kind-generation
bump. Future model migrations must use tenant-aware generation bumps. Client
wire version remains **5** and wire schema digest is `2140d2b5df97289f`.

No rebase was performed. On the final rebase after PDM-107, reconcile/regenerate
the Drizzle snapshot DAG and bundled manifest. This change does not edit its
users or identity schema. Keep the tenant aligned with the identity workspace;
a hosted composition must supply the trusted workspace key before using a shared
model store. Current model builders still use per-database isolation.

## Validation

Runtime checks, builds and measurements ran on the isolated agents VM. No full
suite or ChatView test ran.

- Focused end run: 22 named files, covering tenant isolation, rollback across
  append chunks, migration preservation, retention, bootstrap/delta snapshots,
  query plans, preparation guards and statement counts.
- One fix round and one focused rerun: **108 passed, 3 failed** across eight
  affected files. All tenant checks and the migration's exact contract admission
  pass. The remaining failures are documented below.
- Query-plan audit: **838 definitions, 1,079 statements, zero unexplained scans
  or sorts**. The raw SQL census has 54 exempt statements; the worker's two raw
  cursor queries have become one prepared repository read.
- A single-chunk append is pinned at **2 SQL statements** at 5 and 50 records,
  with a planted per-row read proving the pin is armed. Larger batches retain
  exact 100-row insert chunks and add only one reservation for the whole batch.
- **Lean gate green** at `f14548725e`: all 30 typecheck tasks, static checks and
  163 tests in the four boot/wiring files passed. After the focused rerun,
  mechanical fixes typed two raw migration-test snapshots and registered the
  two new server test files in the generated shard manifest/cache inputs.
- Web and phone builds passed sequentially through the client build wrapper;
  web bundle correctness checked 308 browser chunks. Both stamps carry the
  unchanged wire digest above.
- Drizzle lineage check and generated migration manifest check passed.
- Final source review found the historical provenance fixture booting HEAD and
  rewinding only three columns. The coordinator authorized freezing it to the
  provenance migration boundary. Its one focused run at `d35c9223d3` passed all
  **5 tests**; affected server/scripts typechecks passed (18 tasks including
  dependencies). The benchmark helper's optional statement finalizer was typed
  at the same time. These final changes do not alter production behavior, so the
  already-green lean gate and client builds were not repeated.

Remaining baseline failures, left unchanged at the coordinator's direction:

| Check | Evidence |
|---|---|
| Customer upgrade MU-15, one member | The older sign-in migration assigns client_sessions.session_id; the captured expectation is NULL. It fails on candidate and on base. |
| Customer upgrade MU-15, multiple members | Same mismatch. A single base-only run of the full customer fixture had 12 passes and these same 2 failures. |
| Expand-only audit of the entire historical tree | 30 older contract findings outside this migration remain. The new migration's two preserving re-keys are explicitly admitted; the test rejecting any additional destructive step passes. |

## Startup block at the retention cap

The fixture is synthetic: 500,000 actions with 787 payload bytes each, generated
from the migration schema and fixed strings. It is not populated from an
operator database or backup. The timer wraps the production migration call,
including production backup code **on that synthetic database** and schema
repairs. Fixture seeding, file copy, module import, process start and the final
verification reads are outside the timing window. Each foreground round uses a
fresh process, then removes its files before the next round.

| Round | Migration + local synthetic backup |
|---|---:|
| 1 | 4,919.72 ms |
| 2 | 5,029.20 ms |
| 3 | 4,524.85 ms |
| Median | **4,919.72 ms** |

All rounds preserve head 500,000, floor 1, identity/epoch, 500,000 retained rows
and 393,500,000 payload bytes; foreign-key checks pass. This migration adds about
**five seconds of startup blocking** for this cap-sized fixture on this VM,
separate from the rest of server startup. Storage/cache and payload distribution
can change the time. Earlier storage-limited attempts produced no claimed
measurement; the completed evidence contains only the three successful rounds.

Reproduce on an isolated bench VM:

```sh
bun --conditions=@podium/source scripts/server-data-bench/tenant-migration.ts
```

## Interleaved write cost

The same deterministic h1a1/seed-4443 corpus ran A B A B A B, three rounds per
arm, with four complete loop minutes in every round. All six have matched
throughput, zero dropped frames, zero daemon reconnects and zero socket errors.
Each round has one issues.update HTTP 409 because the workload asks to change a
system-owned shipping stage; the other 10,812–10,813 RPC writes succeed. This
same conflict occurs on both revisions.

Full query-attribution totals are differenced over each exact window and scaled
per minute. The feed-append group is INSERT changes plus UPDATE sync_feed;
transaction-control statements and model-table work are outside that group.
Values below are medians over rounds. The JSON evidence also contains each
round and its range; its total cost is checked against the main harness totals.

| SQL operation group | A statements/min | B statements/min | A SQL ms/min | B SQL ms/min |
|---|---:|---:|---:|---:|
| Whole workload | 106,395.60 | 109,779.60 | 10,229.97 | 10,176.24 |
| Feed append | 3,343.80 | 6,688.80 | 177.50 | 269.99 |
| Log insert | 3,343.80 | 3,344.40 | 177.50 | 155.63 |
| Tenant counter update | 0.00 | 3,344.40 | 0.00 | 114.36 |

The counter itself adds 3,344.4 updates/minute and
114.36 SQL ms/minute (about
34.19 microseconds per update). Feed appends now pay the row-lock reservation
needed for per-tenant commit order. Overall SQL wall medians are 10,229.97 and
10,176.24 ms/minute; ranges are 8,960.77–10,283.73 and 9,937.08–10,575.98.
The ranges overlap. The small overall median difference is within the historical
±1.5% SQL-wall band; the +3.18% statement increase exceeds the historical ±0.5%
count band. These are the [previously recorded bands](pod-6140-baseline.md#3-noise-band-and-first-ab),
not a fresh same-code A/A calibration. The run covers the stated synthetic 1x
workload and preserves the existing per-tenant retention budgets.

Evidence run: `2026-11-11T14-54-58-005Z-pod-6775-tenant-feed` under
`<bench-root>/runs/` on the isolated VM. The issue artifacts contain the
aggregate results, feed-write attribution and synthetic migration timing.
Raw server logs and fixture databases are not attached or committed.

Reproduce on an isolated bench VM, one pair per invocation:

```sh
bun --conditions=@podium/source scripts/server-data-bench/run.ts \
  --a=7a3633c4de --b=f8ee17baf9 --rounds=3 --minutes=4 \
  --max-new-rounds=2 --cell=h1a1 --seed=4443 --load=1x --clients=4
# Continue the saved run twice with --resume=<run-dir> --max-new-rounds=2.
```

## Server data bench 2026-11-11T14-54-58-005Z-pod-6775-tenant-feed

As of 2026-11-11T15:33:02.406Z on the isolated agents VM. A = 7a3633c4de99bab3514c72afe3d766aa90d56010, B = f8ee17baf9f2fea24600eae4d8aaefe6ce47cad9.
Cell h1a1 seed 4443 (4867 issues, 4304 sessions, 84 live on 6 machines).
Load 1x: 28000 daemon frames/min, 1860 session + 220 issue writes/min (session writes targeted 95% to live sessions), 4 clients; 4 measured minutes per round, 3 rounds per arm, order A B A B A B; issue-map comparison A off, B off (PODIUM_ISSUE_MAP_PARITY); session-map comparison A off, B off (PODIUM_SESSION_MAP_PARITY).
Per-round values are medians over that round's whole minutes; the table shows the median over rounds and the min–max over rounds.
Round windows (start UTC): A1 14:57, B1 15:03, A2 15:10, B2 15:16, A3 15:22, B3 15:28; no gaps over 5 min.

| metric | A 7a3633c4de median (min–max) | B f8ee17baf9 median (min–max) | B vs A | what it counts |
|---|---:|---:|---:|---|
| bootListenMs | 1029 (831–1038) | 803 (751–809) | -22.0% | process start to the `listen` boot stage (server:boot log), ms |
| rssAfterBootMiB | 234 (233–241) | 217 (212–276) | -7.2% | server RSS when startServer resolved, MiB |
| rssEndMiB | 397 (392–397) | 376 (368–380) | -5.4% | server RSS at the end of the load window, MiB |
| heapEndMiB | 104 (102–105) | 89.6 (87.8–92.3) | -13.9% | server heap used at the end of the load window, MiB |
| utilizationPct | 43.5 (39.2–44.2) | 44.0 (40.8–44.7) | +1.3% | event-loop utilization, median of window minutes (loop-server.ndjson) |
| blockedPct | 20.4 (16.5–21.0) | 20.4 (17.6–21.3) | -0.2% | share of the minute the loop was blocked, median of window minutes |
| stallsPerMin | 0.99 (0.99–0.99) | 0.50 (0.00–1.48) | -49.9% | event-loop stalls per 60 s of wall time, median of window minutes |
| minuteSpanS | 60.5 (60.4–60.5) | 60.4 (60.4–60.4) | -0.2% | wall seconds one loop minute (60 sample windows) took, median; >60 means the sampler ran late |
| sqlStatementsPerMin | 106396 (106376–106552) | 109780 (109760–109793) | +3.2% | SQL statements per minute over the exact window (attribution totals diff) |
| sqlWallMsPerMin | 10230 (8961–10284) | 10176 (9937–10576) | -0.5% | SQL wall ms per minute over the window (attribution totals diff) |
| daemonFramesPerMin | 28072 (28070–28075) | 28071 (28070–28071) | -0.0% | daemon WebSocket frames handled per minute over the window (ws.message.daemon task count) |
| daemonWallMsPerMin | 1091 (895–1105) | 1077 (1015–1092) | -1.3% | ms per minute handling daemon frames over the window (ws.message.daemon task wall) |
| clientFramesPerMin | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) | – | client WebSocket frames handled per minute over the window (ws.message.client task count) |
| daemonReconnects | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) | – | times the server dropped a fake daemon during the round (each reconnects after 1 s); 0 unless overloaded |
| framesDroppedPerMin | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) | – | daemon frames per minute that came due while their daemon was disconnected (not sent) |
| windowSqlPerDaemonFrame | 3.79 (3.79–3.80) | 3.91 (3.91–3.91) | +3.2% | all SQL statements in the window / daemon frames in the window |
| sqlPerDaemonFrame | 3.79 (3.78–3.79) | 3.91 (3.91–3.91) | +3.2% | SQL statements per daemon frame per loop minute (sql / ws.daemon bucket counts), median — the live figure's definition |

Statements per minute by operation kind (verb + first table; lifetime attribution totals diffed over the window, median over rounds):

| kind | A | B |
|---|---:|---:|
| select sessions | 11245 | 11246 |
| select queued_messages | 8690 | 8690 |
| select session_observation_checkpoints | 7756 | 7757 |
| select podium_events | 7754 | 7754 |
| select offers | 6635 | 6635 |
| select runtime_event_checkpoints | 6635 | 6635 |
| select session_drafts | 6635 | 6635 |
| select conversation_segments | 6616 | 6617 |
| select issues | 6526 | 6528 |
| select messages | 4135 | 4126 |
| insert changes | 3344 | 3344 |
| select users | 3203 | 3204 |
| insert sessions | 3127 | 3127 |
| select changes | 2344 | 0 |
| select cli | 2084 | 2084 |
