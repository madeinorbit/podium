# POD-378 — retiring TanStack DB: what is done, what blocks the deletion, and which guarantees would go with it

**Issue:** POD-378 (2.3e Remove TanStack DB + delete-tracking regression + audit zero) ·
**Parent:** POD-307 · **Written:** 2026-07-31

---

## 1. The headline: the adapter cannot be deleted yet, and the reason is structural

POD-378's first acceptance clause is "the TanStack DB adapter is deleted and the dependency is gone
from the lockfile". It is not, and deleting it today would delete the client.

`packages/client-core/src/replica/replica.ts` is still the **only client replica anything
constructs**, on both platforms:

| Site | What it builds |
|---|---|
| `apps/web/src/lib/desktopReplica.ts:135` | `createReplica(...)` — the TanStack replica, SQLite-persisted (Tauri) |
| `apps/mobile/src/client/MobileClientProvider.tsx:207` | `createAsyncStorageReplicaStorage` + `createReplica` — the TanStack replica over AsyncStorage |
| `apps/web/src/app/replica.ts` | re-export shim the web engine reads through |

POD-376 and POD-377 are marked *done*, and both are — for the halves they scoped. Each left a
**blocking child that is the half which makes the kernel path reachable**, and neither has landed:

- **POD-1223 — Web engine on the kernel replica.** The engine still reads the TanStack `Replica`
  interface. Stage `planning`.
- **POD-1220 — Mobile replica facade over the kernel ports.** The store-neutral client `Replica`
  facade over `{cache: ReplicaCacheStore, outbox: OutboxStorePort}` that BOTH platforms were told to
  consume rather than write twice. Stage `backlog`.

`resolveReplicaMode()` (`packages/client-core/src/replica/feed/mode.ts`) resolves which path a client
should run and **nothing constructs a kernel `Replica` from its answer**. The wire, the frame
mapping, the feed consumer, both storage adapters and the legacy-replica migration all exist and are
green; the one missing piece is the facade that lets the engine read through them.

### 1.1 Correction — the facade is already WRITTEN; the ask is a MERGE, not an assignment

The paragraph above was drafted from issue stages and was wrong. POD-1220 checked the LIVE state and
found what none of our three briefs names; **verified here independently** rather than taken on
report:

```
$ git ls-tree -r --name-only issue/1223-web-engine-on-the-kernel-replica \
    -- packages/client-core/src/replica/kernel/
packages/client-core/src/replica/kernel/facade.test.ts
packages/client-core/src/replica/kernel/facade.ts
packages/client-core/src/replica/kernel/index.ts
packages/client-core/src/replica/kernel/kinds.ts
packages/client-core/src/replica/kernel/side-cache.ts
```

The same path is **absent from `issue/279-integration` and from `main`**. It landed under
**POD-1228 (Store-neutral client Replica facade, stage `done`)** — a sibling none of POD-378,
POD-1220 or POD-1223 names — and rides on POD-1223's branch, which carries four commits (`9a35c240`,
`4f80506d`, `7bb510ed`, `392e2788`) and has already built the web engine on that facade plus the
shadow-comparison harness.

**So the ask is: merge POD-1223 (which carries POD-1228's facade) into integration.** Nothing needs
writing. An agent told to "put the facade on someone" would write a duplicate of a finished one —
the exact fork all three issues have declined to create by hand.

Once it lands, POD-1220's scope collapses to consuming it from `apps/mobile` (open `SqliteSyncStore`
via `fromExpoSqlite`, `viewFor(principal)`, `createSideCache` + `createKernelReplica`,
`migrateLegacyReplica` once before the first read). POD-1220 is therefore blocked on POD-1223
merging, not on anyone's availability.

**This issue's deletion unblocks on the same merge** — plus POD-1220's mobile consumption, since
`apps/mobile` is the second TanStack composition root.

**But the merge should not happen before §4.3 is answered.** Reviewing the facade to close this
issue's guarantee inventory turned up two guarantees it does not carry and one instrument that
cannot say NO.

**Decision taken, with no human available (POD-279 fan-out rule 2):** do not write a second facade.
POD-1220's brief states that POD-376 explicitly agreed to consume POD-1220's file rather than write
its own, and "a second client Replica facade is exactly the fork this programme exists to end". A
third one, written from this issue, would be strictly worse. Everything else in POD-378's scope is
delivered, and the deletion is the last step once either child lands.

---

## 2. What landed under this issue

### 2.1 The removal-family regression — `packages/client-core/src/replica/removal-family.test.ts`

