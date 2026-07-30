# Outbox lifecycle state machine (POD-370)

Reviewable summary of the kernel Outbox role landed in `packages/sync/src/outbox/`.
It restates nothing: every row below cites the decision that owns it. ADR 3 D9 is the
**sole owner** of the state vocabulary; ADR 6 D4.3 owns only the durability class and defers
the names to D9; ADR 3 D10 owns the retry/age numbers, which this module therefore takes as
configuration and never defaults.

## The eight states, and the two that end an entry

| State | Meaning | Ends the entry? |
|---|---|---|
| `queued` | Durably enqueued locally; not yet in flight | no |
| `sending` | Drain attempt in flight | no |
| `accepted` | Authority took the envelope for processing (optional hop; collapses into `applied` when atomic) | no |
| `applied` | Authority applied it; receipt recorded | **by retirement, after covering truth** |
| `rejected` | Definitive refusal — validation, policy, conflict | no — always parks |
| `expired` | Aged out before a successful apply | no — always parks |
| `dead-letter` | Parked for user recovery | no — retry / edit / discard |
| `cancelled` | User discarded it | **yes (user action)** |

D9 sets the last four in bold as *terminal*, which means "the delivery attempt is over", not
"no outgoing edge": invariant 2 requires `rejected`/`expired` to continue into `dead-letter`,
and invariant 3 leads out of `dead-letter` again. The only two sinks are `applied` and
`cancelled` — exactly invariant 1's two licences to make user-authored work gone.

## Transition table (`states.ts`, asserted cell-for-cell in `states.test.ts`)

| From | cause → to |
|---|---|
| `queued` | `drain-started` → `sending` · `aged-out` → `expired` · `user-discarded` → `cancelled` |
| `sending` | `transport-failed` → `queued` · `authority-accepted` → `accepted` · `authority-applied` → `applied` · `authority-rejected` → `rejected` · `aged-out` → `expired` |
| `accepted` | `transport-failed` → `queued` · `authority-applied` → `applied` · `authority-rejected` → `rejected` |
| `applied` | — (retires) |
| `rejected` | `parked` → `dead-letter` |
| `expired` | `parked` → `dead-letter` |
| `dead-letter` | `user-retried` → `queued` · `user-discarded` → `cancelled` |
| `cancelled` | — |

An absent cell throws rather than coercing the state: a state machine that silently ignores an
impossible move is how an entry becomes "gone" with nobody deciding it (POD-279 finding 8).

## Reason code → recovery affordance

Derived from the code alone, so two situations sharing a code offer identical affordances.

| Code | Produced by | `retry` requires | Also |
|---|---|---|---|
| `unauthorized` | apply-time re-auth denial, **invisible target, nonexistent target** | `rights-fix` | edit, discard |
| `conflict` | stale `expectedRevision` (D13.3) | `rebase` | edit, discard |
| `invalid` | validation poison | `never` (only an edit can succeed) | edit, discard |
| `confirmation-required` | D8 outcome 3 | `confirmation` | edit, discard |
| `max-age` | D10 expiry | `new-mutation-id` (D11.4) | edit, discard |

`edit` and `discard` are always available — not laziness, but the thing that keeps the
affordance set free of an existence oracle. Withholding a button for one of the three
`unauthorized` situations would leak, after the reason code had been carefully blurred.

## Which invariant is proved where

