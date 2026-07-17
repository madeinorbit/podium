# ADR 6 — Replica storage decision

- **Status:** Proposed (human gate: POD-359)
- **Date:** 2026-07-17
- **Deciders:** architecture rewrite ADR pack (POD-359); human sign-off before Phase 1
- **Issue:** POD-752 (leaf of POD-359 item 6)
- **Consumers:** POD-307, POD-374, POD-375 (client replica adapters); POD-415 (daemon binding-store tooling clause only); POD-306 / POD-369–371 (conformance)
- **Related ADRs (forward refs by number):** ADR 1 (authority — replica never arbitrates), ADR 2 (sync protocol — transactional entity+cursor+outbox), ADR 3 (outbox lifecycle states), ADR 4 (storage representation role), ADR 7 (bulk vs control for transcripts), ADR 8 (adapter package placement)

---

## Context

Thin clients (web PWA / desktop webview / mobile) need a **persistent local replica** of
durable entities plus an **outbox** so offline paint and offline authoring survive
reload, backgrounding, and power loss.

### As-built interim (verified on integration tip + this branch)

| Fact | Evidence in tree |
|---|---|
| Web replica persists via TanStack DB `localStorageCollectionOptions` over `window.localStorage` | `packages/client-core/src/replica/replica.ts` module header + `createReplica` default `init.storage` |
| Production-sized entity blobs can exceed ~5 MB localStorage; quota path degrades entity writes | Same file: `entityStorage()` / issue #181 comments (“production-sized data can blow the ~5MB localStorage quota”) |
| Mobile wires the AsyncStorage write-behind bridge before `createReplica` | `apps/mobile/src/client/MobileClientProvider.tsx` (`createAsyncStorageReplicaStorage(AsyncStorage)` in the boot `useEffect`) |
| AsyncStorage bridge is write-behind: crash between sync cache write and flush loses the queue tail | `packages/client-core/src/replica/async-storage.ts` header + `enqueue` FIFO |
| Outbox still has a legacy localStorage key constant | `packages/client-core/src/outbox.ts` — `OUTBOX_LS_KEY = 'podium.outbox.v1'` |
| Current replica adapter size (TanStack-backed) | `packages/client-core/src/replica/replica.ts` = **1145** lines (re-counted; POD-307’s “1,114” is stale) |
| Replica entity kinds today | `ReplicaRows`: `sessions`, `issues`, `conversations`, `automations`, `automationRuns` |
| Server SQLite is drizzle-kit schema-as-code; runtime repos keep raw SQL | `apps/server/src/migrations/schema.ts` (`[spec:SP-4428]`); applier `runDrizzleMigrations` in `apps/server/src/migrations/index.ts`; migrations under `apps/server/src/migrations/drizzle/` |
| Daemon has **no** drizzle dependency | `rg drizzle apps/daemon` → empty |
| Daemon general state is JSON + in-memory; only SQLite is worker `discovery.db` | `apps/daemon/src/identity.ts` → `daemon.json`; `apps/daemon/src/discovery-worker.ts` owns `discovery.db` |
| Codex identity receipt spool (retain-until-ack) under instance runtime namespace | `apps/daemon/src/daemon.ts` — `codexReceiptDir = …/runtime/codex-identity-receipts`; class `CodexIdentityReceipts` in `apps/daemon/src/codex-identity-receipts.ts` |
| Ledger pre-decision for engines | `docs/rearchitecture-v3.md` §1 adopted decisions: “Transactional replica storage — IndexedDB on web (OPFS only if the pre-ADR spike proves a threshold need), SQLite on mobile…” |

The 2026-07-10 first-principles proposal is **referenced** by `docs/rearchitecture-v3.md` as plan source but is **not** present as a standalone file under `docs/` on this tree; binding text for this leaf is POD-359 item 6 + drift comments + the ledger line above + POD-307/374/375/415.

POD-359 item 6 and third-round review item 10 already **pre-decide** the platform engines. This ADR records them as binding, pins crash/quota semantics for every boundary ADR 2 requires, and absorbs the drizzle-tooling drift for mobile + daemon binding store.

### Out of scope (owned elsewhere)

