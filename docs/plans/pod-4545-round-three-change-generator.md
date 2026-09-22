# POD-4555 (L4a) — The random-change generator

A seeded generator of long, realistic change sequences, a runner that applies
each change through the real scenario engine, and a shrinker that cuts a
failing sequence down to the few changes that matter. It feeds the
correctness gate (L4b, POD-4556).

Code: `packages/worklist-proto/shared/src/gen/` — `changes.ts` (vocabulary,
weights, `gen`), `run.ts` (the engine runner and the scripted server),
`shrink.ts` (the shrinker). Tests: `changes.test.ts`, `shrink.test.ts`.

## 1. How to use it

```ts
const changes = gen(seed, 1000)                  // Change[]: plain data
const run = await startGenRun({ onStep })        // one engine, one scripted server
for (const c of changes) await run.apply(c)      // StepResult: events, skipped?, detail
const { result } = await shrink(changes, (cs) => failsOn(cs))
```

- `gen(seed, steps, weights?, { corpus? })` is pure and deterministic: a
  seeded PRNG (the fixture's mulberry32), no `Date.now`, no `Math.random`. The
  test stubs both to throw while it generates.
- A `Change` is an intent ("stage of i42 becomes done", "the server answers
  edit e7"). The runner re-resolves every target against the engine and
  **skips** a change whose target is gone (the step records why), so every
  subsequence the shrinker tries still runs.
- `startGenRun({ onStep, feed })`: `onStep(step, run)` runs after each step has
  settled, before the next — the L4b checker goes there. `feed` swaps the
  event source: by default the round-two row source over the runtime's folded
  snapshot; the phase-c arms need L3a's server-truth feed (write contract W12),
  and this is where it plugs in.
- Each step settles by yielding macrotasks until the engine is quiet (no
  publication, no server call, no outbox movement for three turns). There is no
  wall-clock wait, and the same sequence gives the same events on a fresh engine
  (tested).
- Cost at 1x (4,867 issues): 1,000 steps generate in ~0.2 s and apply in
  ~15–28 s, about 17–28 ms per step, measured under load 6–7. These are counts
  runs, so the times are not evidence.

## 2. The engine it drives

`startEngineOnCorpus` (the one boot path) gained three options. They are
additive, and every existing caller is unchanged:

| Option | What it is | Why |
|---|---|---|
| `outbox: 'kernel'` | `openKernelEngineOutbox` over an `InMemoryOutboxStore`, stamped by the corpus clock | The queue web runs in production: per-issue partitions, the mark-read collapse (supersede), durable across a reload |
| `server` | `issues.update` / `issues.markRead` answered by the caller | Hold every call until a change answers it, so receipt, rejection and echo can land in any order |
| `network` | `isOnline` / `onlineEvents` | Offline windows, where entries queue and collapse |

`ScenarioEngine` also gained `hub.emit` (a server push), `discovery.repos`
(what `refreshRepos` answers), and `reload()`, which destroys the runtime and
boots a new one over a fresh replica facade on the same durable cache and the
same outbox store.

Row changes write **server truth**. They read the cache (the replica's server
rows), never the runtime's folded snapshot, which carries the pending overlay.
Issue changes dual-write wire and projection in one `replica.batch()`.

## 3. Vocabulary

| Kind | Applied as |
|---|---|
| `newIssue`, `newSession` | kernel `upserted` (issue: wire + projection) |
| `heartbeat`, `phaseChange`, `offerChange` | session upsert (`lastActiveAt`; `agentState.phase`; `offer` set/cleared) |
| `newWorktree` | discovery answers a repo with one more worktree, then the server pushes `worktreesChanged`; the runtime refreshes discovery itself |
| `remove` | kernel `removed` (a real deletion), session or issue |
| `reparent`, `stageChange`, `archive`, `rankMove` | issue upsert: `parentId` (never a cycle, sometimes to root); `stage` (`done` stamps `closedAt`/`closedReason`, any other stage reopens); `archived`; `sortKey` from the model's own `sortKeyBetween` |
| `evict` / `reAdd` | kernel `evicted` (not `removed`); later the same rows come back with `readmitted: true` |
| `clockTick` | the runtime's coarse clock, through its own tick path: 1 min (mostly), 1 h, 6 h, 25 h |
| `batch` | 2–6 row changes in one `replica.batch()`: one kernel batch |
| `edit` | the runtime action: `updateIssue(id, {title})`, `updateIssue(id, {stage})`, or `markIssueRead(id)`. The kernel mints, persists and sends it; the runner reads the mutation id from the outbox |
| `accept` / `reject` | the server answers the held call: applied, or a definitive refusal (409, dead-lettered; a title is parked) |
| `echo` | the server row carrying the edit's value (a mark-read echoes the server's own stamp) |
| `remoteOnPending` | another writer's value on the edit's field |
| `staleRepeat` | after the receipt, a full-row upsert that carries the value the server held at the receipt |
| `supersede` | two mark-read presses on one row while offline; the kernel outbox collapses the first |
| `offline` / `online` | the outbox's connectivity; `online` fires the reconnect edge |
| `refresh` | `reload()`: the old tab's unanswered calls die, the new runtime re-sends under the same mutation ids |

### L1c §5 write-path events, and where each comes from

| Contract event | Produced by |
|---|---|
| edit | `edit` (title, stage, mark-read) |
| receipt | `accept` (outbox `applied`) |
| rejection | `reject` (outbox `dead-lettered`) |
| supersede | `supersede` (outbox `superseded`; the step records `collapsed: true` from the queue itself) |
| echo before the receipt / after it | `echo` while the call is held / after `accept` (`detail.beforeReceipt`) |
| remote update on a pending field | `remoteOnPending` while the call is unanswered (`detail.unanswered`) |
| overtaking write after the receipt | `remoteOnPending` after `accept` |
| stale repeat | `staleRepeat` |
| receipt with no echo (TTL) | `accept` never followed by `echo`, then clock ticks |
| duplicate receipt | `refresh` after `echo`: the re-send reaches a server that already applied it and is answered at once (`detail.duplicateReceipts`) |
| refresh with pending edits | `refresh` |

### Audit §3.3 shapes (named generators, tagged `shape` on what they emit)

| Shape | Emits |
|---|---|
| `clockDecay` | a visible row goes `done`, then a 25 h tick crosses the finished-grace window (`SIDEBAR_FINISHED_GRACE_MS`) with no row change |
| `offerRemovedOnFinishedChild` | a child's session: the child finishes (if it had not), then its offer goes (set first if absent) |
| `rankMoveWithinGroup` | one sibling re-keyed between two adjacent siblings, or before the first, after the last, or unkeyed |
| `evictThenReAdd` | `evict` then `reAdd` of the same row |
| `twoRankMovesInOneBatch` | one `batch` re-keying two siblings of one group |

## 4. The generator's model mirrors the kernel drain

The generator aims answers (`accept`, `reject`, `echo`) at edits whose call is
really at the server. It therefore mirrors the kernel outbox's drain
(`packages/sync/src/outbox/outbox.ts`):

- There is one pass at a time. A pass starts on a trigger (an enqueue while
  online, the online edge, a reload) and snapshots the queued entries per
  partition.
- Within a partition it runs FIFO: it sends the head and waits for the answer.
  A refusal stops the partition for that pass. A refused title is parked and
  blocks its partition for good.

The first model skipped half the answers (27/55 accepts). With the mirror, 997
of 1,000 steps apply at seed 1.

## 5. Evidence

As of commit `<landed sha>`, corpus 1x at seed 4443, sequence at seed 1, 1,000 steps.
Generated = changes of that kind in the sequence; applied = changes the engine
applied (not skipped). Shapes count changes carrying the tag.

| Kind | Generated | Applied |
|---|---|---|
| newIssue | 44 | 44 |
| newSession | 49 | 49 |
| heartbeat | 47 | 47 |
| newWorktree | 21 | 21 |
| remove | 20 | 20 |
| reparent | 36 | 36 |
| phaseChange | 44 | 44 |
| offerChange | 77 | 77 |
| stageChange | 68 | 68 |
| archive | 25 | 25 |
| rankMove | 54 | 54 |
| evict | 48 | 48 |
| reAdd | 48 | 48 |
| clockTick | 52 | 52 |
| batch | 37 | 37 |
| edit | 101 | 101 |
| accept | 34 | 34 |
| reject | 32 | 32 |
| echo | 44 | 42 |
| remoteOnPending | 37 | 36 |
| staleRepeat | 25 | 25 |
| supersede | 17 | 17 |
| offline | 13 | 13 |
| online | 12 | 12 |
| refresh | 15 | 15 |
| shape clockDecay (2 changes each) | 36 | 36 |
| shape offerRemovedOnFinishedChild (1–3) | 46 | 46 |
| shape rankMoveWithinGroup | 23 | 23 |
| shape evictThenReAdd (2) | 54 | 54 |
| shape twoRankMovesInOneBatch | 20 | 20 |

Write path in the same run: 22 echoes before the receipt and 20 after; 17 of 17
supersedes collapsed by the queue; 27 remote updates on an unanswered field and
9 after the answer; 154 re-sends across 15 reloads, 11 of them duplicate
receipts; 52 receipts, 32 refusals, 226 server calls. The 3 skips all target a
row evicted by then (2 `echo`, 1 `remoteOnPending`).

Tests (`bun run test:file -- packages/worklist-proto/shared/src/gen/*.test.ts`):

- `changes.test.ts`: generation is deterministic and never reads the clock or
  `Math.random`. Weights restrict the kinds drawn. Each shape is emitted in its
  defining pattern.
  - **COVERAGE**: 1,000 steps at seed 1 apply every kind ≥ 10 times and every
    shape ≥ 10 times. Every applied row change reaches the feed under its own
    id (a worktree reaches the engine; see finding 2). Every write-path event
    above is observed at least once, and remote updates on a pending field
    ≥ 10 times.
  - The same sequence gives the same per-step events on a fresh engine.
- `shrink.test.ts`: the pure shrinker finds the failing pair and triple, is
  1-minimal, and never runs a candidate twice.
  - **Engine**: a consumer with the planted audit mistake ("an evicted row
    re-added is never re-seated") fails a 120-step random run drawn with no
    named shapes. The correct consumer (the control) passes the same run. The
    shrinker cuts it to exactly `evict X`, `reAdd X`; the buggy consumer still
    fails that, and the control passes it.

Arming (each check planted alone and restored with `cp`; the named test went red):

| Mutation | Went red |
|---|---|
| issue changes write the cache without the kernel event | COVERAGE: "step 7 stageChange i329 missing from the feed" |
| `supersede` presses once | COVERAGE: "supersede collapsed by the kernel outbox: expected 0 to be greater than 0" |
| shrinker keeps the prefix pass, ddmin disabled | all three minimality tests (engine run shrunk to 69 changes instead of 2) |

The engine shrink test also carries its own control: the correct consumer
passes the same run and the same shrunk pair.

## 6. Findings

1. **The kernel outbox holds back a write behind another issue's slow call.**
   The drain is single-flight. A pass snapshots the queue at start, and an
   entry enqueued while the pass waits on a held call is not in it. When that
   call answers, the pass ends and nothing sends the new entry until the next
   enqueue, reconnect or retry timer. Probe: edit A on issue 1 is held, edit B
   on issue 2 is queued, A is accepted, and B is still unsent. B went out only
   when a third edit was enqueued. ("Partitions run concurrently" holds only
   within one pass.) This is production behaviour on web, and it lies outside
   round three.
2. **The round-two row source does not publish worktree changes that arrive
   through discovery.** After `worktreesChanged` → `refreshRepos`, the engine
   holds the new worktree and `source.snapshot('worktree')` has it, but no
   event fires: the source emits worktree lanes only for a kernel `repos`
   address. This is for L3a (POD-4553).
3. **The fixture's sort keys are malformed by the model's own rule.**
   `isSortKey('a0')` is false (a key may not end in the minimum digit), so a
   real server would never send `a0`, and `sortKeyBetween` refuses it as a
   bound. The generator bounds new keys by well-formed sibling keys only. This
   is for the fixture's owner (L2a).
4. **`scenarios.ts` builds server writes from the folded snapshot.**
   `patchIssue`/`patchSession` start from `engine.getSnapshot()`, which carries
   the pending overlay. A scenario write made while an edit is pending would
   send that overlay as server truth. No current scenario does that, but the
   generator reads the cache instead.
5. **Mark-read overlays are stamped from the wall clock**
   (`OptimismLedger.enqueueOverlayed`: `queuedAt = Date.now()`), so the painted
   `readAt` of a pending mark-read differs between runs. An oracle must not
   compare that painted stamp. The generator's determinism key compares row ids
   and presence, not values.

## 7. Limits

- The TTL (W10) is exercised only as "accepted, never echoed, then time
  passes" on the coarse clock. The kernel's own awaiting-truth expiry runs on
  the wall clock and is not driven.
- A transient failure followed by a retry is not generated. The kernel's retry
  runs on a backoff measured on the injected clock plus a real timer, which
  would make the step timing depend on the wall clock. The duplicate receipt
  comes from a reload instead, which is its real-world cause.
- Dead-letter recovery (retry or edit from the recovery surface) is not
  generated. It is legacy UI (write contract §7.1).
