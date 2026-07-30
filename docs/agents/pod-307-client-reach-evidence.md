# POD-307 — making the kernel reachable, and D6's key inventory: what was measured

Companion to `docs/agents/pod-374-storage-evidence.md` and
`docs/agents/pod-375-storage-evidence.md`, written to the same rule: everything
here is a measurement taken on this branch or a decision with its source named.

---

## 1. The decision POD-1195 was blocked on

Both adapters shipped and neither was reachable. Measured on this branch before
changing anything, with a probe file in `apps/web` importing `@podium/sync`:

```
[manifest-platform] apps/web/src/__manifest_probe.ts: browser-safe apps/web
imports node-only packages/sync via '@podium/sync' — a browser bundle would
inline Node code
```

**Chosen: retag `packages/sync` `neutral`.** Not a package split.

| Option POD-1195 listed | Verdict | Why |
|---|---|---|
| (a) retag `neutral` + subpath discipline | **TAKEN** | `packages/runtime` and `packages/telemetry` are the standing precedent *in the same file*, for the same reason: a workspace with a browser-safe surface and node-only concerns behind their own subpaths. One bit cannot say both. |
| (b) split out a browser-safe package | rejected | ADR 8 D4's today→target table says `packages/sync` → `packages/sync` (Authority/Replica/Outbox), "**reshape in place**", and its end-state layer map lists no browser-side sibling. A split also cuts the conformance suite, which ADR 6 D3 requires to stay ONE suite parameterized by instantiation. |
| (c) re-export through client-core | rejected | Hides a node-only edge behind a browser-safe workspace — the same false classification, one layer down. |

**The tag was never true of this workspace.** The Replica and Outbox roles name
no technology at all (check-boundaries rule 11 already enforces it), and ADR 6 D1
puts the browser's and the phone's storage adapters in this package beside the
SQLite one. `node-only` falsely accused `adapters/indexeddb`, which exists to run
in a browser and can run nowhere else.

### Blast radius, enumerated

The platform rule constrains exactly one direction: `browser-safe → node-only`.
So the whole matrix change is that the **10 browser-safe workspaces may now reach
`packages/sync`** — and rule 12 immediately re-narrows that to six declared
entrypoints. Outgoing edges from a node-only and from a neutral workspace are
equally unconstrained; layer, same-layer and feature ownership are untouched.

### The retag is a classification change

The commit that flips the tag (`refactor(manifest): packages/sync is NEUTRAL`)
touches `scripts/` only. The product-side surface it needs — five `exports`
subpaths and two adapter barrels — landed in the commit *before* it, as pure
additions with no consumer. The POD-305 pattern: the classification changed, not
the code.

---

## 2. The guard, and why there are two of them

`neutral` is UNCONSTRAINED by the platform rule, so the retag alone would let
`apps/web` import the bare barrel — which value-exports the Authority, the
Ledger, `mirror.ts` and the SQLite repository. That would trade a false
accusation for a real one, so the guard lands in the same commit.

| instrument | what it sees | what it is BLIND to |
|---|---|---|
| **rule 12a** (`sync-browser-reach`, manifest family) | a browser-safe workspace importing anything but a declared entrypoint | whether the declared entrypoint is actually clean |
| **rule 12b**, transitive closure over source text | every relative and workspace edge, at any depth, with no install needed | npm — it checks bare specifiers against a short explicit list |
| **`scripts/audit-browser-reach.ts`**, a real browser-target bundler | the whole npm graph, resolved through the real `exports` maps | a module tree-shaken out today and reachable after one edit; needs an install |

Rule 12b is a full closure rather than rule 8b's one hop, and the difference is
load-bearing: 12a alone is satisfied by an entrypoint that re-exports
`authority/index`, and a declaration list nobody verifies is the
mechanism-present / coverage-absent shape.

### The measurement that shaped the bundler instrument

`bun build --target=browser` **does not fail on a Node builtin.** It substitutes
an empty object:

```js
var {readFileSync} = (() => ({}));
```

Build succeeds, exit code 0, and no `node:` string survives in the bundle to grep
for — the client crashes at runtime instead. An audit written as "bundle it and
check the exit code" would have been green against exactly the defect it exists
for. The refusal is possible only because a resolver plugin reports the specifier
*and* the importer.

### Every refusing arm probed

One mutant per call, each verified applied (match-count 1, hash changed, sole
dirty file) and reverted.

| probe | result |
|---|---|
| bare barrel from `apps/web` | refused (12a) |
| undeclared subpath from `apps/web` | refused (12a) |
| `node:fs` one hop into `replica/` | refused (12b) |
| `node:fs` three hops down (fixture) | refused (12b) — the case rule 8b cannot see |
| `bun:sqlite` / `@podium/runtime/sqlite` | refused (12b) |
| an unresolvable import | refused as a TRUNCATED closure |
| a missing entrypoint file | refused as vacuously green |
| a declared entrypoint, real repo | **SILENT** — the control |

The last row is the one that matters most. A rule that refused everything would
"prove" browser-safety by making the adapters unreachable again, which is the
state this issue exists to end.

### The non-vacuity floor had to be measured, not guessed

`audit-browser-reach` first required "at least two modules loaded".
`@podium/sync/span` legitimately has no imports at all, so a **correct** file
failed — and a floor a correct tree cannot meet gets lowered until it means
nothing. The floor is now derived from the entrypoint's own count of distinct
relative specifiers.

---

## 3. ADR 6 D6 — the key inventory, measured against the writer

