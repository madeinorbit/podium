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
- **The confirmation field name** on the contract envelope is POD-311's; that a confirmation
  rides the envelope and must be durable with the entry is already decided (D8 outcome 3).
- **Any replica→outbox notification.** POD-369 (Replica) owns the `RebootstrapCause` union and
  the `bootstrap-installed` event. This module deliberately has no port for it: an earlier draft
  offered a contractual no-op `noteReplicaRebootstrapped(cause)`, and POD-369's objection was
  correct — a no-op whose subject is the queue is one edit away from data loss on the *normal*
  path, since a rescope fires whenever anyone's shares change. Nor does the outbox need to react:
  re-evaluating a stale `expectedRevision` against newly installed truth would be the replica
  arbitrating, which D7 forbids. If telemetry ever wants the signal, the outbox subscribes to the
  replica's event — the dependency edge points outbox → replica, never the reverse.