Four cases, one file, so the distinction cannot rot. ADR 2 D5 warns that soft-delete and tombstone
"look identical from a distance and are not"; §3.1 adds a third member, and a fourth shape is
routinely mistaken for a removal:

| Case | Property |
|---|---|
| delete | gone, and gone for everyone — `exitKind === 'removed'`, a `removed` event, absent on disk |
| revoked share | gone from MY view — `exitKind === 'evicted'`, **no** `removed` event, and the row is untouched for the principal who still holds the grant |
| watermark skip | nothing rendered, cursor advances to head, `watermarkOnly === true`, **no heal and no bootstrap** |
| present → absent | the row SURVIVES and the field is nulled — asserted on the KEY SET, not the value |

**Real on both client instantiations.** Every case travels the v2 wire shape → `frames.ts` →
`FeedSink` → the kernel `Replica`, over BOTH shipped storage adapters on real engines: IndexedDB
(`fake-indexeddb`, real transaction semantics) and real SQLite on a real file. Every "it is gone" and
"the field was nulled" claim is re-read through a **second store opened over the same durable
bytes**, so no assertion is answered by the object that held the value in memory.

Two harness findings worth carrying forward:

- **`IndexedDbSyncStore.settled()` before a reopen is load-bearing.** `Replica.settled()` covers the
  kernel's work and stops there; on IndexedDB the commit is still in the engine's request queue at
  that moment. Without the fence three cases read the PRE state and reported the *previous* frame's
  answer. SQLite's synchronous commit hid it — which is exactly why both engines run.
- **An absence assertion needs an event WINDOW.** The first draft counted events from index 0 and
  the watermark case failed on an `upserted` from its own bootstrap. Benign in that direction; the
  same mistake in a case asserting an absence would have passed by measuring a window where the thing
  genuinely never happened.

### 2.2 The audit — `scripts/audit-phase2-client.ts` (+ `bun run audit:phase2-client`)

Four detectors, one per item in the brief, run in the test lane so a regression is red rather than
rediscovered.

### 2.3 Both instruments are probed

Per the ledger's recurring defect class, neither is trusted to be counting.

**The regression, by mutation** — five mutants, applied one at a time to a committed baseline and
reverted atomically. Every one was killed, and each killed **exactly** the intended case and lane:

| Mutant | Site | Killed |
|---|---|---|
| `evict` mapped as `remove` | `frames.ts` `toEnvelope` | revoked-share case, both lanes |
| `remove` mapped as `evict` | `frames.ts` `toEnvelope` | delete case, both lanes |
| cursor frozen over a watermark-only frame | `frames.ts` `toDeltaFrame` | watermark case, both lanes |
| upsert MERGED over the previous value | `adapters/indexeddb/store.ts` | present→absent, **web lane only** |
| upsert MERGED over the previous value | `adapters/mobile-sqlite/store.ts` | present→absent, **mobile lane only** |

The last two are the important pair: they prove the two lanes are two independent instruments, not
one test run twice.

**The audit, by probe** — `scripts/audit-phase2-client.test.ts` drives each detector against a
synthetic violation of its own item AND against the near-miss it must not flag. The near misses are
the half that stops the audit being "fixed" by deleting the comments that record the fix. The
visibility-filter detector's first draft used `[^)]*`, which stops at the arrow function's own
closing paren — so it matched nothing and reported a clean codebase. Its probe caught it.

---

## 3. The audit items, and where each stands

Run: `bun run audit:phase2-client`

| Item | Count | Status |
|---|---|---|
| `world-assumption` — client code that assumes it holds the WORLD | **0** | ADR 4 D7.3's rationale is amended in `engine/overlay.ts`; no affirmative claim survives |
| `client-visibility-filter` — the Replica arbitrating scoping | **0** | none found. The two near misses are layout (`RightRail`) and §3.1.4 M5's required affordance rendering a server-supplied `unauthorized` (`NewPanelMenu`) — both correct, and both pinned as non-findings |
| `per-user-state-local-home` — a local copy of anything POD-1076 moved | **0** | see §3.1 |
| `unattributed-store-read` — a persisted store adopted without a principal | **2** | **the deletion blocker, mechanized** — see §3.2 |

### 3.1 Why the per-user-state item is genuinely zero rather than unexamined

`packages/model/src/user-state/family.ts` is the authority, and the detector reads it at run time
instead of restating it. POD-1076 **moved** `readAt` (×3 entities), `tuckedAt`, `pinnedAt`, snooze,
pins and tab order into `(user_id, entity_id)` tables. The client keeps no local copy of any of them.