| Obligation | Test |
|---|---|
| D9 vocabulary is D9's, nothing minted or imported | `states.test.ts` — literal list + a foreign-name guard (`awaiting-truth`, `in-flight`, …) |
| Every state reachable | `states.test.ts` graph walk from `queued` |
| Invariant 1 — only user action or applied retirement ends an entry | `states.test.ts` sink analysis; `retireApplied` refuses any state but `applied` |
| Invariant 2 — `rejected`/`expired` always park, with a renderable reason | `outbox.test.ts` (plus a crash straggler parked on open) |
| Invariant 3 — retry / edit / discard, each with its precondition enforced | `outbox.test.ts` recovery legs, including refusals of mismatched preconditions |
| Invariant 4 — network failure stays `queued`, never `rejected` | `outbox.test.ts`, incl. a thrown transport error and an interrupted send recovered on open |
| ADR 2 D7 — re-bootstrap never drops the outbox | upheld by **absence**: no method takes a rung, epoch, rescope or cache as its subject (asserted over the whole prototype), plus a cold reopen that still drains and a stale `expectedRevision` that surfaces as a rejection |
| The one loud loss | unreadable store: required callback **and** a pre-open event; boot does not wedge |
| Local ack ≠ acceptance ≠ application | three distinct events, with the atomic collapse covered separately |
| Attribution is a pair, from the transport | agent actor + on-behalf-of; a forged payload identity is inert |
| Apply-time re-auth is a modelled rejection, zero automatic retries | revoked-while-offline replay, end to end; distinguishable from `conflict` |
| No existence oracle | invisible target vs nonexistent id: byte-identical dead-letter record and rejection event |
| Dead-letter records are private | per-principal listing; an agent's work belongs to its `onBehalfOf` human |
| Evicted target resolves inside D9's set | rescope re-bootstrap, then refusal at drain |
| Secrets never queued | `online-sensitive` / `online-only` refused before any persistence |
| D12 partitions | FIFO within, concurrent across; a parked head blocks only its own partition, on every later pass |
| Two writers on one physical store | two principal-bound instances opened BEFORE either write both keep their records; interleaved lifecycles preserved; `mutationId` uniqueness enforced across instances; a second tab's write is picked up on the next rebase |
| Several retirements in one span | three retirements, one publication, all three durable; an aborted multi-retirement span rolls every one back and emits nothing; an id already retired in the span cannot be resurrected |
| The batch shape POD-369 submits | two provenance matches commit as **exactly one** enrolled write with entity + cursor present; abort preserves both entries, the OLD entity/cursor and emits no observation; a second batch extends the span draft (bootstrap across two buffered frames); a bad id fails the whole batch before staging |
| Shared span, two principals | both stage keyed mutations in ONE span and both survive; a cross-principal key write is refused with `OutboxInvariantError` |

## Privacy is a binding, not a filter

An `Outbox` instance is bound to ONE authenticated principal (`OutboxConfig.principal`,
supplied by the caller from the transport per ADR 3 D7/D14). Every observation API —
`deadLetters()`, `all()`, `find()`, `pending()` — is scoped to it, and `deadLetters()` takes no
argument at all, so there is no query another principal could phrase to reach this author's work
(private-by-default, readiness §3.1.1). `enqueue` refuses an `attribution.onBehalfOf` that is not
the bound principal, so an instance cannot become a mixed queue whose privacy depends on every
reader filtering correctly. Two principals sharing one physical store get two bound views, each
blind to the other's entries — and, crucially, neither able to DROP them: a foreign entry is not
drained here and not observable here, but it survives, because it is that principal's unsent work.

## One writer, staged before it commits — and writes are RECORD-LEVEL

Every mutation goes through `mutate()`, which serializes against every other mutation, builds a
DRAFT, writes it, and only then adopts it in memory and emits its events. Consequences that are
tested rather than asserted: a quota denial or a closed database leaves memory exactly as it was
(ADR 6 D4.4 — the failing operation does not partially apply), two concurrent `enqueue` calls
cannot commit out of order, and observability never precedes durability (D4.3).

`OutboxStorePort.apply({put, remove}, span?)` is record-level, not a whole-snapshot write, and the
difference is a data-loss bug rather than a taste. A snapshot write means "the store now contains
exactly these records", so any writer holding a stale base silently deletes rows it never knew
about. Review round 2 demonstrated both consequences: two principal-bound instances over one
physical store lost one author's queued work outright, and two retirements enrolled in one span
resurrected the first. Two rebasing rules follow, each with its own regression test:

