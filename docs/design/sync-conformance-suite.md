# The cross-hop sync conformance suite

**Owner:** POD-373 (Phase 2 / POD-289) · **Code:** `packages/sync/src/conformance/`

One suite, parameterized by **instantiation**, so every hop of the sync kernel runs it
unchanged. It is also where Phase 2's **multi-user gate conditions** live: the human
decision of 2026-07-29 (`docs/multi-user-readiness.md` header) made the visibility
machinery load-bearing from day one, so coverage for it is a gate, not a follow-up.

## How a hop plugs in

Three lines. Nothing in `suite.ts` may be edited to admit a hop, and nothing in it may
assume the in-memory instantiation.

```ts
import { describeSyncConformance } from '@podium/sync'
import { indexedDbInstantiation } from './conformance-instantiation'

describeSyncConformance(indexedDbInstantiation)
```

A hop supplies **storage only** — never the kernels. If a hop supplied the kernels, each
hop could pass "the same suite" while running different kernel code. ADR 6 D3 says there
is one storage port with platform adapters behind it, so the adapters vary and the kernel
does not.

### What `SyncInstantiation` owes

| Member | Why the suite needs it |
|---|---|
| `viewFor(principal)` → `{ cache, outbox }` | Two principal-bound views over ONE physical store (ADR 6 D4.1 + Amendment 1 D15.3). Half the scoped cases cannot be expressed with one principal, and a second principal is not a second store. |
| `unitOfWork` | ADR 2 D10's transaction boundary. Must be a REAL transaction: a per-write fallback here is the D10 non-compliance, not a simplification. |
| `setWritesDenied(denied)` | ADR 6 D4.4 quota denial. Reversible, so a case can prove work SURVIVED rather than only that the denial was reported. |
| `setCorrupt(corrupt)` | ADR 6 D4.5 / D7 rung 5. Must reach EVERY principal's view. |
| `failNextCommit(error?)` | The D10 crash window exactly: after every participant enrolled, before the shared commit. One-shot. **A separate injector from `setWritesDenied` on purpose** — a denial refuses before enrolment, so nothing staged; this fails in the only window a torn commit is possible in. A hop that implements only the first reports the crash case green while never opening the window. |
| `unitOfWorkTransactions()` / `outboxWrites()` / `cacheWrites()` | Three precise counters rather than one aggregate. An aggregate would have to decide whether a span enrolling two regions is one publication or two, and either answer is wrong for one of the assertions that needs it. |
| `cacheOperations()` | The operation kinds that CROSS the port, in order. See "the survivor" below — this exists because a mutation proved the model-level assertions were not enough. |

There is no skip hook, no capability flag and no per-hop tolerance. A hop that cannot
satisfy a case fails it.

## The gate conditions

25 ids, held as data in `gates.ts`. `assertGatesCovered` runs in `afterAll` and fails the
suite when a gate has no test. Ids are stable strings, so renaming a test cannot silently
un-register a gate. `gates.test.ts` proves the ledger can say **NO** (and names the
missing gate) before its silence is believed, and that ledgers are per-instantiation so
one hop cannot borrow another's coverage.

### Base — the ladder, the queue, the normal path (9)

`disconnect-stale-visible` · `gap-heals` · `bootstrap-chunked` · `cold-start` ·
`offline-writes-drain` · `duplicate-delivery` · `rejection-dead-letter` ·
`crash-between-writes` · `quota-exhaustion`

### The four the ADRs assign by name (4)

| Gate | The property, stated sharply |
|---|---|
| `restore-then-stale-client` | Detected by feed **identity**, not by seq — a restore re-issues the same seqs, which is why D1 compares by equality only. Counterfactual: a same-epoch frame at the same seq IS applied. |
| `reconnect-storm` | Six replicas at once. Nobody starves, overlap is asserted (so "did not starve" is not "ran one at a time"), and chunks **interleave** across principals, so bootstrap does not own the loop. Numbers belong to POD-337; the requirement here is behavioural. |
| `offline-writes-across-epoch-bump` | Each queued write either **drained** or **surfaced**, named individually rather than counted. |
| `slow-consumer-demoted-converges` | Asserts **convergence on content**, not survival or posture. |

### The seven scoped multi-user gates (7)

| Gate | The property |
|---|---|
| `grant-mid-session` | Arrives on a live replica, contiguity intact, no heal. The unaffected principal sees that seq as a watermark — the counterfactual that makes "per-principal" a fact. |
| `revoke-mid-session` | Evicts **without rendering a deletion**, cursor stays contiguous, and `remove` vs `evict` stays distinguishable **at the replica AND at the storage port**. |
| `gap-heal-exact-slice` | Converges on exactly its slice — the **upper bound** is asserted, against an authority that also holds rows this principal must not get. |
| `revoked-offline-with-queued-writes` | ADR 3 D8/D16's apply-time re-authorization **proved, not assumed**: definitive rejection, dead-letter with recovery, the author's input verbatim, attempt count stops. |
| `slow-scoped-replica-converges` | D9's demotion still converges when the resync is scoped, with the upper bound. |
| `crash-with-watermark-in-flight` | D10's one-transaction rule holds, and the recovered replica does not treat the watermarked range as a gap. |
| `rescope-keeps-the-outbox` | Rung 2: discard the cache, re-bootstrap, **keep the outbox** — byte-identical, no retire/cancel/expire event escaping, and the entries still drain afterwards, so "kept" means usable. |

