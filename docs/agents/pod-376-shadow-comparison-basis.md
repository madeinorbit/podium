# POD-376 — the shadow-comparison basis

**Written before the harness, deliberately.** The brief's instruction is that the comparison basis
must be defined first, because under the 2026-07-29 decision (private by default, per-principal
feed) the two paths may legitimately hold **different sets of rows**, and a naive snapshot diff
reports correct scoping as divergence. This document is the definition the harness implements; if
the harness and this document ever disagree, the harness is wrong.

---

## 1. What the two paths actually are, as of this branch

This is not a guess — it is what POD-1203 left in the tree, and it changes the design of the
comparison materially.

| | LEGACY path (outgoing) | KERNEL path (incoming) |
|---|---|---|
| Client state | `packages/client-core/src/replica/replica.ts` — TanStack DB collections | `packages/sync` `Replica` + `Outbox` over `adapters/indexeddb` |
| Wire version | 1 (`hello` sends no `wireVersion`; absence *is* the advertisement) | 2 (`hello` sends `wireVersion: 2`) |
| Server frames | `sessionsChanged` / `issuesChanged` / `metadataDelta` / … | `feedBootstrap` / `feedDelta` / `feedRescope` / `feedResyncRequired` |
| Server source | **the same Authority feed**, folded up by `LegacyWireV1Adapter` | the same Authority feed, unfolded |

The last row is the important one. Before POD-1203 there were two serving paths that could disagree.
There are not any more: `apps/server/src/gateway/wire-feed-edge.ts` states it plainly — *"a
translation of one pipeline is not a second pipeline: it cannot disagree with the feed, because it is
the feed folded up."*

**Consequence for this issue.** The shadow comparison is no longer "do two server pipelines agree".
It is: **given the one scoped feed, do the two CLIENT paths end up holding the same slice?** The
divergence surface is client-side — frame acceptance, apply order, the remove/evict distinction, the
cursor rule, persistence — which is exactly the surface a cutover puts at risk.

---

## 2. The comparison basis

### 2.1 One principal, three snapshots

A comparison is only ever made **within one principal's slice**. The harness takes three snapshots at
one moment and compares them pairwise:

| Snapshot | Source | What it is |
|---|---|---|
| `K` | kernel `Replica.entities()` | what the kernel path holds |
| `L` | legacy replica's collections | what the TanStack path holds |
| `A` | `sync.feedSlice` → `authority.bootstrap(principal)` | **what the Authority says this principal's slice contains** |

`A` is not a fourth opinion. It is `AuthorityPort.bootstrap`, the same call `FeedServing.serveWorld`
makes to build a `feedBootstrap`, evaluated through the same `FeedVisibilityPolicy` object. There is
one answer to "may this principal see this row" in this system and `A` is it.

A snapshot is a set of `(entity, entityId)` keys with each key's `revision` and a stable content
digest. Provenance (`originId`, `causationId`, `mutationId`) is **excluded** from the digest: ADR 2
D8 puts it on the envelope precisely so byte-equality dedup does not fire on provenance churn, and
the two paths legitimately carry different provenance for the same row.

### 2.2 The classification rule

Every key in `K ∪ L ∪ A` is classified. This is the whole gate, and it is written as a total
function so that "unclassified" is a reachable, failing outcome rather than a gap:

| Class | Condition | Verdict |
|---|---|---|
| `agree` | in `K`, in `L`, in `A`, digests equal | pass |
| `scoped-out` | in `L`, **not** in `K`, **not** in `A` | **expected difference** — the row is not in this principal's slice and the kernel path correctly does not hold it |
| `kernel-leak` | in `K`, **not** in `A` | **DIVERGENCE** — the kernel path holds a row the Authority says is outside the slice |
| `legacy-leak` | in `L`, **not** in `A`, and `A` is a *scoped* slice | **DIVERGENCE** — the off-flag path is showing what it may not see (see §3) |
| `kernel-missing` | in `A`, **not** in `K` | **DIVERGENCE** — the kernel path lost a row it is entitled to |
| `content-drift` | in both, digests differ | **DIVERGENCE** |
| `revision-drift` | in both, revisions differ | **DIVERGENCE** |
| `unclassified` | anything the rows above do not cover | **DIVERGENCE**, and reported as a hole in this table |

