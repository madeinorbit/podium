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
| Outbox durability, loud on failure, entries never dropped silently | outbox store conformance + `legacy-replica/migrate` tests |
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

**Recommendation to whoever lands the facade:** treat §4.2 as acceptance criteria for POD-1220, not
as follow-up. Each item is currently held up by an implementation that is scheduled for deletion,
which is the precise shape "retiring a guarantee by accident" takes.

---

## 5. Verification run for this issue

- `bun run test:unit packages/client-core/src/replica/removal-family.test.ts` — 8 passed (4 cases × 2 backends)
- `bun run test:unit scripts/audit-phase2-client.test.ts` — 15 passed
- Five mutants, each applied and reverted atomically; all five killed, each precisely (§2.3)
- `bun run audit:phase2-client` — three items ZERO, one at 2 with both sites named
- `bun scripts/rearch-audit.ts` — OK, 29 items, 178 sites, baseline exact (no item is mapped to this phase)
