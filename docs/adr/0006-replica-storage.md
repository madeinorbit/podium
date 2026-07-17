# ADR 6 — Replica storage decision

- **Status:** Proposed (human gate: POD-359)
- **Date:** 2026-07-17
- **Deciders:** architecture rewrite ADR pack (POD-359); human sign-off before Phase 1
- **Issue:** POD-752 (leaf of POD-359 item 6)
- **Consumers:** Phase 2 clients on the kernel Replica — POD-307, POD-374, POD-375; daemon binding store POD-415 (schema-tooling clause only); conformance suite POD-306/369–371
- **Related ADRs:** ADR 1 (authority/ownership — replica never arbitrates), ADR 2 (sync protocol — transactional entity+cursor+outbox), ADR 3 (outbox lifecycle), ADR 4 (storage representation role), ADR 8 (package placement of storage adapters)

---

## Context

Thin clients (web PWA / desktop webview / mobile) need a **persistent local replica** of
durable entities plus an **outbox** so offline paint and offline authoring survive
reload, backgrounding, and power loss. The interim implementation
(`packages/client-core/src/replica/`) persists via **localStorage** on web and a
write-behind **AsyncStorage** bridge on mobile. That plan is known-broken at scale:

| Failure mode | Evidence |
|---|---|
| Quota | Production entity data already exceeds the typical ~5 MB localStorage ceiling (POD-307). |
| Crash tail loss | AsyncStorage bridge is write-behind; a kill between the sync cache write and the flush loses the queue tail — including the risk that a cursor lands without its preceding entity blobs if ordering were ever inverted (today ordering is FIFO, but durability is still best-effort). |
| Non-transactional multi-key | localStorage has no multi-key transaction: entity blobs, cursor, and outbox cannot commit atomically. |
| Dual degraded path | Private mode / quota already force an in-memory fallback; the "happy" path was never transactional either. |

The 2026-07-13 adversarial review (third-round item 10) and the migration ledger
(`docs/rearchitecture-v3.md`) already **pre-decide** the platform engines. This ADR
records those decisions as binding, pins crash/quota semantics at every boundary the
sync kernel requires (ADR 2), and absorbs post-freeze drift about **schema-migration
tooling** after server-side drizzle-kit adoption ([spec:SP-4428]).

### What this ADR does *not* decide

| Concern | Owner |
|---|---|
| Who is home authority; conflict rules; replica never arbitrates | **ADR 1** |
| Feed epoch, wire/replica protocol version, cursor vs per-entity revision, bootstrap | **ADR 2** |
| Outbox states, retry/age, dedupe horizon | **ADR 3** |
| Field schemas / storage representation composition | **ADR 4** |
| Server SQLite authoring tool (drizzle-kit) and server journal | **Fact** [spec:SP-4428]; distinguished from wire version in ADR 2 |
| Package placement of adapters | **ADR 8** |

---

## Decision

### D1 — Platform engines (binding)

| Surface | Durable engine for replica entities + cursor + outbox + optimistic overlay | Allowed for small prefs / degraded fallback only |
|---|---|---|
| **Web** (PWA, desktop webview, any browser thin client) | **Transactional IndexedDB** | `localStorage` |
| **Mobile** (Expo / React Native) | **SQLite** (native driver; concrete package chosen at POD-375) | `AsyncStorage` |
| **In-process tests / private mode / hard quota** | **In-memory** adapter implementing the same port | — |

**localStorage and AsyncStorage MUST NOT** hold replica entity collections, the oplog
cursor, outbox entries, or optimistic-overlay state except as an **explicitly
surfaced degraded mode** (see D4). They remain appropriate for small UI preferences
(theme, sidebar width, last-selected tab) whose loss is UX noise, not correctness.

### D2 — OPFS is not adopted (no pre-sign-off spike)

**IndexedDB is the web default.** Origin Private File System (OPFS) — alone or as a
host for SQLite-wasm — is **not** adopted by this ADR.