**The rule that makes this not a rubber stamp.** `scoped-out` requires the row to be absent from `A`
— that is, it requires the Authority to *affirm* the row is outside the slice. A blanket "absent from
the kernel path is fine" rule would classify `kernel-missing` (a real data-loss bug) as an expected
scoping difference, which is precisely the class of bug this issue exists to catch. The harness never
suppresses an absence; it attributes it, and an absence it cannot attribute to `A` fails the gate.

### 2.3 Two things the comparison deliberately does NOT do

- **It does not compare in-flight optimistic state.** The optimistic overlay is derived, never
  persisted (ADR 4 D7), and the two paths derive it from different outboxes. The snapshot is the
  authoritative base — `Replica.entities()`, not `Replica.view()`. Optimistic behaviour is covered by
  the grace-window case in the matrix instead, as behaviour rather than as a snapshot diff.
- **It does not compare while either path is mid-install.** A snapshot taken during a bootstrap walk
  compares a half-installed slice against a whole one and reports noise. The harness samples only when
  the kernel replica's posture is `live` or `stale` and the legacy path is not healing; a sample that
  cannot reach a quiescent point within its budget is reported as `could-not-sample`, which is a
  *failure to gate*, not a pass.

---

## 3. The flag is not a visibility bypass — and how that is enforced in code

The brief requires a decision here, written down, and enforced in code rather than by convention.

**The decision: option (a) — the legacy path is fed the same scoped feed — with a hard backstop,
because option (a) alone is not sufficient on this tree.**

Why (a) is the right frame: since POD-1203, `LegacyWireV1Adapter` builds its full-list messages *from
the feed*. A v1 peer is therefore already scoped — it receives the folded-up form of exactly the rows
the Authority evaluated for its principal. The off-flag path is not an unscoped stream and never
reaches one.

Why (a) alone is not sufficient: **the v1 adapter cannot express `evict`.** It refuses the frame and
`WireFeedEdge.publishTo` drops the peer. That is fail-closed and correct, but it means that against
an authority that can actually revoke, the off-flag path is not a working fallback — it is a path
that dies on the first revoke, having already rendered the row. Leaving that as "it fails safely" is
the shape this run keeps paying for: a refusal that is technically present and practically never the
thing anyone relies on.

**So the enforcement is a positive gate, at the two places that can hold it:**