| Concern | Owner |
|---|---|
| Home authority, conflict rules, “replica never arbitrates” | **ADR 1** |
| Feed epoch, wire/replica **protocol** version, cursor vs revision, bootstrap/gap heal | **ADR 2** |
| Outbox state machine, retry/age, dedupe horizon | **ADR 3** |
| Field schemas / storage representation composition | **ADR 4** |
| Server SQLite authoring (drizzle-kit) | **Fact** [spec:SP-4428] — named here only to separate journals |
| Plane classification of transcripts vs metadata | **ADR 7** |
| Adapter package placement | **ADR 8** |
| InstanceId brand vs runtime-only; build orchestration (tsgo/turbo) | **ADR 1 / ADR 8** (POD-359 drift items not about storage engines) |

---

## Decisions

### D1 — Platform engines (binding)

| Surface | Durable engine for replica entities + cursor + outbox + optimistic overlay | Allowed non-replica use |
|---|---|---|
| **Web** (PWA, desktop webview, any browser thin client) | **Transactional IndexedDB** | `localStorage` for **small UI preferences only** |
| **Mobile** (Expo / React Native) | **SQLite** (native driver; concrete package chosen at POD-375) | `AsyncStorage` for **small UI preferences only** |
| **Tests / private mode / hard quota session** | **In-memory** adapter of the same port | — |

**Decision:** localStorage and AsyncStorage **MUST NOT** hold replica entity collections, the oplog cursor, outbox entries, or optimistic-overlay state on any path — including “degraded.” Degraded durability is **in-memory only** (D4.4).