- **Outside a span, rebase on FRESH truth from the store**, because this instance is not the only
  writer — a second principal-bound instance (which the privacy model explicitly supports) or a
  second browser tab (ADR 6 D4.6). This is also what makes `mutationId` uniqueness global rather
  than per-instance.
- **Inside a span, rebase on the span's own accumulated view**, because an enrolled write has not
  landed yet and a re-read would return the pre-span state. One span keeps one staged view and
  publishes ONCE, on commit; an abort drops it, so nothing is adopted and no event escapes.

**Retirement is submitted as a BATCH.** One certified frame can carry several provenance matches,
and a bootstrap install aggregates matches across every buffered frame it includes, so
`retireAllApplied(ids, span)` produces ONE enrolled write and ONE publication rather than N of
each (agreed with POD-369, who collects and deduplicates on the Replica side and submits one
ordered batch in the same span as the entity operations and the cursor advance). A second batch in
the same span EXTENDS the staged draft. The whole batch is validated before anything is staged, so
a bad id fails the batch rather than half-retiring it. Dropped, rejected or merely buffered frames
retire nothing — that is the Replica's half, and nothing here retires on its own.

**No instance may write another principal's keys.** The delta is checked against ownership before
it can be enrolled, so two principal-bound instances staging into one shared span can only ever
touch disjoint keys — a stronger statement than "does not today", and the reason a shared span is
safe at all.

Only `retireApplied` / `retireAllApplied` take a span: the span exists to cover the Replica's entity write, cursor
advance and the retirement that follows from them. Enqueue, discard, retry and edit are USER
actions and are not part of an entity commit — inside an open span they join it (so they compose
rather than clobber), but `find`/`require` resolve against published state, so an entry created
inside a span is not addressable by id until it commits.

Removals are licensed. A draft diffs the ids it started with against the ids it ends with, and
every id that disappeared must have been removed with one of D9 invariant 1's two licences —
`covering-truth` (an `applied` retirement) or `user-discarded`. Anything else throws
`OutboxInvariantError` before the write. That is the guard a method-name check only approximated:
a future `destroy()`/`flush()`, or a stray `filter` inside a maintenance routine, cannot reach the
store no matter what it is called.

## The ADR 2 D10 transaction seam (agreed with POD-369)

The Replica commits entity + cursor and retires its overlay post-commit; the Outbox retires an
applied entry in its own write. Each is correct alone; the torn window exists only in the JOIN, so
the seam is a shared port that neither kernel owns:

```ts
interface SyncUnitOfWork { transact<T>(body: (span: SyncSpan) => Promise<T>): Promise<T> }
interface SyncSpan {
  onCommit(effect: () => void): void   // publish RAM effects after the durable commit
  onAbort(revert: () => void): void    // revert state that had to mutate eagerly
}
```

Wired by POD-305 / POD-373 — not by either kernel — as
`uow.transact(span => { replica.applyDelta(delta, span); outbox.retireApplied(id, span) })`.

POD-370 proposed it; **POD-369's three amendments were accepted** and are what the shape above
records: (1) enrollment is EXPLICIT — the span is threaded into the participant call and on into
the store write, because wrapping unchanged methods in `transact` does not make their inner store
calls join the native transaction and there is no portable ambient transaction in a browser; both
span parameters are optional, so no existing caller breaks. (2) `onCommit` as well as `onAbort`,
because an observation that escapes to a subscriber before the outer span commits cannot be
un-emitted; participants stage and publish on commit. (3) No silent per-write fallback on the
durable path — one-transaction-per-write IS the D10 non-compliance, so it is legal only as ADR 2's
explicitly surfaced degraded mode, the in-memory adapter implements a real unit of work, and the
span body does local-storage work only (an authority await inside it would let an IndexedDB
transaction auto-close).