A pre-sign-off performance/capacity spike was **not** run as part of POD-752: the
known failure of localStorage is fully addressed by transactional IndexedDB, and no
measured threshold (bootstrap write latency, multi-tab write contention, or working-set
size) currently demonstrates that IDB cannot meet thin-client needs.

**Reversal condition (only path to OPFS):** a spike, filed under a child of POD-307 /
POD-374, produces a concrete, reproducible threshold that IDB fails and OPFS (or
OPFS+SQLite-wasm) passes, **and** the PWA bundle/precache cost is acceptable. Until
then implementers must not "evaluate OPFS inside the adapter issue" — POD-374 builds
IndexedDB as specified here.

### D3 — One storage port; platform adapters behind it

Replica / Outbox kernel code depends on a **single storage port** (name finalized with
the kernel in POD-306; concept fixed here):

- Open / close / schema-migrate the store.
- **Atomic** apply of a mutation batch that may include any combination of:
  entity upserts/deletes, cursor advance, outbox enqueue/ack/dead-letter, overlay
  put/clear.
- Read paths for hydrate (cold paint) and conformance probes.
- Report durability mode: `durable` | `degraded-memory` | `unavailable`.
- Quota / corruption signals that the kernel can surface to UI.

Web (POD-374) and mobile (POD-375) are **adapters** of that port. The kernel and
conformance suite never import IndexedDB or SQLite APIs directly.

### D4 — Crash, power-loss, and quota semantics (normative)

These rules apply at **every** entity / cursor / outbox / overlay boundary. They are
acceptance criteria for POD-307, POD-374, POD-375, and the conformance suite.

#### D4.1 Atomic multi-record commit

A single kernel operation that touches more than one of {entities, cursor, outbox,
overlay} **commits in one storage transaction** (IDB `transaction` spanning the
relevant object stores; SQLite `BEGIN IMMEDIATE … COMMIT`).

On crash or power loss mid-operation the store recovers to a state that is either:

- the **pre-operation** snapshot, or
- the **post-operation** snapshot,

never a torn mix (e.g. new cursor without the entity rows it covers; outbox ack
without the corresponding overlay clear; entity rows without a still-pending outbox
entry the user already saw as "queued").

#### D4.2 Cursor-after-data (and its dual)

Persisting a higher cursor **implies** all entity mutations covered by that cursor are
durable in the same commit (or an earlier one). A crash may force **re-application of
idempotent upserts** from the server (cursor behind data is forbidden; data slightly
"ahead" of a lost cursor advance is recovered by re-pull). Gap-healing remains ADR 2's
protocol concern; storage must not create gaps by partial write.

#### D4.3 Outbox durability class

Outbox entries in states that represent user intent not yet accepted by Authority
(`queued`, `in-flight`, and any recovery states defined by ADR 3) are **durable** on
the same footing as entity rows. Losing them on crash is a correctness bug, not
degraded UX.

#### D4.4 Quota exhaustion

When a durable write fails for quota (or equivalent platform denial):

1. The failing operation does **not** partially apply.
2. The adapter flips durability mode to `degraded-memory` for the remainder of the
   session (or until a successful durable probe).
3. The UI is **explicitly informed** (kernel signal → client shell): offline guarantees
   are suspended; reload may cold-start.
4. The adapter **MUST NOT** silently fall back to localStorage/AsyncStorage for the
   replica payload (that would re-introduce the 5 MB cliff and non-transactional
   writes). Degraded mode is in-memory only.
5. On next cold start, if durable storage is usable again, hydrate from it; if the
   previous session never flushed, cold-start from empty and re-bootstrap (ADR 2).

#### D4.5 Corruption / poison

Hydrate failures (decode error, failed invariant check, unknown future schema that
cannot be migrated) **clear the affected store partition** (or the whole replica DB)
and proceed as a cold client. Never wedge boot. Log; do not throw past the adapter
boundary (preserves thin-client-replica invariant 2).