1. **Server-side, load-bearing.** The feed edge learns the *scoping grade* of the installed policy —
   `device-unscoped` (today's `DeviceGradeUnscopedPolicy`) or `per-principal`. Against a
   `per-principal` authority, admitting a peer at a wire version whose adapter cannot express `evict`
   is refused at `attach`/`renegotiate` with the existing 426 `upgrade-required`, before any world is
   served. The peer never receives a row, rather than receiving rows and being dropped on the first
   revoke.
2. **Client-side, so the failure is legible.** The flag resolver takes the grade the server
   advertises in its handshake. `off` against a `per-principal` grade is not honoured and not
   silently upgraded either: it resolves to `kernel` and records a `flag-overridden` reason the UI
   can surface. A flag that quietly means something other than what it says is its own defect.

The grade is derived from the policy object actually installed at the composition root, not from a
config string that could drift from it.

---

## 4. The divergence matrix

Driven by POD-1077's mechanism plus a **stub policy**. Sharing policy and the share/unshare commands
are Phase 3 (POD-290) and are not implemented here; the stub is a `FeedVisibilityPolicy` whose
grant set is settable by the test, which is exactly the seam `visibility.ts` documents ("a test can
supply a deny-all or an allow-all to prove the filter is load-bearing").

| # | Case | What must hold |
|---|---|---|
| 1 | cold start, empty store | kernel paints from nothing, bootstraps, `K == A`; no divergence |
| 2 | cold start, populated store | **paint precedes the network** — the first render reads the persisted slice; cursor-after-data holds across the restart |
| 3 | steady-state deltas | every frame applied in seq order; `K == L == A` after each |
| 4 | **grant mid-session** | a row becomes visible to a *live* replica; it arrives as a re-admitting `upsert` at the causing seq, `fromSeq` is contiguous with the cursor, and no heal fires |
| 5 | **revoke mid-session** | the row leaves the view as `evict`. `Replica.exitKind()` is `evicted`, **not** `removed`; no domain deletion event; no tombstone. Classified `scoped-out` against `A`, not as divergence |
| 6 | **watermark-only stretch** | 200 consecutive frames with `changes: []` and an advancing `seq`. The cursor advances, `stats().heals` does **not** move, `pendingGaps` stays 0, and the rendered slice is byte-identical before and after |
| 7 | **scoped re-bootstrap with the grace window open** | a `rescope` arrives while an optimistic spawn's grace window is open. The cache is discarded and re-bootstrapped; **the outbox survives** (ADR 2 D7's keep-the-outbox rule, structurally guaranteed by `ReplicaCacheStore` having no outbox method); the optimistic row stays rendered until the grace window closes or the real row arrives |
| 8 | offline write → reconnect → drain | queued while offline, drained on reconnect, converged; the outbox entry retires in the same commit as the frame that confirms it |

Cases 4–7 are the ones the brief names. Each is asserted to **fail when the property it guards is
broken** — the ledger's recurring defect class is instruments that cannot say NO — and the handoff
records how each was proved able to fail.

---

## 4a. What the live runs actually found (added after the fact)

Three defects survived design, review and a green unit matrix, and were only produced by running the
consumer against a booted server. Recording them here because each one is a general shape, not a
typo:

1. **The bootstrap source deadlocked on a *synchronous* push.** It asked for a world before
   registering its waiter, so a caller that pushed synchronously — every harness; not a real socket —
   had the world parked in the slot with nobody waiting. Reachable only from the fast path.
2. **A re-bootstrap killed the very walk that requested it.** A re-bootstrap asks the transport for a
   fresh world; the transport supplies one by *reconnecting*; the reconnect's socket-close was read as
   "abandon the walk". The Replica then retried, asked again, and looped until `settled()` gave up
   with *"the ladder is not resolving downward"*. A self-inflicted close and a real drop had to become
   two cases. The sink also had to stop re-entering `Replica.connect()` while a walk is in flight.
3. **The v2 catch-up reply was built with the v1 row mapper.** `toBusChange` emits `id`; the v2 row's
   field is `entityId`. Every *healed* row therefore installed as `entity:undefined` — a silent
   corruption on the rung-1 path, invisible to anything that only exercised the push path.

The common thread: all three live on the rare path (reconnect, re-bootstrap, heal), which is exactly
where a cutover's risk is and exactly what a happy-path suite cannot see.

## 5. What this issue can and cannot evidence

`CLIENT_PRINCIPAL_GRADE` is still `device`: `packages/runtime/src/auth-store.ts` is one shared
password, and two connections presenting it are indistinguishable **as persons**. The brief's
second-account runtime check — "a private row of user A never appears on user B's client" — therefore
cannot be evidenced against the shipped authenticator, because the shipped authenticator cannot name
two users. Claiming it from a fixture would be exactly the fixture-certifying-itself shape POD-1077
called out.

What is evidenced, in three separate claims that must not be run together:

1. **Shipped and verified against a live server** (`tests/e2e/feed-v2.e2e.test.ts`): a real socket
   announcing wire v2, the shipped client consumer, a real kernel Replica over a real IndexedDB
   store. A v2 peer is served feed frames and installs exactly the authority slice; a live write
   arrives as a delta; and offline → world moves → reconnect → **both clients converge on the
   authority slice** (compared against `sync.feedSlice`, not merely against each other — two clients
   agreeing on the wrong answer is not convergence). Verified to fail: deleting the `wireVersion`
   advertisement makes the server serve v1 and all three feed cases time out.
2. **Shipped against the mechanism, with a stub policy** (`divergence-matrix.test.ts`): grant,
   revoke-as-eviction with a real deletion beside it as the counterfactual, a 200-frame watermark
   stretch, and a scoped re-bootstrap with the outbox surviving. This proves the mechanism carries
   the remove/evict distinction end to end; it does not prove per-person isolation.
3. **NOT evidenced, and not claimed:**
   - **The real UI.** The engine swap that would put this consumer behind the app's read model needs
     a store-neutral client `Replica` facade over `{cache, outbox}`. POD-377 claimed and owns that
     file (`packages/client-core/src/replica/`), so it is not on this branch. Everything up to and
     including the wire is verified on the real stack; the last hop into the rendered UI is not.
   - **The second-account check.** Blocked on per-user login, and recorded as blocked rather than as
     a passing box.