It carries no cause, rung, rescope or re-bootstrap parameter and never will: it is not a place to
smuggle back the replica→outbox edge both issues deliberately removed.

**The case POD-373 owes this seam** (outbox half by POD-370, replica half by POD-369): given
durable pre-state entity `E@r0`, cursor `C`, and mutation `M` applied but awaiting covering truth,
receive a certified frame carrying `E@r1` with provenance matching `M` and cursor `C2`. Inject a
failure after either participant's native write is enrolled but before the shared transaction
commits, then recreate both kernels from the store. The only legal recovered snapshots are
`PRE = {E@r0, C, M awaiting}` or `POST = {E@r1, C2, M retired}`; both torn mixes are forbidden, and
on abort no `upserted`, `cursor` or `retired` observation may have escaped. Run it again for a
buffered delta included in an atomic bootstrap install.

## Delivery semantics

**At-least-once**, deduped into effectively-once by the client-minted `mutationId` inside the
Authority's receipt window (D11.7). Exactly-once is not available: a `sending` entry whose reply
was lost is indistinguishable from one that never arrived. Outside the receipt window a replay
would be a *fresh* command (D11.8), which is why expiry — not the Authority — refuses the send.

## Deliberately not decided here

- **D10's numbers and D11's inequality lint** (14d age, ≥2d skew, importing ADR 2's receipt
  constant) belong to POD-371. This module takes `maxAgeMs` as required configuration; a second
  default here would be the drift D11.3 warns about.
- **Retry cadence / backoff** (D10's 1s→60s) is POD-371's. The kernel stops a partition after a
  transport failure and re-attempts on the next drain; it schedules nothing.
- **`UserId`** stays a plain `UserRef` string until POD-1075 lands the model brand (ADR 4
  Amendment 1 D9.1). The actor/on-behalf-of *distinction* is structural regardless.
- **Which existence facts may legitimately leak** is open (ADR 3 amendment §3 O1). The closed
  behavior is implemented; nothing here decides the open question.
- **The confirmation field NAME is provisional and POD-311 owns it.** The SEMANTICS are decided:
  a durable user confirmation for a deliberately out-of-scope write rides the envelope (D8
  outcome 3 / D2), and therefore has to be durable with the entry — an offline out-of-scope write
  that lost its confirmation would be refused at apply. It ships spelled as `confirmed?: true`
  rather than as an opaque token, on the coordinator's ruling: with nothing to carry, the
  `confirmation-required` recovery path would be untestable, and an untestable state in a
  lifecycle is how the earlier attempts left mechanisms half-landed. To keep the rename cheap it
  is declared **once** — `CONFIRMATION_FIELD` plus the `EnvelopeConfirmation` mapped type in
  `records.ts` — and production code reads and writes it only through `confirmationOf` /
  `CONFIRMED`, so POD-311 changes one line. Tests spell the key literally on purpose (pinning the
  wire shape is their job) and one asserts the emitted envelope key *is* `CONFIRMATION_FIELD`, so
  a rename that misses the envelope fails rather than passing quietly.
  Note that `RetrySatisfaction.confirmed` is a different vocabulary — what the user DID in the
  recovery UI — and does not rename with the envelope field.
- **Any replica→outbox notification.** POD-369 (Replica) owns the `RebootstrapCause` union and
  the `bootstrap-installed` event. This module deliberately has no port for it: an earlier draft
  offered a contractual no-op `noteReplicaRebootstrapped(cause)`, and POD-369's objection was
  correct — a no-op whose subject is the queue is one edit away from data loss on the *normal*
  path, since a rescope fires whenever anyone's shares change. Nor does the outbox need to react:
  re-evaluating a stale `expectedRevision` against newly installed truth would be the replica
  arbitrating, which D7 forbids. If telemetry ever wants the signal, the outbox subscribes to the
  replica's event — the dependency edge points outbox → replica, never the reverse.
