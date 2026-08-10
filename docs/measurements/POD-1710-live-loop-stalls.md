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

`discovery.refreshRepos` at a **4.6 s p50** is not visible in the SQL attribution — filed
separately as POD-1717. See "POD-1717 resolved" below: it is a **timeout, not slow work**,
and it never blocks the event loop.

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

---

# AFTER: measured on main at 67db58baa

Server pid 2998012, started 2026-08-04 20:57:26, running main at `67db58baa`
(contains POD-1711, POD-1712, POD-1713). Box at load ~15-21 on 8 cores.
Baseline for every number below is **post-POD-1653**; do not read these deltas as
the whole journey from that campaign's figures.

## The search freeze is fixed — 46x on the median, 56x on the tail

Same script, same six fixed terms, same box and database.

| term | before | after |
|---|---|---|
| `a` | 12.509 s | **0.252 s** |
| `e` | 6.096 s | **0.098 s** |
| `in` | 6.170 s | **0.113 s** |
| `the` | 10.792 s | **0.199 s** |
| `po` | 14.406 s | **0.252 s** |
| `se` | 6.170 s | **0.134 s** |

Server-side `conversations.search`: **p50 5840 ms → 126 ms**, **p95 13 914 ms →
247 ms**. The probe itself took 59 s before and 3 s after.

This was the per-keystroke freeze. It is gone.

## The loop still stalls ~9 times a minute

Rate-normalised, because the windows differ (45 min before, 10 min after):

| metric | before | after |
|---|---|---|
| stall rate | 9.5 /min | **8.9 /min** |
| p50 | 137 ms | **150 ms** |
| max | 29 466 ms | **5226 ms** |
| blocked time | 3.9 s/min | **2.6 s/min** |

**The honest reading: the catastrophic freezes are largely gone (max down 5.6x,
total blocked time down a third) but the baseline stutter is NOT fixed.** The
server still blocks its event loop about nine times a minute, at a p50 that did
not improve. A user reporting "slowness every couple of seconds" would still
report it.

## What is left, and one thing that got worse

Top SQL inside stalled ticks, after:

| ms | calls | query |
|---|---|---|
| 1764 | 10 931 | sessions projection read |
| 1651 | 134 | `issues WHERE id IN (…)` |
| 1213 | 18 677 | `issues WHERE id = ?` |
| 667 | 2058 | `INSERT INTO conversations` |

`issues WHERE id = ?` is worth flagging: 21 189 calls over 45 min before
(471/min) versus 18 677 over 10 min after (**1868/min**) — the call RATE roughly
quadrupled, even though cost per call fell sharply. That may be traffic mix
rather than a regression, but it is not evidence of improvement and should be
attributed before anyone claims this path is done.

`discovery.refreshRepos` measured **p50 952 ms before, 10 066 ms after** (n=2 and
n=4). This report originally called it "the single largest stall on the server".
**That was wrong** — see "POD-1717 resolved" below. The 10 066 ms is a client-side
timeout constant, not work, and nothing a user waits on awaits it.

## What could NOT be demonstrated

`feedBootstrap.read` — the navigate-back stall POD-1712 targeted — reads p50
1435 ms (n=3) after, against 1304 ms (n=2) on the immediately preceding process.
**No improvement is demonstrated at the RPC boundary.** The unit test proves the
mechanism (5 latest-state folds and 2 session loads collapse to 1 and 1), and the
change-log fold itself fell from 4809 ms/call to ~125 ms/call in the attribution,
so the cost was removed where it was measured. But the end-to-end phase is at
n=3 and cannot carry a conclusion either way. Grading it needs a longer window
with real navigation traffic.

---

# ROUND 2: the native-view wait, attributed by name

Main at `28a7cafea`. Round 2 landed POD-1723 (conversation-list batching),
POD-1730 (bootstrap attribution markers) and POD-1718 (terminal fit).

## Search, three measurements deep

| | baseline | round 1 | round 2 |
|---|---|---|---|
| `conversations.search` p50 | 5840 ms | 126 ms | **94 ms** |
| p95 | 13 914 ms | 247 ms | **177 ms** |
| worst fixed term, wall | 14.4 s | 0.252 s | **0.182 s** |

**62x on the median, 79x on the tail** from baseline, same six fixed terms via
`scripts/perf/pod1710-ab.sh` each time.