#### D4.6 Multi-tab / multi-process (web)

IndexedDB is the coordination point. Concurrent tabs may race; last committed
transaction wins at the storage layer. Protocol-level arbitration remains server-side
(ADR 1). Adapters SHOULD use a single-writer or version-check pattern so two tabs do
not interleave non-transactional read-modify-write of the same logical record. Exact
multi-tab UX (leader election, `storage` events) is an implementation detail of
POD-374, not a second source of truth.

#### D4.7 Mobile lifecycle

Backgrounding, process death, and cold-start-offline must preserve D4.1–D4.5.
SQLite transactions commit before the adapter resolves the kernel write. "Best-effort
flush on `AppState` change" is insufficient as the sole durability mechanism.

### D5 — Schema versioning vs drizzle-kit (drift absorption)

Three version lines stay **strictly separate** (also required of ADR 2):

| Version line | Scope | Tooling |
|---|---|---|
| **Wire / replica protocol version** | Feed epoch, message schemas, negotiation | Protocol package; ADR 2 |
| **Server DB journal** | Authority SQLite on the server | **drizzle-kit** [spec:SP-4428] |
| **Per-store schema version** | Physical layout of a given replica or host store | **This ADR (D5)** |

#### D5.1 Client replica stores — **not** drizzle-managed

Web IndexedDB and mobile SQLite replica adapters are **explicitly not** drizzle-managed.
Rationale:

- They are **caches of Authority truth** plus a local outbox, not multi-feature
  relational systems with commutative migration graphs.
- The storage port contract is small and stable (entities, cursor, outbox, overlay);
  layout changes are infrequent and adapter-local.
- Mobile cannot share the server's `bun:sqlite` migrator path; web IndexedDB has no
  drizzle story at all.
- Coupling client layout to drizzle-kit would blur the wire/protocol version with a
  physical store journal — the exact confusion ADR 2 must prevent.

**Mobile (POD-375) stays bespoke:** an integer (or ordered) `schema_version` inside the
SQLite DB, forward-only migrations owned by the mobile adapter module, tested in the
conformance + lifecycle suites. Prefer a small number of tables/blob stores keyed by
entity kind over mirroring the full server relational schema.

**Web (POD-374):** IndexedDB database + object-store version via `IDBOpenDBRequest`
`onupgradeneeded` (or equivalent). Same logical schema_version semantics; no drizzle.

#### D5.2 Daemon binding store (POD-415) — **bespoke**, not drizzle-kit

The on-host **SessionBinding / alias-history store** (POD-415; inventory also includes
codex identity receipts / retain-until-ack spool per POD-737) is **new host
persistence**, independent of the server DB journal. Decision: **do not adopt
drizzle-kit** for it.

Rationale:

- Surface area is small (bindings, alias HISTORY observations, ack-spool records) and
  lifecycle-shaped (retain-until-ack), not a growing multi-domain relational schema.
- The daemon already owns non-drizzle SQLite (`discovery.db` worker cache) and JSON
  files (`daemon.json`, receipt spools). A second drizzle project + CI journal for a
  handful of tables costs more than it saves.
- Schema version is **explicitly independent** of `__drizzle_migrations` on the server
  — a separate drizzle app would still be a separate journal; "consistency with
  server" would be tooling familiarity only, not shared evolution.
- One-shot migration from scattered state is imperative by nature (read JSON dirs →
  write rows); a bespoke versioned store makes that migration first-class rather than
  a custom SQL side script around `migrate()`.

**Required of POD-415 regardless of tooling:**

- Integer (or ordered) schema version recorded in the store.
- Forward-only migrations; refuse unknown-future versions loudly (downgrade guard).
- Unit tests for empty / mid-version / current opens.
- One-shot migration from a real daemon state dir (observers, control/session pins,
  codex identity receipts retain-until-ack constraint).

