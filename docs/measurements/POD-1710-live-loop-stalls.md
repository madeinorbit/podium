# Live event-loop stalls — measured proof

Source: `podium-server` (pid 2225619), `PODIUM_LOOP_PROFILE=1` already enabled.
Window: 45 minutes of `journalctl --user -u podium-server`, 2026-08-04 ~18:10–18:55.
DB at time of measurement: 1256 sessions, 1679 issues, 5639 messages, 20012 change rows.

## The headline

429 recorded stalls in 45 min — one every ~6 s.

| metric | value |
|---|---|
| stalls | 429 |
| p50 | 137 ms |
| max | 29 466 ms |
| total blocked | 175 s of 2700 s (**6.5% of wall clock**) |
| verdict | `busy` 365 / `mixed` 64 |

`verdict=busy` with `own-cpu` ≈ stall duration means this is **the server burning its
own CPU on the main thread**, not an oversubscribed box. Every client — every
keystroke, every archive — waits behind it.

## SQL inside stalled ticks, by total blocking ms

| ms | calls | ticks | calls/tick | query |
|---|---|---|---|---|
| 30014 | 7432 | 34 | 218 | `SELECT id, owner_user_id, … FROM sessions` (full 49-col scan) |
| 10944 | 21189 | 187 | 113 | `SELECT * FROM issues WHERE id = ?` |
| 9619 | 2 | 2 | 1 | `changes` fold (`GROUP BY entity, entity_id`) |
| 8755 | 428 | 149 | 3 | `SELECT * FROM issues WHERE id IN (…661…)` |
| 7633 | 7191 | 129 | 56 | queued-`messages` poll |

## Root cause 1 — full session scan per transcript candidate (the multi-second freezes)

`MemoryVisibility.mayReadNativeConversation` (`apps/server/src/modules/memory/visibility.ts:138`)
answers a per-row visibility question with a **full `loadSessions()` table load** —
49 columns, ~940 live rows, mapped into objects.

Its caller `MemorySearch.search` (`apps/server/src/modules/memory/search.ts:195`) runs that
predicate **once per FTS transcript candidate**:

```ts
this.store.conversations.transcriptIndex.searchCandidates(text)
  .filter((row) => this.visibility.mayRead(reader, { class: 'transcript', … }))
```

Worst observed tick: **1343 calls returning 1 263 087 rows in 12 053 ms**.
That is 9 ms per scan × 1343 candidates — the arithmetic closes.
Nested inside it, `mayReadSessionRow` does `getIssue` per row: **4653
`issues WHERE id = ?` in a single tick**.

Memory search runs **per keystroke**. This is the reported "typing is slow" and it is
also why *everything else* stalls at the same moment.

This is the same defect class POD-1614 fixed at `relay.ts:462`; the fix did not reach
this second caller.

## Root cause 2 — steady-state N+1 (the "every couple of seconds" tax)

Independent of search, the baseline 130–200 ms stalls are dominated by:

- `SELECT * FROM issues WHERE id = ?` — 113 calls/tick
- queued-`messages` poll — 56 calls/tick, 84 executions per pass
- `SELECT * FROM issues WHERE id IN (661 ids)` — 59 ms per call, several times a tick

## Root cause 3 — unmemoized change-log fold (rare, 5–7 s each)

`SyncRepository.latestChangeStates` (`packages/sync/src/adapters/sqlite/sync-repository.ts:145`)
folds the entire `changes` table. `Relay.durableChangeValueOf` and `anchors.visibilityEdge`
(`apps/server/src/relay.ts:509,525`) each call it **fresh, inside a per-ref lambda**, with no
memoization — alongside another full `loadSessions()`.

Raw sqlite cost of the fold is 155 ms; in-process it measured **6759 ms** for 7987 rows,
the difference being JS row materialization. It fired twice in the window, at 4.8 s average.

## Confirmation from `/trpc/perf.snapshot`

Fetched from the live server with an operator session. The RPC and phase timings confirm
both hypotheses at the boundary, independently of the loop profiler.

### The typing freeze is `conversations.search`