## The 1.4s native-view wait, decomposed

POD-1730's markers went live. Server pid 771019, main at `dc8c814bf`:

| phase | p50 | p90 | share of read |
|---|---|---|---|
| `feedBootstrap.read` | **1096.0 ms** | 1441.1 ms | — |
| ↳ `visibility.issue.getIssue` | **489.6 ms** | 708.5 ms | **45%** |
| ↳ `visibility.conversation.findSessionByResumeValue` | **345.1 ms** | 440.6 ms | **31%** |
| ↳ `visibility.session.getSession` | **87.6 ms** | 104.9 ms | **8%** |
| ↳ `visibility.automation.ownerOf` | 0.2 ms | 0.3 ms | ~0 |
| ↳ `visibility.automationRun.runOwnerOf` | 0.1 ms | 1.4 ms | ~0 |

**Three point-read N+1s are 84% of the wait** (922 ms of 1096 ms) — about 3,400
issue lookups and 3,000 session lookups per bootstrap. `verdict=busy` with
`own-cpu` near the stall duration, so this is CPU, not I/O.

The grants phases do not appear at all: POD-1723's batching removed them from
this path entirely.

**n=2.** The decomposition is internally consistent — the parts sum to the whole
— but the exact milliseconds are soft. The CALL COUNTS are the reliable figure.

## The pattern, three times over

A full-table SCAN gets replaced by a point QUERY; the point query then gets
called once per row, and the N+1 costs what the scan did.

1. POD-1711 — `loadSessions()` per FTS candidate → request-scoped index.
2. POD-1723 — `getIssue` + `listForResource` per conversation → batched.
3. POD-1732 (open) — `getIssue` / `findSessionByResumeValue` / `getSession` per
   bootstrap row → to be batched.

`findSessionByResumeValue` is the sharpest case: POD-1614 introduced it
*specifically to replace a full-table scan here*, and it is now called ~3,000
times per bootstrap.

## What is still NOT measured

**Nothing here is time-to-interactable.** Every client number in this document
stops at `chat:first-paint` or `term:ready`; there is still no mark for typeable
or scrollable (POD-1727, open). POD-1718 was explicit about this and reported its
own result as "2→1 initial fit count and observed term:ready, NOT proven
typeable/scrollable" — the correct framing, and the one to keep using until the
sentinels land.

Fresh-agent-start and cold-IndexedDB-load remain unmeasured.

---

# ROUND 2 AFTER: the bootstrap fix, measured live

Server pid 1041388, main at `dc1b8ef57`, 65 min uptime, real browser traffic.

## feedBootstrap.read — 3.1x faster, and the N+1s are gone from the top

| phase | before p50 | **after p50** | change |
|---|---|---|---|
| `feedBootstrap.read` | 1096.0 ms | **351.9 ms** | **3.1x** |
| ↳ `visibility.issue.getIssue` | 489.6 ms | **89.7 ms** | **5.5x** |
| ↳ `visibility.conversation.findSessionByResumeValue` | 345.1 ms | **16.3 ms** | **21x** |
| ↳ `visibility.session.getSession` | 87.6 ms | **14.7 ms** | **6.0x** |

The three point-read N+1s fell from **922 ms to 121 ms**, and from **84% of the
read to 34%**. POD-1732 did what it claimed.

**Caveat, stated plainly:** n=3 after, n=2 before. The p90 reads *worse*
(1873.6 ms vs 1441.1 ms), but at n=3 the p90 is effectively the single worst
sample, and the worst sample here is the first bootstrap after a restart with
cold caches. The p50 is the defensible figure; the tail needs more samples.

## The client traces name the next two costs

These traces still finalize at `chat:first-paint` / `term:ready` — the browser
was running a CACHED bundle, so the interactable sentinels did not fire even
though they are present in the shipped `dist`. Everything below is therefore
still time-to-PAINT.

| switch | total | dominant gap |
|---|---|---|
| **chat, cold** | **3838 ms** | **3489 ms in one `transcript:read-end` gap** |
| **native, cold** | **1377 ms** | `term:connection:reset` 599 ms, `term:mount` 318 ms, `panel:mount` 179 ms |
| native, warm | 92 ms | — |

