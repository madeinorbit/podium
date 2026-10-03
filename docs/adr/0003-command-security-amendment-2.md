# ADR 3 — Amendment 2: a definitive answer releases the partition

- **Status:** Accepted — signed by the operator, 2026-10-03 (relayed by POD-4286). The
  direction was decided by the operator on 2026-10-03 (pinned comment on POD-5426); this text
  is the written form that decision asked for.
- **Date:** 2026-10-03
- **Issue:** POD-5430 (step 1 of `docs/plans/pod-4286-optimism-and-refusals.md`, the POD-5426
  spec). Fixes POD-5415.
- **Amends:** D12 (its last sentence). D9, D10, D11 and D13 are unchanged.
- **File discipline:** this file, one "Amended by" line and a pointer under D12 in
  `docs/adr/0003-command-security.md`, and the D12 row of the conformance table in
  `docs/design/outbox-lifecycle-state-machine.md`.

---

## 1. Context

D12 ends: "A blocked / dead-lettered entry blocks **only its partition** until recovery or
cancel." D10 says, for validation poison: "Dead-letter (same as rejection); **never wedge the
partition**." The two sentences disagree. The kernel followed D12: a parked entry stopped every
later entry in its partition until the user retried or discarded it. POD-4762 then carved out
an exception for chat sends (`OUTBOX_PARKED_YIELDS_PARTITION`), because a failed message must
not hold the next one.

POD-5415 shows the cost for everything else. On the phone (POD-4978's queue audit, run on
`ccce76d346`), a refused rename parked at 15:26:36. The read receipt from opening the mission
(15:26:36.327) and the next rename (15:26:43.222) were still `queued`, attempts 0, at 15:26:48.
The banner read "1 change needing review and 2 queued". Only the user's retry or discard of the
first rename could release them.

Sync systems that do this well do not hold on a refusal. Replicache: the server must mark an
invalid mutation as processed, or "the client retries endlessly and becomes blocked"; only a
*temporary* error holds later mutations. Linear: a rejected transaction rolls back and leaves
the queue; later transactions are not held. Both re-apply pending changes on the accepted
state, and the server, not the client, judges whether a later change still makes sense.

## 2. Decision

### D23 — An entry holds its partition only while its outcome is unknown

Replaces D12's last sentence. The rest of D12 (FIFO within a partition, concurrent across
partitions, the partition key rules) stands.

1. **Hold while unknown.** An entry holds the entries behind it in its partition only while its
   outcome is unknown: `sending`, `accepted` (taken by the Authority, not yet applied), or
   `queued` (its turn, or backing off after a transient failure per D10).
2. **Release on a definitive outcome.** `applied`, `rejected`, `expired`, `dead-letter` and
   `cancelled` release the partition at once, for **every** command. There is no per-command
   list; POD-4762's chat-only exception becomes the rule and its list is deleted.
3. **Recovery goes to the back.** A retry (D9 invariant 3) is a new act by the user at the time
   of recovery. It moves the entry to the back of its partition, behind everything already
   queued, in the same durable write as its transition, and the order survives a reload. An
   edit already mints a new record at the back (D11.4). Whether a retry keeps its id is
   unchanged (D11.4 as amended by POD-4762).
4. **A release starts a drain.** A transition that releases a partition outside a drain pass
   (a user's discard, an expiry sweep) starts a drain, so what waited behind it does not wait
   for an unrelated trigger.
5. **The parked record is unchanged.** Refusal still parks authored input verbatim for recovery
   (D9 invariant 2), and the recovery affordances still come from the reason code alone. Only
   its effect on the queue changes.

### Why releasing is safe

Ordering exists so that two of the user's intents on one thing land in the order the user made
them.

- A **refused** entry will never land in its original position: a retry goes to the back
  (D23.3). So letting the next entry go cannot reorder anything that will actually land.
- An **expired** entry may have landed with only its answer lost (D11). Sending the next entry
  after it keeps the user's order either way.
- A **retry after a newer change landed** wins, because the retry is what the user did last.
  This is the intended result, the same as Replicache's and Linear's. The recovery surface
  cannot show the current value instead, because it never reads the target
  (`docs/design/outbox-dead-letter-recovery.md` §3).
- A **later change that no longer makes sense** after an earlier refusal is refused by the
  server on its own merits, with a typed code (POD-5429: every precondition refusal is a 409 or
  412, never a 500), and D23.2 releases it in turn. The client never guesses dependencies.

`accepted` keeps holding: the Authority has the envelope and may still refuse it at apply time
(D16.4), so its outcome is unknown.

## 3. Consequences

- POD-5415's sequence: the refused rename parks; the read receipt and the second rename send at
  once. The banner reads "1 change needing review" with nothing queued behind it. The refused
  rename's text stays recoverable.
- D10 and D12 no longer disagree: "never wedge the partition" now holds for parked entries too.
- Deleted: `OUTBOX_PARKED_YIELDS_PARTITION` (client-core wiring), the kernel's
  `parkedYieldsPartition` port field and its `yieldsWhenParked` check.
- The store port gains one stated obligation, pinned per adapter by `store-fidelity.ts`: a
  remove and a put of the same id in one mutation move that record to the end.
- The compatibility queue (`client-core/src/outbox.ts`, used only when no kernel queue is
  injected) already behaved this way: a refused entry leaves the queue and a retry is appended.
- The D12 row of the conformance table now reads: a parked head blocks nothing; a backing-off
  or in-flight head blocks its partition; a retried entry drains after every entry queued before
  the retry.

## 4. Rejected

| Alternative | Why |
|---|---|
| Keep D12 and widen the per-command yield list | Two rules for one queue; every new command has to be classified, and a missed one wedges silently. |
| Release the partition but keep a retry in place | Under release, entries written after the refusal and before the retry (offline) would land before it, and the older intent would overwrite the newer one. |
| Have the client hold dependants of a refused entry | The client would be guessing dependencies the server already judges; the server refuses a change that no longer makes sense (POD-5429). |
| Release on `accepted` too | Its outcome is still unknown: apply-time re-authorization may refuse it. |