It **deliberately did not move** three facts, each recorded in `PER_USER_STATE_NON_MEMBERS` with its
reason: sidebar/tab/pane layout (client-local by construction — one browser profile is one person),
personal preference keys (one `PodiumSettings` blob; POD-352 owns splitting it), and the client
outbox + replica cursor (device-local, ADR 1 Am1 §10). The client's `ui-state` collection and
mobile's `useCollapsed` hold members of that excluded set only. Grading them here would be grading
this issue against a decision another issue made and documented.

### 3.2 The two findings, and what closes them

Both are the surviving TanStack composition roots from §1. `packages/sync/src/adapters/legacy-replica/adoption.ts`
(POD-377) is the gate and it is correct — adoption only when attribution is CERTAIN, ambiguity
resolves to discard, discarded work is dead-lettered with its payload redacted. Neither root calls
it, because neither builds the kernel store the gate was written for.

**This item reaches zero when POD-1220/POD-1223 land and the TanStack roots are deleted — the same
event.** The audit now says so mechanically rather than by anyone remembering.

---

## 4. Retiring TanStack must not retire a guarantee

The brief's last-chance check: what was the outgoing path *providing* that the kernel path is merely
assumed to provide? Each row below is a guarantee the TanStack replica implements today, with where
it lives after the deletion.

### 4.1 Covered — the kernel path has its own implementation AND its own test

| Guarantee | Where it is covered now |
|---|---|
| Cold-start paint from persisted data | `adapters/{indexeddb,mobile-sqlite}/conformance.test.ts` |
| Poisoned store never wedges boot; clears and cold-starts | `SqliteSyncStore.open` D4.5 arm + `crash.test.ts`, `store.test.ts` |
| Cursor-after-data ordering; cursor never advances over a gap | adapter `crash.test.ts` + kernel `replica.test.ts` |
| Quota denial is surfaced, never silent (`onDegraded`) | adapter `quota.test.ts`; asserted empty by the new regression too |
| Snapshot semantics — rows not present are removed | kernel `installSnapshot` + conformance |
| Delta idempotence, and in-order remove-then-upsert | adapter `applyOperations` + conformance |
| **present → absent applied as a nulling** | **`removal-family.test.ts` (this issue) — see §4.3** |
| remove / evict stay distinguishable on disk | `conformance/instantiation.ts` + `removal-family.test.ts` |
| Outbox entries never dropped silently on MIGRATION | `legacy-replica/{migrate,import}` tests |
| Outbox durability, **loud on quota failure** | **NOT carried — see §4.3 finding 1** |
| Legacy localStorage/AsyncStorage store migrated or cleanly re-bootstrapped | `legacy-replica/{adoption,migrate,import}` + POD-377's captured-snapshot fixture |

### 4.2 NOT yet covered — guarantees with no kernel-path home, owned by POD-1220/POD-1223

These are the answer to the brief's question, and they are the reason the deletion must not be done
by simply removing the file:

1. **The transcript-window LRU bound** (`REPLICA_TRANSCRIPT_ITEM_CAP = 200`,
   `REPLICA_TRANSCRIPT_CONVERSATION_CAP = 50`, spec §2.3 "phones, not archives"). It exists **only**
   in `replica.ts`, and every test of it (`replica.sqlite.test.ts`, `app/replica.test.ts`,
   `useTranscriptWindow.test.tsx`, the `ChatView` suites) runs against that implementation. POD-1220's
   brief says the window stays a client-side bulk cache and must NOT enter the entity table — so the
   facade must carry the bound, and the bound needs a test that is not this one.