### Cross-cutting (5)

`no-existence-oracle` (equality between the invisible-target path and the nonexistent-id
path, with a third refusal proving the normalizer does not flatten everything) ·
`watermarks-are-not-gaps` · `attribution-survives-every-hop` ·
`two-principals-one-authority` · `no-instance-id`

## Two habits the suite holds to

- **Positive control first.** Every absence assertion is preceded by the same instrument
  reporting a presence: a real tombstone renders as a deletion on the same replica before
  "evict is not a deletion" means anything; a real gap heals before "a watermark-only
  stretch does not"; the no-`instance_id` detector is shown able to say yes.
- **Counterfactual in the fixture.** Any name with *only*, *exactly*, *never* or
  *instead of* has the alternative present and eligible. The agent's scope is asserted
  against a target its **human** can see; "did not retry" is asserted as the count
  stopping, beside a legal write in the same drain that did apply.

## Two things this suite found the hard way

### The all-green probe (POD-1161)

The bootstrap-install half of the D10 crash case passed on its first draft **while
measuring nothing**. The confirming frame sat at the same seq as the snapshot, so it was
correctly dropped as covered, the install owed no retirement, the commit took the
single-region autocommit arm, and the injected failure was never consumed:
`unitOfWorkTransactions()` moved by 0 and `bootstrap()` was called once, not twice. It
agreed with the right answer for none of the right reasons.

The window only opens when the buffered frame is **above** the snapshot point, which
needed a deliberate fixture control (`ConformanceAuthority.pinSnapshotSeq`). The case now
asserts a transaction was opened **before** asserting anything about its outcome — which
is the general rule: a chaos case must prove its fault injector fired.

With the window open, a real defect appeared. `Replica.install` drains `this.buffer`
before its transaction commits, so an aborted attempt consumes the buffered frames and
the retry starts empty. Only the **retirement** is lost — entity truth is re-derived by a
re-bootstrap by construction, which is exactly why it hides — leaving a stuck entry for a
command that demonstrably applied, which later dead-letters with a misleading `max-age`.
Filed as POD-1161; the suite pins today's behaviour so it goes red when fixed, with a
positive control beside it.

## The survivor worth remembering

Mutating the Replica to hand the store `remove` for an eviction **survived** every
assertion in `revoke-mid-session`: `exitKind`, the `evicted` event, the absent `removed`
event, the resulting cache contents. It survived because the public projection reads the
**envelope's** op while the in-memory adapter deletes the row either way — so the two are
indistinguishable downstream of a store that treats them alike.

A durable adapter need not. POD-374/POD-375 may write a tombstone for `remove` and simply
drop the row for `evict`, and a replica handing them the wrong kind would render a revoked
share as a deletion **on device** with every in-memory assertion green. So
`cacheOperations()` exists and the case asserts the kind that crosses the port, in order,
against a real tombstone in the same fixture. Amendment 1 D14.5 needed an assertion at the
port, not only at the projection.

## What this suite found

The D10 seam could not be wired at all. `Replica.commitRegions` opened its own span and
committed it synchronously, while the only route to the real Outbox was the **async**
`retireAllApplied`, so the span had settled before enrolment was attempted. Measured
against both real kernels on the normal path with no crash injected: the enrolment threw,
the outbox record stayed durable and stuck in `applied`, and the cursor advanced past the
frame that confirmed it — the torn state D10 forbids. Filed as POD-1158, fixed in
`326e3173` (the Replica is now a participant in a caller-owned transaction), pinned by
name in `packages/sync/src/unit-of-work-seam.test.ts`.

## Known limits, stated rather than implied

- **"Real adapters alike" is unproven until there is a real adapter.** The seam is
  storage-only and takes nothing in-memory-specific, but no durable adapter exists yet
  (POD-374 IndexedDB, POD-375 mobile SQLite are both blocked). The claim this suite
  supports today is that the parameterization is storage-shaped, not that a durable
  adapter passes it.
- **The policy is a STUB.** This suite exercises the visibility MECHANISM. Phase 3
  (POD-290) owns real share/unshare commands and real policy.
- **Thresholds belong to POD-337.** The reconnect-storm and liveness cases assert
  behaviour, never numbers.
- **`Replica.settled()`'s own 50-drain guard is defeatable by microtask starvation**
  (POD-1140). The suite's own loops carry iteration counters and report cursor, head and
  posture on failure, so a non-terminating ladder reads as a defect rather than taking the
  lane down with zero output. That does not fix `settled()` itself.