**The single largest interaction cost now measured anywhere in this
investigation is the 3489 ms transcript read on a cold chat open.** It is one
gap, in one mark interval, and it dwarfs everything POD-1710 has fixed so far.
This matches `sessions.transcriptRead` p95 2377 ms seen earlier and is
unaddressed.

Cold native view open is 1377 ms, of which the terminal connection reset
(599 ms) is the largest single piece — POD-1718 removed one of the two initial
fits, and the remaining fit pair costs 273 ms.

---

# TIME-TO-INTERACTABLE, measured at last

Server pid 3388846, main `8e28496d1`, real browser after a hard reload, so
`chat:interactable` / `term:interactable` finally fire. **These are the first
numbers in this document that measure "can I type", not "has it painted".**

| switch | total to INTERACTABLE | paint→interactable gap |
|---|---|---|
| native, warm | **51 ms** | 5 ms |
| native, cold | 304 ms | 8 ms |
| native, cold | 575 ms | 120 ms |
| native, cold | 2252 ms | 220 ms |
| native, cold | **13 438 ms** | **never confirmed — timed out** |
| chat, cold | 1145 ms | — |

## Two things this settles

**The paint→interactable gap is real but small: 5–220 ms.** POD-1727 predicted
its 0.6 ms harness figure was an artifact (case b) and would not relabel the old
paint numbers from it. It was right to refuse, and the live gap is 10–350x its
harness value — but still small enough that the earlier paint-based numbers were
not badly wrong. Both halves of that prediction hold.

**Warm switching is genuinely fast.** 51 ms to typeable.

## The finding: cold native opens are wildly variable, and the tail is 13 s

304 ms, 575 ms, 2252 ms, 13 438 ms — same interaction, same session. The worst
one decomposes to a SINGLE unmarked gap:

```
+     32ms  panel:mount
+     85ms  term:mount
+      8ms  term:fit:measured
+    297ms  term:fit:measured
+  12857ms  term:ready        <-- one gap, no marks inside
```

The 2252 ms case has the same shape at smaller scale: 1910 ms before
`term:connection:reset`.

**Why the 12 857 ms gap is probably NOT the server.** `session-mount.ts:384`
arms a `READY_TIMEOUT_MS = 2000` backstop that reveals the terminal even if the
attach handshake stalls. A 12.9 s gap is impossible if that timer fired on
schedule — and a `setTimeout` cannot fire while JS is busy. That points at a
**blocked browser main thread**, not a slow attach. `ws.attach` measures 2.7 ms
server-side, which exonerates the server leg.

**Why it is not yet PROVEN.** `markReady` records its source
(`'attach' | 'frame' | 'timeout'`) via `trace('ready', { source })`, but
`packages/protocol/src/perf.ts:62` `switchMarkSchema` carries only
`{ name, atMs }` — **per-mark meta is discarded at the wire boundary**. The one
datum that would distinguish "the attach really took 13 s" from "the main thread
was blocked for 11 s" is thrown away before it reaches the server.

That gap is now POD-1759, which also adds main-thread block detection — all of it
off by default and runtime-toggleable.

## POD-1717 resolved: the repo scan is a timeout, not a stall

The `discovery.refreshRepos` p95 of 10 017 ms sits exactly on `SCAN_TIMEOUT_MS =
10000` (`apps/server/src/modules/machines/rpc.ts:56`). It is the timeout firing,
not ten seconds of work. Two independent lines of evidence retract the original
"synchronous filesystem or git work on the main thread" framing:

- **No blocking frame exists.** No scan or FS frame appears in the server
  `SIGUSR2` totals, and no matching 8–10 s loop tick shows on either the server
  or the daemon process. All seven `ludovico` roots scan read-only in
  **13–137 ms**.
- **Nothing a user waits on awaits it.** `packages/client-core/src/engine/runtime.ts:557`
  runs `refreshRepos` inside `void Promise.all([...]).catch()`, and `:550` sets
  `booted = true` *before* that fan-out. It is not on the switch path, the typing
  path, or boot.

**Who times out:** `Michaels-MacBook-Pro.local`. Its roots are the ones that fail
to answer inside the budget, while every local root answers in well under a
tenth of a second.

**What is still unknown, and why it stopped here:** the server sends all five Mac
roots in a *single* RPC, so no individual root can be named without per-root
timing in the protocol. That is a structural change, deliberately out of scope
for a low-priority non-blocking path. No code was changed for POD-1717.
