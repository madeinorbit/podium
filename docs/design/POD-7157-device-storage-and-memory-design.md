# Device storage and memory (POD-7157)

Status: agreed direction (operator, 2026-11-18). The operator delegated the open decisions to the
coordinator; they are decided below. It replaces the section "Memory, cache and leaving" of
[POD-7059](POD-7059-data-on-device-design.md). Every other part of that design stays.

## Summary

The device gets two layers with separate jobs:

- **Local storage** (IndexedDB in the browser, SQLite on the phone) keeps everything the device
  has fetched. Each instance keeps its marker, and the feed keeps it current. It is bounded by
  size in MB and by age, and pruned only while the app is idle. Leaving a screen never removes
  its data from the device.
- **Memory** holds what screens read now, plus a warm set governed by its own rules. A screen
  holds what it shows simply by reading it, with no separate call to remember. Memory is filled
  from local storage in milliseconds, and from the server only when the device has never fetched
  the data.

Coming back to a screen is then instant and works offline. Memory stays flat as history grows.
And nothing a screen shows can be evicted under it, by construction.

## What went wrong

1. **"Everything on the device is also in memory."** All three stores keep every row in memory
   (`RowMirror`, POD-7115). Memory had to stay flat as history grows, so the only lever left was
   to remove data from the device. The record caps measured by POD-7095 are memory budgets
   (about 5 KB per record), yet they decide what the device keeps in sync. Leaving a large
   screen therefore throws its data away, and coming back fetches it again. That gives up what
   a sync system is for. POD-7059 named the way back ("the loader gets a second source, the
   disk") and its trigger ("a cache cap that turns out too small to be useful"). That trigger
   has now fired.
2. **Holding is opt-in.** A screen holds only by calling `show()`. The easy call, `request()`,
   fetches without holding. Only the phone triage list calls `show()`. The deck and the board
   lost their data as soon as it went over the cap: the live deck failure of 2026-11-18,
   POD-7155.
3. **The trim runs right after every fetch,** trusting the hold list. Nothing protects what is
   on screen.
4. **Tests never crossed the caps.** Fixtures were small and the caps large. Nobody owned the
   rule "what is on screen stays", which spanned four tasks (POD-7086, 7087, 7088 and 7095).

## Goals

- Data fetched once stays on the device and current, until the storage budget or age rule
  removes it. Removal happens while idle, never while it is shown.
- Memory after start and during use is bounded by what is on screen plus the warm set, not by
  history. (POD-7094's result, 1.0 to 1.04 times at 10x history, must hold.)
- Reopening a screen whose data is on the device makes no server request, paints from local
  storage, and works offline.
- Correctness does not depend on any screen remembering a call.

Not goals: tree preloading (still none), changes to the server, the feed format or the stub.

## Layer 1: local storage

**What it keeps.** Every instance the device has fetched, with its marker and its rows at their
level (stub, main, body). This includes the policy collections, everything views have opened,
"one record" instances from lookups and search, and what each record comes with.

**How it stays current.** Feed apply writes to local storage for every instance that has a
marker there, whether or not it is in memory. That is the rule POD-7086 built ("apply to what
the device holds"), with "holds" now meaning held on disk. A gap the feed cannot bridge drops
markers and reloads, as today, starting with the instances in memory.

**Its bounds.** A size budget per client type, plus an age limit per instance (time since a
view last read it):

| | Phone | Browser | Desktop |
|---|---|---|---|
| Size budget | 150 MB | 500 MB | 1 GB |
| Unread for longer than | 14 days | 30 days | 60 days |

These are starting numbers to be measured (task 7). The operator's whole history, about 8,700
issues and 7,000 sessions, is estimated at tens of MB on disk.

**Pruning.** Pruning runs only when the app is idle (`requestIdleCallback`, or the page or app
going to the background), and never during a fetch or a render. It removes whole instances,
least recently read first, until the store is under budget and nothing is past its age. It never
removes:
- a policy collection;
- an instance memory currently holds;
- what a kept record comes with.
An issue falls back to its stub, as today. Stubs are never pruned.

**The disk index (in memory).** Feed apply and pruning must decide about records that are not in
memory without reading the disk. IndexedDB reads are asynchronous, and a read before every write
would be slow. So the device keeps a compact index of everything on disk, always in memory:

- per record (`entity\0id`): its feed number (for "newest wins"), its level (stub, main, body),
  its approximate size in bytes, the instances that hold it, and one **comes-with complete** bit;
- per instance that is NOT keyed by a record: its key, completeAt, last-read time, and whether it
  is in memory, packed. The full marker (range, total) stays on disk, and is read with the
  instance's rows when it is loaded into memory.

**What comes with a record is not a separate instance.** A keyed comes-with instance (via a
record: `issueDep.ofIssue`, `issueGitState.ofIssue`, `session.ofIssue` and the like) is recorded
as that record's comes-with complete bit, not as a marker of its own. Measured by POD-7159 at
operator size, separate markers made instances outnumber records 2.4 to 4 times (38,000
instances for 15,600 records), and grew the start heap with history. With the bit, the number of
markers is bounded by views and policy collections, not by records.

**The index on disk is bucketed.** It is stored as about 256 bucket rows (arrays), not one row per
record and instance, so reading it at start is a few large reads. The instance state is folded
into the marker rows that are already read.

Budgets, checked by POD-7159 and again by POD-7164: index read under 150 ms at operator size on
vega2 web, and the start heap does not grow with what is on disk. It replaces today's in-memory
holdings and `InstanceMap` as the source of truth for "what the device holds", and it lives
beside the stub table. Estimate at the operator's size (about 16,000 records): 2 to 4 MB.

**Offline and gaps.** When the feed cannot bridge a gap (`resync-required`, a rescope or an
epoch change):

- instances in memory are reloaded at once, as today;
- instances only on disk keep their rows, and their markers become **stale**, never deleted. A
  stale instance is read from disk as usual and shown as refreshing (below). Reading it starts
  its reload at background priority, and the reload replaces it in place;
- an instance that comes back refused (the viewer lost access) is removed from memory and disk.

After a gap the device never shows an empty screen for data it had, and never mixes rows from
before and after the gap inside one instance.

**Install cost.** Writing an answer, a feed frame or a disk load into memory costs time linear in
its rows, with a small constant, inside one MobX action per chunk. Readers get one notification
per chunk, never one per row. No main-thread task over 200 ms on the operator-sized deck. This
rule comes from POD-7165, where installing a large tree answer row by row froze the app for two
minutes. Moving data from disk into memory follows the same rule, or warm reloads freeze the
same way.

## Layer 2: memory

Memory holds rows as objects that screens and indexes read synchronously: the pool, the
replica's in-memory rows, and the stub table. It has three kinds of residents.

1. **Always resident:** the policy collections (open and live work, recent work, the sidebar)
   and the stub table. They are bounded by active work, not history, and they keep the first
   screen and all-history counts instant. This is unchanged from today.
2. **Held:** every instance a screen is reading. **Holding follows reading.** Reading a
   collection through the pool registers a hold for as long as anything observes that read.
   The hook is the pool's `@lazy` / MobX observed and unobserved callbacks. A React view
   observes while mounted, so the hold lasts exactly as long as the view. There is no
   view-facing `request()` that fetches without holding: the read is the request. A held
   instance can never leave memory or local storage.
3. **Warm:** instances whose last reader went away. They stay in memory, ordered by when they
   were released, so going back and forth between screens costs nothing. The warm set has its
   own rules:
   - **Budget:** an estimated size in MB per client type: the sum of the warm rows' sizes from
     the disk index, times a per-kind memory factor measured once by task 7 (POD-7095 measured
     about 5 KB per record with indexes). Set: phone 20 MB, browser 80 MB, desktop 160 MB.
   - **Order:** the most recently released stay. A fresh read moves an instance back to held.
   - **When it shrinks:** only on an idle tick, when the page or app goes to the background, or
     on a platform memory warning (phone). Never inside a fetch completion, a feed apply or a
     render.
   - **Grace:** an instance released less than about 60 s ago is not removed by the budget
     rule, so a quick back-and-forth never refetches even at the limit. A memory warning
     overrides the grace.
   - **Leaving memory is not leaving the device.** The rows are dropped from memory, the
     indexes forget them, and the instance stays on disk with its marker. The pool learns this
     through a new exit reason, **unloaded**, distinct from **removed**. A reader of an unloaded
     row gets LOADING and a disk load, never REMOVED or NOT_VISIBLE. Today the pool knows only
     removal (`residency.ts`, exit evidence), so this reason is new.

**Indexes** cover memory rows only, as today (POD-5212's pinned rules stay).

## The loader: two sources

A read of an instance that is not in memory asks the loader, which answers in this order:

1. **Local storage has a marker:** load the rows from disk into memory and mark the instance held
   or warm. The feed has kept it current, so no server request is needed. Browser: one batched
   IndexedDB read, a few ms. Phone: synchronous SQLite, also a few ms, so no LOADING flash for
   small instances.
2. **No marker on disk:** fetch from the server, write to disk and memory together, and hold.

While a disk load is in flight the read answers LOADING, as any absent row does today, so
screens do not change. The "no wrong number" rule is unchanged: an answer is complete only when
its instance is complete in memory.

## Loading and refreshing are different states

This idea comes from Solid 2.0: its `Loading` means "no answer yet" and its `isPending` means
"stale answer, a new one is coming" (POD-7113). With data kept on the device, a screen almost
always has an answer, so it should not show a loading state just because the server has not
confirmed yet.

- **Loading:** the instance is not complete on the device (no marker), and the screen shows
  loading, as today.
- **Refreshing:** the instance is complete on disk, but the device's feed is behind (after
  being offline, or during a gap reload). The screen shows the data from the device at once,
  with a quiet "refreshing" mark. The data is replaced in place when the feed catches up.

The no-wrong-number rule then reads: an answer is either equal to the server's as of the
device's cursor, or LOADING. A refreshing answer is correct as of the cursor the device shows.
It is never a number from a partial collection.

## Invariants (each one a test)

1. An instance with a live reader is never removed from memory or from local storage.
2. An instance with a marker on disk is current as of the device's feed cursor.
3. Reopening a screen whose instances are on disk makes no server request, also offline.
4. After an idle tick, memory is within the warm budget plus what is held. After pruning, local
   storage is within its budget.
5. No wrong number, in every first-download state and after any trim, unload or prune.
6. A row that left memory but not the device reads LOADING and loads from disk, never REMOVED,
   NOT_VISIBLE or a server request.
7. Installing N rows, from the server or from disk, costs at most one reader notification per
   chunk, and time linear in N.

## Testing rules

- Every screen and pool test runs with tiny budgets (warm set: 2 instances; disk: a few KB), so
  the trim and prune paths run in ordinary tests rather than never.
- Every main screen (deck, board, issue page, search, sidebar, phone mission) gets an open,
  leave and reopen test that checks offline reopen with no server request.
- One end-to-end run at operator size, above every budget, before landing: open each main
  screen, move between them, reopen them offline.
- The post-deploy check opens each main screen on the live install, not only the first screen.
- **Chains of loads are found in tests, not in production.** This follows Solid's
  `ASYNC_WATERFALL`: a load is reported only when it was caused by the previous load landing. A
  test-time check records each load whose request came from the flush that installed an earlier
  load. A screen test fails when opening a screen takes more than a declared number of such hops
  (the deck: tree, then what it comes with = 2). That would have caught the deck bug, which was
  an unbounded chain. It is a test check, not a runtime guard.
- **LOADING shown too long is measured.** This follows Solid's `LONG_HOLD`: in screen tests and in
  the operator-size run, the time each screen shows LOADING is recorded against a budget (from
  disk: under 100 ms, from the server: under the fetch time plus one frame).

## Ownership

The device store owns these rules in one place, the replica plus a memory manager in
`packages/sync`. Screens and view models never call the loader directly. They read through the
pool. A lint or test fails on any `loader.request` from view code.

## What changes in the code

- **Stores** (`packages/sync/src/adapters/indexeddb/store.ts`, `mobile-sqlite/store.ts`,
  `replica/memory-store.ts`): the store stops mirroring every row in memory. It reads rows per
  instance on demand (`readInstanceRows`) and keeps the disk index. The `RowMirror`
  (`replica/row-mirror.ts`) becomes the memory layer's resident set (always resident, held and
  warm), no longer a copy of the whole disk. The `ReplicaCacheStore` port (`replica/ports.ts`)
  gains the disk-read and index methods. `readEntities()` returns memory rows only.
- **Replica** (`replica/replica.ts`, `holdings.ts`, `cache-state.ts`, `instance-map.ts`):
  holdings split into the disk index (what the device holds) and memory residency (held and
  warm). `planTrim` becomes two planners: memory (budget, grace, idle) and disk (bytes, age,
  idle). A trim never runs at the end of a fetch any more.
- **Policy** (`apps/server/src/sync/policy.ts`, `packages/protocol/src/messages/collections.ts`,
  `replica/types.ts` `CachePolicy`): `cacheCap` (records) is replaced by `memoryBudgetMb`,
  `diskBudgetMb` and `diskMaxIdleDays`, per client type.
- **Loader** (`replica/loader.ts`) **and pool** (`client-graph/src/collections.ts`,
  `residency.ts`, `pool.ts`): a disk source ahead of the server, a hold per observed read, and
  the unloaded exit reason. `show()` and `request()` disappear from view code. POD-7155's
  `holdWhileRead` becomes the only way a view holds.
- **Feed apply:** it writes disk-only instances through the disk index, in batched transactions.
  POD-7119's per-change cost rules stay.
- **Migration:** existing device stores keep their rows and markers. A schema bump (IndexedDB
  schema version 1 to 2, SQLite 2 to 3) adds last-read times and the index tables, builds the
  index once from the existing rows, and drops nothing.

## Build tasks

Each task has a brief with its own acceptance criteria, on its issue.

1. **POD-7158 Holding follows reading.** Every view read holds what it reads, and view code no
   longer calls `request`/`show`. A lint keeps it so. Starts after POD-7165 lands.
2. **POD-7159 Disk layer and disk index.** The stores stop mirroring every row in memory. The
   disk index, per-instance disk reads, the loader's disk source, and the unloaded exit reason.
3. **POD-7160 Feed to disk-only instances, and gaps.** Feed apply through the disk index, plus
   stale markers after a gap.
4. **POD-7166 Refreshing state.** `reading()` answers refreshing, and screens on web and phone
   show it quietly.
5. **POD-7161 Memory warm set.** Budgets, grace, and shrinking while idle, in the background or
   on a memory warning.
6. **POD-7162 Disk pruning.** Size and age budgets, while idle only.
7. **POD-7163 Test rules.** Tiny-budget defaults, the chain-hop check, LOADING-too-long
   measurement, open/leave/reopen-offline tests per main screen, and the operator-size run.
8. **POD-7164 Measurement.** Sets the memory factor and checks every budget, then the final
   before/after.

Order: 7158, then 7159, then 7160. After 7160, 7161 and 7166 run in parallel (different files).
7162 follows 7161, then 7164. 7163 starts after 7158 with the test infrastructure, and every
later task adds its own invariant tests through it.

## Decisions (made by the coordinator on the operator's delegation, 2026-11-18)

1. **Budgets:** disk 150 MB / 500 MB / 1 GB (phone / browser / desktop); unread age 14 / 30 / 60
   days; warm memory 20 / 80 / 160 MB. Task 7 may move each by up to a factor of two from
   measurement, and must say why. A larger change comes back to the operator.
2. **The phone keeps the policy collections and stubs always resident.** They are bounded by
   active work (about 5 to 10 MB), and they keep the first screen and all counts instant. The
   alternative, reading them from SQLite on demand, saves little and costs the first screen.
3. **Wire version stays 5** (operator, 2026-11-18). The policy's `cacheCap` field is replaced
   in the same release, and clients update with the server.
4. **No hover preloading in this design.** It can come later as "hover = read".
5. **Gap handling:** disk-only instances become stale and refresh when read. They are never
   deleted by a gap (see "Offline and gaps").

## Prior art

**Linear** (the two talks in ~/Resources/LinearTalk):
- Everything received is kept in IndexedDB. A reload starts from the local database and then
  catches up with the changes since. Nothing in the talks evicts synced data. We take this as
  layer 1.
- "Partial index values" written to disk record what is completely loaded ("all the issues for
  this team"). These are our markers, kept on disk.
- Lazy collections hydrate from IndexedDB on access, and objects are made observable only when
  touched. Their batch loader (50 ms window, dedupe, one streaming request) fills what is not on
  disk. That is our loader with the disk source, as in this design.
- They start hydrating when the pointer hovers over a row, so a click finds the data ready. Not
  in this design. Later, it fits as "hover = read" through the same hold.
- Their first download shrank over the years to org, teams and users, with issues through the
  batch loader. Ours keeps the startup set plus stubs resident, which keeps counts exact (see the
  decisions below).
- The talks never describe shrinking memory again. This design adds that as the warm set.

**Solid 2.0** (POD-7113):
- Taken: loading against refreshing (above), the test-time chain check, and the long-LOADING
  measurement (both in the testing rules).
- Not taken, as POD-7113 also concludes: async inside derivations, meaning reads that throw to a
  boundary (reads stay synchronous, and absent data stays an explicit LOADING), and transitions
  that hold the old screen.