**Rationale:** POD-359’s phrase “prefs / degraded fallback” is tightened here. Using localStorage/AsyncStorage as a degraded *replica* store re-introduces the ~5 MB cliff and non-transactional multi-key writes already observed in production (`replica.ts` issue #181 path). Preferences that are lossy UX (theme, chrome layout) stay on LS/AsyncStorage.

**Rejected alternatives:**

| Alternative | Rejected because |
|---|---|
| Keep TanStack DB + localStorage as happy path | Production data already exceeds ~5 MB; no multi-key transactions; POD-307 finding 6 |
| SQLite-wasm in the browser as default | Bundle/precache cost; no need while IDB meets thin-client working sets; OPFS/SQLite-wasm only under D2 reversal |
| AsyncStorage as mobile durable store | Write-behind crash tail loss (`async-storage.ts`); not transactional with cursor/outbox |
| One engine everywhere (IDB only / SQLite only) | IDB is unavailable on RN; native SQLite is the mobile fit; web does not need wasm SQLite by default |

### D2 — OPFS is not adopted (spike not run)

**Decision:** Origin Private File System (alone or hosting SQLite-wasm) is **not** adopted. IndexedDB remains the web default.

**Spike record (this issue):**

| Item | Result |
|---|---|
| Pre-sign-off OPFS spike run as part of POD-752? | **No** |
| Concrete threshold (IDB fails, OPFS passes)? | **None recorded** |
| Outcome | OPFS not adopted |

**Rationale:** The known localStorage failure is fully addressed by transactional IndexedDB. No measured bootstrap-write latency, multi-tab contention, or working-set size currently shows IDB cannot meet thin-client needs. POD-374’s AC is “adapter matches the ADR exactly” and “no deferred in-issue evaluation” of OPFS.

**Reversal condition (only path to OPFS):** a spike filed under a child of POD-307/POD-374 produces a concrete, reproducible threshold that IDB fails and OPFS (or OPFS+SQLite-wasm) passes, **and** PWA bundle/precache cost is acceptable. Until then implementers must not re-open OPFS inside POD-374.

**Rejected alternatives:**

| Alternative | Rejected because |
|---|---|
| “Evaluate OPFS inside the web adapter issue” | Third-round item 10 + POD-374: decision is here, not deferred |
| Adopt OPFS preemptively for headroom | Cost without evidence; violates default-IDB settlement |

### D3 — One storage port; platform adapters behind it

**Decision:** Replica / Outbox kernel code depends on a **single storage port** (concrete TypeScript name finalized with the kernel in POD-306; concept fixed here):

- Open / close / schema-migrate the store.
- **Atomic** apply of a mutation batch that may include any combination of: entity upserts/deletes, cursor advance, outbox enqueue/ack/dead-letter, overlay put/clear.
- Read paths for hydrate (cold paint) and conformance probes.
- Report durability mode: `durable` | `degraded-memory` | `unavailable`.
- Quota / corruption signals the kernel can surface to UI.

Web (POD-374) and mobile (POD-375) are **adapters** of that port. Kernel and conformance suite never import IndexedDB or SQLite APIs directly.

**Rejected alternative:** Platform-specific kernel forks — rejected to keep one conformance suite (POD-306).

### D4 — Crash, power-loss, and quota semantics (normative)

These rules apply at **every** entity / cursor / outbox / overlay boundary. They are acceptance criteria for POD-307, POD-374, POD-375, and the conformance suite.

#### D4.1 Atomic multi-record commit

A single kernel operation that touches more than one of {entities, cursor, outbox, overlay} **commits in one storage transaction** (IDB `transaction` spanning the relevant object stores; SQLite `BEGIN IMMEDIATE … COMMIT`).

On crash or power loss mid-operation the store recovers to either the **pre-operation** or **post-operation** snapshot — never a torn mix (e.g. new cursor without entity rows it covers; outbox ack without overlay clear; entity rows without a still-pending outbox entry the user saw as queued).

#### D4.2 Cursor-after-data (and its dual)

Persisting a higher cursor **implies** all entity mutations covered by that cursor are durable in the same commit (or an earlier one). A crash may force **re-application of idempotent upserts** from the server (cursor behind data is forbidden; data slightly “ahead” of a lost cursor advance is recovered by re-pull). Gap-healing is ADR 2’s protocol concern; storage must not create gaps by partial write.

#### D4.3 Outbox durability class

Outbox entries representing user intent not yet accepted by Authority (`queued`, `sending`, and recovery states defined by ADR 3 D9) are **durable** on the same footing as entity rows. Losing them on crash is a correctness bug, not degraded UX.

#### D4.4 Quota exhaustion

When a durable write fails for quota (or equivalent platform denial):

1. The failing operation does **not** partially apply.
2. The adapter flips durability mode to `degraded-memory` for the remainder of the session (or until a successful durable probe).
3. The UI is **explicitly informed** (kernel signal → client shell): offline guarantees are suspended; reload may cold-start.
4. The adapter **MUST NOT** fall back to localStorage/AsyncStorage for the replica payload. Degraded mode is **in-memory only**.
5. On next cold start, if durable storage is usable again, hydrate from it; if the previous session never flushed, cold-start empty and re-bootstrap (ADR 2).

#### D4.5 Corruption / poison

Hydrate failures (decode error, failed invariant, unknown future schema that cannot be migrated) **clear** the affected store partition (or the whole replica DB) and proceed as a cold client. Never wedge boot. Log; do not throw past the adapter boundary (same posture as `docs/spec/thin-client-replica.md` invariant 2).

#### D4.6 Multi-tab / multi-process (web)

IndexedDB is the coordination point. Concurrent tabs may race; last committed transaction wins at the storage layer. Protocol-level arbitration remains server-side (ADR 1). Adapters SHOULD use a single-writer or version-check pattern so two tabs do not interleave non-transactional read-modify-write of the same logical record. Exact multi-tab UX is POD-374 detail, not a second source of truth.

#### D4.7 Mobile lifecycle

Backgrounding, process death, and cold-start-offline must preserve D4.1–D4.5. SQLite transactions commit before the adapter resolves the kernel write. “Best-effort flush on `AppState` change” is insufficient as the sole durability mechanism.

**Rejected alternatives for D4:**

| Alternative | Rejected because |
|---|---|
| Cursor-after-data via ordered async flushes only (today’s FIFO write-behind) | Crash can still lose the tail; not a transaction |
| Silent best-effort when quota hits | Hides correctness loss; POD-307 requires surfaced degradation |
| localStorage as quota overflow valve | Re-enters the 5 MB cliff and non-transactional writes |

### D5 — Schema versioning vs drizzle-kit (drift absorption)

Three version lines stay **strictly separate** (ADR 2 must also enforce the wire vs server split):

| Version line | Scope | Tooling |
|---|---|---|
| **Wire / replica protocol version** | Feed epoch, message schemas, negotiation | Protocol package; **ADR 2** |
| **Server DB journal** | Authority SQLite | **drizzle-kit** [spec:SP-4428] — `schema.ts`, `runDrizzleMigrations`, `__drizzle_migrations` |
| **Per-store schema version** | Physical layout of a given replica or host store | **This ADR (D5)** |

#### D5.1 Client replica stores — **not** drizzle-managed

**Decision:** Web IndexedDB and mobile SQLite replica adapters are **not** drizzle-managed.

**Rationale:**

- Caches of Authority truth + local outbox — not multi-feature relational systems with commutative migration graphs.
- Port contract is small (entities, cursor, outbox, overlay); layout changes are infrequent and adapter-local.
- Mobile cannot share the server’s `bun:sqlite` migrator path; web IndexedDB has no drizzle authoring path.
- Coupling client layout to drizzle-kit would blur wire/protocol version with a physical store journal.

**Mobile (POD-375) stays bespoke:** integer (or ordered) `schema_version` inside the SQLite DB; forward-only migrations owned by the mobile adapter module; tested in conformance + lifecycle suites. Prefer few tables/blob stores keyed by entity kind over mirroring the full server relational schema.

**Web (POD-374):** IndexedDB database + object-store version via `IDBOpenDBRequest` `onupgradeneeded` (or equivalent). Same logical schema_version semantics; no drizzle.

**Rejected alternative:** Adopt drizzle-kit on mobile “for consistency with server” — rejected: different runtime, different journal, greenfield adapter (`MobileClientProvider` still on AsyncStorage today), false consistency.

#### D5.2 Daemon binding store (POD-415) — **bespoke**, not drizzle-kit

**Decision:** The on-host SessionBinding / alias-history store is a **bespoke versioned store**, **not** drizzle-kit-authored.

**Scope note:** Binding store **inventory** includes today’s scattered state (session-observers, control/session pins) **and** the Codex identity receipt spool (`CodexIdentityReceipts`, retain-until-ack) that POD-737 folds in — migration constraint, not only a data move.

**Rationale:**

- Small, lifecycle-shaped surface (bindings, alias HISTORY, retain-until-ack receipts), not a growing multi-domain relational schema.
- Daemon already owns non-drizzle SQLite (`discovery.db`) and JSON (`daemon.json`, receipt files under instance `runtime/codex-identity-receipts`). A second drizzle project + CI journal for a handful of tables costs more than it saves.
- Schema version is **explicitly independent** of server `__drizzle_migrations` — a separate drizzle app would still be a separate journal; “consistency with server” would be tooling familiarity only.
- One-shot migration from scattered state is imperative (read JSON dirs → write rows); bespoke versioning makes that migration first-class.

**Required of POD-415 regardless of tooling:**

- Integer (or ordered) schema version recorded in the store.
- Forward-only migrations; refuse unknown-future versions loudly (downgrade guard).
- Unit tests for empty / mid-version / current opens.
- One-shot migration from a real daemon state dir, including codex receipt retain-until-ack.

**Revisit criterion:** if the binding store grows into multi-table relational complexity comparable to the server (many entities, frequent cross-branch schema PRs, need for `drizzle-kit check` commutativity), open a follow-up to adopt drizzle-kit for the **daemon only** — still a separate journal from the server.

**Rejected alternative:** drizzle-kit on the daemon “for consistency with SP-4428” — rejected for the reasons above; SP-4428 remains server-only.

#### D5.3 Server remains the sole drizzle-kit consumer (today)

**Decision:** No change to [spec:SP-4428]. Server repositories keep raw SQL; drizzle is schema-authoring + migration apply only (`runDrizzleMigrations`). Clients and the daemon binding store do not join that journal.

### D6 — Migration from today’s localStorage / AsyncStorage replicas

**Decision:** On first open of the new adapter:

1. Detect legacy keys / collections (replica localStorage prefixes; `podium.outbox.v1`; AsyncStorage namespaced keys).
2. **Best-effort import** into the new store inside one transaction when the payload is complete and decodable; otherwise **discard and cold bootstrap**.
3. Delete or tombstone legacy keys only after a successful durable commit of the new store (or after an explicit abandon-legacy decision when import fails).
4. Never leave a client stuck with a half-migrated cursor.

Exact key inventory is POD-307 implementation work; this ADR requires the **upgrade-or-rebootstrap** posture (no silent dual-write forever).

### D7 — What is *not* replica storage

| Data | Storage | Notes |
|---|---|---|
| UI preferences (theme, chrome layout) | localStorage / AsyncStorage / ui-state collection | Lossy OK |
| Transcript windows (bounded LRU) | May share the replica DB **or** a sibling store | Bulk-plane cache (ADR 7); still transactional per write; eviction ≠ outbox loss |
| Server Authority DB | Server SQLite + drizzle-kit | Not a replica |
| Daemon discovery cache | Worker `discovery.db` | Not binding store; not client replica |
| Secrets / credentials | Server-owned; never replicated (ADR 1 / POD-352) | Must not appear in client stores |

---

## Drift-refresh clauses (explicit absorption)

From **POD-359 DRIFT REFRESH (2026-07-16)** item (1) — binding on this ADR:

| Clause | How ADR 6 absorbs it |
|---|---|
| drizzle-kit is a decided fact for **server-side** SQLite (schema-as-code, journal order, `migration:check`, `runDrizzleMigrations`, backup-restore rollback, no down migrations) | **D5.3** + Context evidence table; named as fact, not re-decided |
| ADR 2 must distinguish wire/replica protocol version from server drizzle journal | **D5** three-line table; wire row owned by ADR 2 |
| ADR 6 clients (IndexedDB / mobile SQLite) are **explicitly NOT** drizzle-managed | **D5.1** |
| Decide whether daemon binding store (POD-415) and mobile SQLite (POD-375) adopt drizzle-kit or stay bespoke | **D5.1 mobile bespoke; D5.2 daemon binding bespoke** |

POD-359 drift items (2) instance identity and (3) plane-inventory surface, and **DRIFT REFRESH 2** (build orchestration, browser-open / sessionResumeRefAck) are **not storage decisions** — owned by ADR 1 / ADR 7 / ADR 8; listed under Out of scope.

From **POD-375** drift: mobile provider still wires `createAsyncStorageReplicaStorage` → greenfield SQLite adapter; tooling decided **bespoke** (D5.1).

From **POD-415** drift: no daemon migration runner today; `schema_version` wording on that issue is obsolete (server uses drizzle journal); binding store is new; tooling decided **bespoke** (D5.2); receipt spool inventory + POD-737 retain-until-ack called out in D5.2.

---

## Normative platform notes

### Web / IndexedDB

- Explicit object stores (or equivalent) for at least: entities (by kind or unified), meta/cursor, outbox, overlay. Grouping is implementation choice if D4.1 holds.
- Structured clone of typed records preferred over one giant JSON blob per collection when it reduces write amplification; either is acceptable if transactions stay correct.
- happy-dom / Playwright conformance must exercise kill-between-writes (abort transaction / close DB mid-batch) and quota-full paths.

### Mobile / SQLite

- WAL mode recommended; single connection writer (or serialized write queue) from the adapter.
- Migrations run before the first kernel write after open.
- Lifecycle tests: background mid-write, force-stop, cold-start offline paint from durable state, reconnect drain.

### Degraded in-memory

- Same port implementation as durable adapters (one code path in the kernel).
- Durability mode `degraded-memory` (or `persistent === false`) is visible to UI.
- No attempt to “save what we can” into localStorage/AsyncStorage for entities/outbox.

---

## Alignment with implementation issues

| Issue | How this ADR binds it |
|---|---|
| **POD-307** | Clients on kernel Replica+Outbox; engines and D4 semantics; retire TanStack DB + localStorage entity persistence; legacy upgrade-or-rebootstrap (D6) |
| **POD-374** | Web adapter = transactional IndexedDB only; OPFS out unless D2 reversal; crash/quota tests per D4 |
| **POD-375** | Mobile adapter = SQLite; AsyncStorage prefs only; **bespoke** schema_version (D5.1); lifecycle tests |
| **POD-415** | Binding store **bespoke** versioned persistence (D5.2); not drizzle-kit; journal independent of server |
| **POD-737** | Receipt spool folds into binding store; retain-until-ack is a migration constraint under D5.2 |
| **POD-306 / 369–371** | Conformance includes storage-port fakes **and** real IDB/SQLite adapters against D4 |
| **POD-352** | Secrets never enter replica stores (cross-check) |

---

## Cross-ADR boundaries

| Concern | Owner |
|---|---|
| Arbitration / offline write permission | **ADR 1** — storage only persists; never decides truth |
| Transactional entity+cursor+outbox as protocol requirement | **ADR 2** — this ADR supplies the durable mechanism |
| Outbox state machine | **ADR 3** — states durable per D4.3 |
| Storage representation field composition | **ADR 4** — adapters map model storage shapes |
| Plane for transcripts vs metadata | **ADR 7** — transcript LRU is bulk cache, still D4-safe |
| Adapter package placement | **ADR 8** |
| Server migrations | **SP-4428** — not this ADR’s runtime |

---

## Consequences

### Positive

- Removes the known localStorage/AsyncStorage durability cliff before Phase 2 deepens offline UX.
- One crash/quota rule set for web and mobile; shared conformance cases.
- OPFS non-adoption closes open-ended adapter scope.
- Schema-tooling decision unblocks POD-375 and POD-415.
- Wire / server / client / daemon version lines stay separable.

### Negative / cost

- Real IDB + SQLite adapter engineering (POD-374/375), not a TanStack config flag.
- Two small bespoke migration disciplines (mobile + daemon) instead of one drizzle graph — accepted to avoid false consistency.
- Multi-tab web still needs careful adapter design (D4.6).

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Implementers reintroduce localStorage “just for the outbox” | D1/D4.4 forbid it; POD-307 AC + checklist |
| OPFS re-opened as drive-by in POD-374 | D2 + POD-374 AC: match this ADR exactly |
| Drizzle sneaks into mobile “for consistency” | D5.1; POD-375 drift resolved |
| Daemon binding store is unversioned JSON forever | D5.2 requires schema_version + migrations + tests |
| Torn writes pass unit tests but fail on device kill | Conformance + lifecycle tests on POD-374/375 |
| Legacy clients stuck after upgrade | D6 upgrade-or-rebootstrap |

---

## Compliance checklist (for implementers and reviewers)

**In compliance** when:

- [ ] Web durable replica path is IndexedDB with multi-store (or equivalent) transactions.
- [ ] Mobile durable replica path is SQLite with SQL transactions.
- [ ] localStorage/AsyncStorage hold only prefs — never replica entities/cursor/outbox/overlay.
- [ ] Entity + cursor + outbox (+ overlay) mutations the kernel issues together commit atomically (D4.1).
- [ ] Quota failure surfaces degradation and uses **in-memory only**.
- [ ] Corrupt store cold-starts; boot never wedges.
- [ ] Mobile/web schema versions are adapter-local and not wired to drizzle journals.
- [ ] Daemon binding store (when implemented) is versioned and not drizzle-kit unless a future decision revisits D5.2.
- [ ] Legacy localStorage replica migrates or re-bootstraps once (D6).
- [ ] Conformance or adapter tests cover kill-between-writes and quota-full.

**Out of compliance** when it:

- Treats OPFS/SQLite-wasm as the web default without meeting D2’s reversal condition.
- Persists outbox or cursor in localStorage/AsyncStorage on any path that claims durability.
- Applies cursor, entities, or outbox in separate non-transactional writes on the durable path.
- Runs drizzle-kit as the migration engine for client replica DBs.
- Couples client or daemon store schema_version to server `__drizzle_migrations`.

---

## Status and sign-off

| Stage | Owner |
|---|---|
| Proposed | POD-752 (this document) |
| Pack reconciliation + index | POD-359 (no index file created by this leaf) |
| Human sign-off | POD-359 human gate (frontmatter → Accepted) |

### Self-verify notes (POD-752 delivery)

- Rebased onto integration tip `ca361327` before finalizing.
- Single file owned: `docs/adr/0006-replica-storage.md`.
- Citations re-checked against tree paths above; replica line count re-derived (1145).
- Drift-refresh storage clauses each mapped in the dedicated section.
- No merge lock, no main merge, no other ADR files, no ledger edit.