**Revisit criterion:** if the binding store grows into multi-table relational
complexity comparable to the server (many entities, frequent cross-branch schema
PRs, need for `drizzle-kit check` commutativity), open a follow-up to adopt
drizzle-kit for the **daemon only** — still a separate journal from the server.

#### D5.3 Server remains the sole drizzle-kit consumer (today)

No change to [spec:SP-4428]. Server repositories keep raw SQL; drizzle is
schema-authoring + migration apply only.

### D6 — Migration from today's localStorage / AsyncStorage replicas

On first open of the new adapter:

1. Detect legacy keys / collections (`podium.*` localStorage replica prefixes,
   AsyncStorage namespaced keys).
2. **Best-effort import** into the new store inside one transaction when the payload
   is complete and decodable; otherwise **discard and cold bootstrap**.
3. Delete or tombstone legacy keys only after a successful durable commit of the new
   store (or after an explicit "abandon legacy" decision when import fails).
4. Never leave a client stuck with a half-migrated cursor.

Exact key inventory lives with POD-307 implementation; this ADR only requires the
upgrade-or-rebootstrap posture (no silent dual-write forever).

### D7 — What is *not* replica storage

| Data | Storage | Notes |
|---|---|---|
| UI preferences (theme, chrome layout) | localStorage / AsyncStorage / ui-state collection | Lossy OK |
| Transcript windows (bounded LRU) | May share the replica DB **or** a sibling store | Bulk-plane cache (ADR 7); still transactional per write; eviction ≠ outbox loss |
| Server Authority DB | Server SQLite + drizzle-kit | Not a replica |
| Daemon discovery cache | Existing worker `discovery.db` | Not binding store; not client replica |
| Secrets / credentials | Server-owned; never replicated (ADR 1 / POD-352) | Must not appear in client stores |

---

## Normative platform notes

### Web / IndexedDB

- Use explicit object stores (or equivalent) for at least: entities (by kind or
  unified), meta/cursor, outbox, overlay. Grouping is an implementation choice so long
  as D4.1 holds.
- Prefer structured clone of typed records over one giant JSON blob per collection
  when it reduces write amplification; either is acceptable if transactions stay
  correct.
- Happy-dom / Playwright conformance must exercise kill-between-writes (abort
  transaction / close DB mid-batch) and quota-full paths.

### Mobile / SQLite

- WAL mode recommended; single connection writer (or serialized write queue) from the
  adapter.
- Migrations run before the first kernel write after open.
- Lifecycle tests: background mid-write, force-stop, cold-start offline paint from
  durable state, reconnect drain.

### Degraded in-memory

- Same port implementation as durable adapters (one code path in the kernel).
- `persistent === false` (or durability mode `degraded-memory`) is visible to UI.
- No attempt to "save what we can" into localStorage for entities/outbox.

---

## Alignment with implementation issues

| Issue | How this ADR binds it |
|---|---|
| **POD-307** | Clients on kernel Replica+Outbox; engines and semantics here; retire TanStack DB + localStorage entity persistence. |
| **POD-374** | Web adapter = transactional IndexedDB only; OPFS out unless reversal condition met; crash/quota tests per D4. |
| **POD-375** | Mobile adapter = SQLite; AsyncStorage prefs/degraded only; **bespoke** schema_version (D5.1); lifecycle tests. |
| **POD-415** | Binding store **bespoke** versioned persistence (D5.2); not drizzle-kit; journal independent of server. |
| **POD-737** | Receipt spool folds into binding store; retain-until-ack is a migration constraint under D5.2. |
| **POD-306 / 369–371** | Conformance suite includes storage-port fakes **and** real IDB/SQLite adapters against D4. |
| **POD-352** | Secrets never enter replica stores (cross-check). |

---

## Cross-ADR boundaries