POD-374's reason for skipping this is the one honoured: *"an importer built
against a guessed key set is mechanism-present / coverage-absent."*

`packages/client-core/src/replica/legacy-keys.test.ts` drives the REAL legacy
writer — `createReplica`, the TanStack replica still shipping — over an
observable storage seam and asserts in BOTH directions that the keys it produces
are the keys the importer looks for. The list lives in `packages/sync` (with the
importer); the proof lives in `client-core` (with the writer), because L2 may not
import L3. Drift is therefore a red test, not silence.

**The measurement paid for itself twice while being written:**

1. `applySnapshot(kind, [])` writes **no key at all**, so the first exercise
   certified an inventory against four collections that were never persisted.
2. The cursor write is **fenced** behind the entity writes (the cursor-after-data
   invariant), so reading the key set synchronously measured an inventory with no
   cursor in it.

Both were caught by assertions that name each key instead of counting them.

### The inventory

| key | class | migration |
|---|---|---|
| `podium.replica.{sessions,issues,conversations,automations,automationRuns,transcripts}.v1` | replica state | discarded, key retired |
| `podium.replica.cursor.v1` | replica state | **always** discarded, retired, and REPORTED |
| `podium.replica.outbox.v1` | replica state | **imported** |
| `podium.replica.outbox-awaiting.v1` | replica state | **imported**, as `accepted` |
| `podium.outbox.v1` (pre-replica blob) | replica state | **imported** |
| `podium.replica.uistate.v1` | **preference** (ADR 6 D7) | left in place |

### What is imported, and what is not

- **OUTBOX — imported.** ADR 6 D4.3: losing user intent the Authority has not
  accepted is "a correctness bug, not degraded UX". It is also the only family
  that cannot be re-fetched.
- **CURSOR — always discarded.** The legacy cursor is a bare integer; the
  kernel's is `{feedId, epoch, seq}`, and ADR 2 D1 says a cursor without feed
  identity is meaningless and "never a bare integer". A fabricated epoch is worse
  than no cursor — it makes a stale replica look current. Discarding costs one
  bootstrap and is D4.2's SAFE direction, and it satisfies D6 clause 4
  structurally: there is no cursor to half-migrate.
- **ENTITIES + TRANSCRIPT WINDOWS — discarded.** `EntityRecord.provenance.seq` is
  required and unrecoverable from a legacy row, and with no cursor the bootstrap
  re-fetches them anyway. ADR 6 D7 calls this data a cache.
- **UI PREFERENCES — left alone.** The ownership predicate is a list-membership
  test, not a prefix match: a prefix sweep would delete the user's layout on
  upgrade.

### Two things the importer refuses to invent

A legacy entry carries a bare `kind` and **no contract version**, and ADR 3 D9
stores the version so a replay is judged against the version the user authored
under — so the caller resolves it, and an unresolvable kind is **reported** as
undeliverable rather than replayed under a guess. It also carries **no identity**,
while ADR 3 D17 requires both halves of the attribution pair to come from the
authenticated transport.

**One partition for the whole import.** ADR 3 D12's `partitionKey` is computed by
the contract's target extractor from data a legacy entry does not carry.
Splitting by `mutationId` would lose the ordering between two edits of one row —
what the legacy `chained` flag existed to track. Over-serialising a one-time
drain costs nothing; under-serialising corrupts a rename.

**The plan is returned, never applied.** D6 clause 3's "delete legacy keys only
after a successful durable commit" is a property of the signature: the module
cannot delete at all.

### Mutation evidence

Three mutants, one per call, each verified applied, **compiling** (`tsgo` exit 0)
and reverted to the original hash.

| # | mutant | result |
|---|---|---|
| M1 | fabricate `{version: 1}` instead of refusing an unknown command | **KILLED** — exactly 2: the unit refusal and the real-writer round trip |
| M2 | map awaiting-truth to `queued` (re-sends an accepted mutation) | **KILLED** — exactly 1: the case that names the mapping |
| M3 | retire legacy keys only when something was imported | **KILLED** — 5: every case asserting D6 clause 4's never-stuck posture |

M1's and M2's narrow blast radius is the correct outcome when one arm depends on
the mechanism; M3's breadth says the opposite thing correctly — never-stuck is
not a local property.

---

## 4. The conformance finding, honoured rather than repeated

POD-374 and POD-375 measured independently, on two engines, that the 30-case
conformance suite stays GREEN under the ADR 2 D10 non-compliance, because
`failNextCommit` fires before the adapter's native transaction opens.

**Nothing in this branch leans on conformance.** No claim here is "the adapters
work"; the claims are that browser-safe workspaces can now reach them, that the
reach is guarded by two instruments with different blind spots, and that the D6
inventory matches the writer. The suite was neither edited nor cited.

---

## 5. Deliberately NOT done

**The client cutovers.** POD-376 (web, behind a flag + shadow comparison),
POD-377 (mobile + migration) and POD-378 (delete TanStack DB + the
present-to-absent delete-tracking regression + audit to zero) are this issue's
open children and own that work. They were blocked on the decision in §1 and are
not any more.

**A production caller for the D6 importer.** It is wired nowhere; ADR 6 D6 puts
the call in the adapter's `open()`, which is POD-376/377's diff, and they are the
issues that can verify a drain against a running stack. The warning POD-374 gave
was against an importer built on a GUESSED key set — this one is built on a
measured one, with fixtures produced by the real writer.

**Any OPFS re-evaluation.** ADR 6 D2's reversal condition is unmet and this issue
produced no evidence for it.