2. **Coalesced row notifications per application** (#262): `applySnapshot`/`applyChanges` must notify
   once, against the FINAL state — a listener that reacted between the delete and the upsert observed
   a transient empty list, and the engine's worktree fallback and URL mirror fired on exactly that.
   The kernel emits per-change events; the coalescing is the facade's to provide.
3. **A bound on non-converging notification flushes** (#263 finding 5). TanStack-specific machinery,
   but the hazard is not: a listener that writes on every notification must be cut off loudly rather
   than spin the microtask queue.
4. **Stable empty-rows identity** for `rows()`/`useReplicaRows` pre-hydrate, so downstream memos do
   not churn.
5. **Cross-tab consistency.** Today it comes free from the lib's `storage` events. IndexedDB gives no
   equivalent for free; two tabs of the same browser profile are a real configuration.

### 4.3 Re-graded against the facade that actually exists — three of five carried, two NOT, and one instrument that cannot say NO

§4.2 was written before §1.1 established that the facade already exists on
`issue/1223-web-engine-on-the-kernel-replica`. Re-graded against that code:

| §4.2 item | Verdict against `kernel/facade.ts` + `kernel/side-cache.ts` |
|---|---|
| 1. transcript-window LRU | **CARRIED.** `side-cache.ts` uses `REPLICA_TRANSCRIPT_ITEM_CAP` / `REPLICA_TRANSCRIPT_CONVERSATION_CAP`, same caps, same write-time eviction order |
| 2. coalesced notifications | **CARRIED** — the facade's `batch`/pending machinery |
| 3. non-converging flush bound | **CARRIED** by the same machinery |
| 4. stable empty-rows identity | **CARRIED** — a shared frozen `EMPTY` |
| 5. cross-tab consistency | **CARRIED** — `side-cache` keeps the `storage`-event behaviour |

Good news, and it is why the merge is the right ask. Two things it does **not** carry:

**Finding 1 — the outbox's LOUD-on-quota posture is silently dropped. This is the serious one.**

The legacy replica routes the outbox family through a deliberately separate storage wrapper:

> *"Loud (never-degrade) storage for the outbox-family collections: unlike the entity blobs, a lost
> outbox entry is a lost user write — a quota-dead write is a data-loss risk and is logged loudly
> instead of swallowed."* — `replica.ts`, `outboxLoudStorage()`, which `console.error`s
> *"queued offline writes may be LOST on reload"* and **rethrows**.

The replacement does the opposite. `side-cache.ts`'s single `write` helper is documented
*"Best-effort: a quota failure degrades persistence, it does not break the UI"* and its `catch {}` is
**empty** — and `outboxStorage()` / `outboxAwaitingStorage()` both go through it. So on the kernel
path a quota-denied outbox write is swallowed with no log, no throw, and no `onDegraded`.

That contradicts ADR 6 D4.3 — queued entries are *"durable on the same footing as entity rows …
losing them on crash is a correctness bug, not degraded UX"* — and D4.4's never-silent posture. It is
also worse than it looks on web, because `apps/web/src/lib/kernelReplica.ts:117` backs the side cache
with `globalThis.localStorage` while entities go to IndexedDB: the outbox is left on the ~5MB blob
store whose quota failures are the origin of issue #181, with the one mechanism that made those
failures visible removed.

This is precisely the class the brief's last-chance check exists to catch — a guarantee held up by
the outgoing implementation's *incidental* behaviour, which disappears when the file does.

**Finding 2 — `facade.test.ts` is a single instrument, and both consumers inherit it.**

It runs against `memoryStorage()` and a hand-written stub cache. No real IndexedDB, no real SQLite.
That is the failure POD-1220 named, one level up from where we were discussing it: the file the web
AND mobile consumers both read through is tested against a `Map`. This issue's own
`removal-family.test.ts` demonstrates the cost concretely — the `settled()` fence bug was invisible
on SQLite and visible only on IndexedDB, and the per-adapter merge mutants each killed only their own
lane. A facade suite that cannot tell the two engines apart cannot see either.

### 4.4 Finding 1 is TWO defects, and the second is a prohibited placement rather than a risk

POD-1220 sharpened this and was right; **ADR 6 quoted verbatim from integration, verified here**:

> **D1 (binding):** *"localStorage and AsyncStorage **MUST NOT** hold replica entity collections, the
> oplog cursor, outbox entries, or optimistic-overlay state on any path — including "degraded."
> Degraded durability is **in-memory only** (D4.4)."*
>
> **D4.4 clause 4:** *"The adapter **MUST NOT** fall back to localStorage/AsyncStorage for the replica
> payload. Degraded mode is **in-memory only**."*

D1's own table permits `localStorage` for **"small UI preferences only"**. So the two defects
separate, and they have different fixes and different blast radii:

**Defect 1 — silent loss (D4.3 + D4.4 clause 3).** `side-cache.ts`'s `writeJson` swallows the quota
denial in an empty catch, and `outboxAt` uses it for both seams. A regression against the legacy
path, which did the opposite and said why. Cheap; merge-blocking on its own.

**Defect 2 — prohibited placement (D1).** The outbox is on the blob store D1 names explicitly. Live
in web's wiring today (`kernelReplica.ts:117`); not yet live on mobile, because nothing constructs
the facade there.

POD-1228's stated reason for not sitting over the kernel `OutboxStorePort` — that `OutboxRecord` and
the client `Outbox`'s tRPC entries are different shapes — is true but does not reach the conclusion:
that argues for a mapping layer, and POD-377's merged `readLegacyReplica` already is one, tested
against a captured real replica store.

**The fix is asymmetric.** Mobile can comply today: `SqliteOutboxStore.apply` with no span calls
`store.autocommit`, which is *synchronous*, so a synchronous `save()` is already durable on return —
measured on POD-377. Web cannot use that trick, because IndexedDB's commit is genuinely async (the
same fact behind this issue's `settled()` fence), so web needs an async outbox seam or, minimally,
its outbox moved onto the IndexedDB store. A fix designed on mobile and applied to web would quietly
reintroduce write-behind.

### 4.5 The patch, ready to apply — and why POD-378 cannot apply it

**Correction to an offer this issue made and should not have:** I told POD-1223 I would write this
patch. I cannot. `kernel/` does not exist on `issue/378-…`; merging POD-1223's branch is forbidden by
the fan-out's rule 1, and branching off a sibling would re-land their work under this issue. So the
patch has to be applied by POD-1223, on their branch. What this issue can do is remove every excuse
for it being slow, so the exact body is below.

**(a) `side-cache.ts` — the outbox stops being best-effort:**

```ts
/** The outbox is NOT best-effort. ADR 6 D4.3: queued entries are durable "on the
 *  same footing as entity rows … losing them on crash is a correctness bug, not
 *  degraded UX". The legacy path routed the outbox family through a separate loud
 *  wrapper for exactly this reason, and dropping it is a regression rather than a
 *  simplification. Log, surface (D4.4 clause 3), and RETHROW — a caller must not
 *  be allowed to believe a queued write is safe when it is not. */
function writeQueued(
  storage: StorageApi,
  key: string,
  value: unknown,
  onDegraded: (error: unknown) => void,
): void {
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch (error) {
    console.error(
      '[podium] OUTBOX persistence failed (storage quota?) — queued offline writes may be LOST on reload',
      error,
    )
    onDegraded(error)
    throw error
  }
}
```

`outboxAt` calls `writeQueued`; `SideCacheInit` gains `onDegraded?: (error: unknown) => void`.
`writeJson` keeps its empty catch and its comment gains "ui-state and transcripts only".

**(b) `facade.ts` — the outbox seam becomes injectable**, which is the one change POD-1220 needs to
fix mobile's placement in its own diff without touching web's behaviour:

```ts
export interface KernelReplicaInit {
  readonly cache: KernelCacheRead
  readonly side: SideCache
  /** The outbox's durable home, when it is NOT the side cache.
   *
   *  ADR 6 D1 names outbox entries among what localStorage/AsyncStorage MUST NOT
   *  hold "on any path". The side cache is a StorageApi blob store, so it
   *  satisfies D1 for ui-state and transcripts and NOT for the outbox. Mobile
   *  passes `SqliteStoreView.outbox` and lands in the entities' own transaction
   *  domain; web needs its own compliant seam and keeps the side cache only until
   *  it has one. The default preserves today's behaviour rather than silently
   *  changing web's. */
  readonly outbox?: { readonly queued: OutboxStorage; readonly awaiting: OutboxStorage }
}

// …
outboxStorage: (): OutboxStorage => init.outbox?.queued ?? side.outboxStorage(),
outboxAwaitingStorage: (): OutboxStorage => init.outbox?.awaiting ?? side.outboxAwaitingStorage(),
```

**(c) The test that makes (a) real.** A denied write must be *surfaced*, and `facade.test.ts` cannot
currently express that — a `memoryStorage()` never denies a quota, so the empty catch is unreachable
in that suite **by construction**. That is not thin coverage; it is a suite that cannot fail for
either reason this file is wrong. The case needs a `StorageApi` whose `setItem` throws
`QuotaExceededError`, asserting the throw propagates and `onDegraded` fired — and it should be
written as a mutant check: revert to `writeJson` and confirm the case goes red.

**Division agreed with POD-1220:** POD-1223 takes (a), (b) and (c) on their branch; POD-1220 takes
the mobile SQLite outbox binding in its own diff once POD-1223 is on integration. Defect 2 stays
merge-blocking for **web** specifically, since web's placement is live.

---

## 5. Verification run for this issue

- `bun run test:unit packages/client-core/src/replica/removal-family.test.ts` — 8 passed (4 cases × 2 backends)
- `bun run test:unit scripts/audit-phase2-client.test.ts` — 15 passed
- Five mutants, each applied and reverted atomically; all five killed, each precisely (§2.3)
- `bun run audit:phase2-client` — three items ZERO, one at 2 with both sites named
- `bun scripts/rearch-audit.ts` — OK, 29 items, 178 sites, baseline exact (no item is mapped to this phase)