| Concern | Owner |
|---|---|
| Arbitration / offline write permission | **ADR 1** — storage only persists; never decides truth |
| Transactional entity+cursor+outbox as protocol requirement | **ADR 2** — this ADR supplies the durable mechanism |
| Outbox state machine | **ADR 3** — states must be durable per D4.3 |
| Storage representation field composition | **ADR 4** — adapters map model storage shapes |
| Plane for transcripts vs metadata | **ADR 7** — transcript LRU is bulk cache, still D4-safe |
| Adapter package placement | **ADR 8** |
| Server migrations | **SP-4428** — not this ADR's runtime |

---

## Consequences

### Positive

- Removes the known localStorage/AsyncStorage durability cliff before Phase 2 clients
  deepen offline UX.
- Single set of crash/quota rules for web and mobile; conformance can share cases.
- Clear non-adoption of OPFS avoids open-ended "evaluate in the adapter issue" scope.
- Schema-tooling decision unblocks POD-375 and POD-415 without waiting on a second
  human gate.
- Wire / server / client / daemon version lines stay separable.

### Negative / cost

- IndexedDB and SQLite adapters are real engineering (POD-374/375), not a
  configuration flag on TanStack DB.
- Bespoke migrations on mobile and daemon mean two small migration disciplines
  instead of one drizzle graph — accepted to avoid false consistency.
- Multi-tab web still needs careful adapter design (D4.6).

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Implementers reintroduce localStorage "just for the outbox" | D1/D4.4 forbid it; POD-307 AC + review checklist below. |
| OPFS re-opened as drive-by in POD-374 | D2 + POD-374 AC: adapter matches this ADR exactly. |
| Drizzle sneaks into mobile "for consistency" | D5.1 explicit; POD-375 drift comment resolved by this ADR. |
| Daemon binding store invents a third ad-hoc JSON layout with no version | D5.2 requires schema_version + migrations + tests. |
| Torn writes pass unit tests but fail on device kill | Conformance + real lifecycle tests on POD-374/375 ACs. |
| Legacy clients stuck after upgrade | D6 upgrade-or-rebootstrap; never dual-write forever. |

---

## Compliance checklist (for implementers and reviewers)

A change is **in compliance** with this ADR when:

- [ ] Web durable replica path is IndexedDB with multi-store (or equivalent) transactions.
- [ ] Mobile durable replica path is SQLite with SQL transactions.
- [ ] localStorage/AsyncStorage hold only prefs or are unused for replica state.
- [ ] Entity + cursor + outbox (+ overlay) mutations that the kernel issues together
      commit atomically (D4.1).
- [ ] Quota failure surfaces degradation and uses in-memory only — not localStorage.
- [ ] Corrupt store cold-starts; boot never wedges.
- [ ] Mobile/web schema versions are adapter-local and not wired to drizzle journals.
- [ ] Daemon binding store (when implemented) is versioned and not drizzle-kit unless
      a future ADR revisits D5.2.
- [ ] Legacy localStorage replica migrates or re-bootstraps once (D6).
- [ ] Conformance or adapter tests cover kill-between-writes and quota-full.

A change is **out of compliance** when it:

- Treats OPFS/SQLite-wasm as the web default without meeting D2's reversal condition.
- Persists outbox or cursor only in localStorage/AsyncStorage on the happy path.
- Applies cursor, entities, or outbox in separate non-transactional writes on the
  durable path.
- Runs drizzle-kit as the migration engine for client replica DBs.
- Couples client or daemon store schema_version to the server `__drizzle_migrations`
  table or journal.

---

## Status and sign-off

| Stage | Owner |
|---|---|
| Proposed | POD-752 (this document) |
| Pack reconciliation + index | POD-359 |
| Human sign-off | POD-359 human gate (frontmatter → Accepted) |

### OPFS spike record

| Item | Result |
|---|---|
| Spike run as part of POD-752? | **No** |
| Threshold evidence for OPFS? | **None recorded** |
| ADR outcome | IndexedDB default; OPFS not adopted (D2) |