| rpc | n | p50 | p95 | max |
|---|---|---|---|---|
| `conversations.search` | 43 | 118 ms | **11 458 ms** | **17 280 ms** |
| `discovery.refreshRepos` | 10 | 4580 ms | 10 017 ms | 10 017 ms |
| `sessions.transcriptRead` | 6 | 315 ms | 4937 ms | 4937 ms |
| `quota.summary` | 93 | 38 ms | 850 ms | 16 031 ms |

`conversations.search` p95 of 11.5 s is root cause 1 measured end-to-end. p50 of 118 ms
shows the cost is not the query — it is the candidate count, exactly as the
1343-scans-per-tick figure predicts. `quota.summary`'s 16 s max with a 38 ms p50 is a
request queued behind a freeze, not a slow handler.

`discovery.refreshRepos` at a **4.6 s p50** is a separate main-thread hog not visible in
the SQL attribution — filed separately.

### The navigate-back stall is server-side, in the feed bootstrap

| phase | n | p50 | p90 | max |
|---|---|---|---|---|
| `feedBootstrap.total` | 7 | 4805 ms | 21 097 ms | 21 097 ms |
| `feedBootstrap.read` | 7 | **4698 ms** | **20 956 ms** | 20 956 ms |
| `sessionsBroadcast.total` | 474 | 43 ms | 143 ms | 580 ms |
| `sessionView.list` | 524 | 57 ms | 90 ms | 1635 ms |
| `feedPublish.total` | 8603 | 0.0 ms | 0.6 ms | 93 ms |

`total - read ≈ 100 ms` puts the entire cost inside the read, not in framing, encoding or
fan-out — `feedPublish` is 0.0 ms p50 across 8603 calls. The bootstrap read is where the
per-issue `loadSessions()` + `latestChangeStates()` of root cause 3 live, so **root cause 3
is the navigate-back stall**, not a rare background cost.

### Client-side switch cost is real but secondary

The client reports its own view-switch marks (`clientSwitches`):

| mode | n | p50 | p90 | max |
|---|---|---|---|---|
| native, **cold** | 13 | 1106 ms | 2724 ms | 3144 ms |
| native, warm | 33 | 203 ms | 236 ms | 307 ms |
| unknown | 1 | 10 004 ms | — | **timed out** |

Mark timeline of the three slowest cold switches is the same shape every time:

```
+  15ms  viewstate:sent
+ 250ms  panel:mount
+ 503ms  term:mount
+   9ms  term:fit:measured x2
+1014ms  term:fit:measured        <- third fit, ~0.6-1.0s gap
+1353ms  term:ready               <- 1.3-1.7s
```

So a cold native switch costs ~1.1 s median / 3.1 s worst **in the client**, dominated by
terminal mount and the last fit→ready gap. A warm switch is 203 ms and is not the problem.

**Conclusion on the reported symptom:** the client contributes ~1-3 s on a cold switch,
but the multi-second-to-20-second waits come from the server — `feedBootstrap.read` at a
4.7 s median (21 s worst), and any keystroke landing during a `conversations.search`
freeze. Fixing the server paths is the higher-value work by an order of magnitude.

---

## A/B probe baseline (the number the fixes must beat)

Ambient live numbers are too noisy to grade a fix: `feedBootstrap.read` measured
p50 4698 ms on one server process and p50 1304 ms on the next, both at n=2.
`scripts/perf/pod1710-ab.sh` removes that variance — it drives a FIXED set of
search terms and reads the server's own timings back, so the same script run
before and after a deploy is comparable on the same box and DB.

Baseline, server at `ce497a45c`, 2026-08-04 19:42 (client-observed wall clock):

| search term | wall time |
|---|---|
| `a` | 12.509 s |
| `e` | 6.096 s |
| `in` | 6.170 s |
| `the` | 10.792 s |
| `po` | 14.406 s |
| `se` | 6.170 s |

Server-side for the same six calls: `conversations.search` n=6 **p50 5840 ms,
p95 13 914 ms**. `sessions.list` was 0.19–0.48 s across five calls.

**Every keystroke in the search box costs between six and fourteen seconds of
fully blocked event loop**, and this is reproducible on demand rather than
inferred from a tail.

Note: running this probe itself freezes the live server for ~60 s in total, so it
is a deliberate act, not something to leave on a loop.
