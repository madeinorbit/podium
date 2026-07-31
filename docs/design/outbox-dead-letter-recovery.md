# Offline command classes + dead-letter recovery (POD-316)

What landed, what it is verified against, and — the part that matters most for
whoever picks this up — **what this issue's acceptance list asks for that this
tree cannot yet support**.

---

## 1. The defect this issue existed to fix

`packages/client-core/src/outbox.ts` did this on a refused write:

```ts
if (isPoisonError(err)) {
  this.entries.shift()          // ← the work is gone
  this.persist()
  this.init.onPoison?.(entry, err)   // ← a toast saying so
  continue
}
```

That is the **silent poison-drop ADR 3 D9 invariant 1 forbids by name**, and
POD-279 finding 8 calls it the worst gap in the write path. Everything the user
had typed was deleted, and the only recovery was their memory of it.

**There was a second defect underneath it, and it was the more dangerous one.**
`isPoisonError` matched only `BAD_REQUEST`. So the two refusals multi-user makes
*routine* —

- an apply-time re-authorization denial (D8 / amendment D16 — rights revoked
  while offline), and
- a stale-`expectedRevision` conflict (D13.3 — two people on one issue)

— were classified as **transient** and sent to `scheduleRetry()`. They would
retry forever against an Authority guaranteed to refuse them identically, with
their partition wedged behind them and the user's work invisible.

## 2. What now happens

A definitive refusal **parks**. The entry leaves the drain queue (it would refuse
identically forever) and lands in a durable third home, with a reason code and
the author's own input verbatim. The user gets retry / edit / discard.

The reason and recovery vocabulary is **imported from the sync kernel**
(POD-370's `@podium/sync/outbox`), never restated. That is the point: the kernel
is where `unauthorized` is merged with `target-not-found` so the failure surface
carries no existence oracle, and a second copy of that merge on the client is a
second place for it to drift open.

| Authority says | Reason code | Retry needs |
|---|---|---|
| `UNAUTHORIZED` / `FORBIDDEN` / `NOT_FOUND` | `unauthorized` | a rights fix |
| `CONFLICT` | `conflict` | a rebase |
| `PRECONDITION_FAILED` | `confirmation-required` | a durable confirmation |
| `BAD_REQUEST` | `invalid` | nothing — only an edit |
| aged out | `max-age` | a **new** `mutationId` (D11.4) |
| anything unrecognised | *(not a reason)* | stays queued, retries |

That last row is deliberate: an unknown refusal keeps the user's work queued
rather than parking it on a guess.

## 3. The two rules the recovery UI is built on

Both are security properties, not design preferences.

**It never reads the target.** Not its title, not its body, not whether it still
exists. An entry can be parked *because* the author lost visibility of the target
while offline — a share revoked, a reparent out of their subtree — and a surface
that re-fetched the target to show "the issue you were editing" would hand back
exactly the content the revocation removed. Everything rendered comes from the
parked entry itself. Discard and copy-my-text therefore need no read at all,
which is the only way they can work for an entity that is now invisible.

**The affordances come from the reason code, never from the situation.** The
kernel merges rights-denied, target-invisible and target-nonexistent into one
code. If the UI withheld a button for one of those three, or wrote a more helpful
sentence for it, the oracle would leak back out through the UI after the kernel
carefully closed it.

### The wording decision, and the question left open

The brief asked for an "actionable explanation" and offered *"you no longer have
access to this issue"*. POD-370's kernel forbids exactly that and pins the
invisible and nonexistent records byte-identical. **Both are right**, because
they speak at different levels:

- **actionable at the reason-code level** — "this needs a permissions change, not
  an edit" says what to *do*, and is true whether the grant was revoked, the
  entity was deleted, or the id was never valid;
- **silent at the target level** — no title, no id, no existence claim.

The example string fails only because it *asserts the target exists*. The safe
wording is picked and lives in one module (`outbox-recovery-copy.ts`).

> **NEEDS A HUMAN.** Whether the product may ever distinguish "the share was
> revoked" from "the entity was deleted", and whether that answer changes for a
> write queued by a *delegated agent* rather than by the person reading the list,
> stays **open at ADR 3 Amendment 1 §3 O1**. It was not settled here; a UI string
> is the wrong place to decide an existence-disclosure policy. No human was
> available during this run.

## 4. `CommandPolicy.confirmation` — routed, not deleted

POD-1224 recorded it as declared on every contract and read by nothing, and gave
this issue the call. **Routed.** The audit's reading is right about the server
(where `overrideScope` already decides) and wrong about the client, where the
recovery surface has a question the refusal does not answer: *can the user do
anything about this from here?* D2's three rules answer differently — `confirm`
yes; `broker` no, because the approval broker is the executor and a checkbox in
this dialog is not it; `none` no, and something is wrong. So the field now
decides whether the retry affordance appears at all.

The value is a **copy** on the client's contract table (importing the registry
would pull it into the browser bundle — `audit:browser-reach`), pinned equal to
the contract's by `outbox-contract-table.test.ts`, which is proven to fail when
they disagree.

## 5. Verification — every guard was proved able to say NO

Each mutant was verified applied (hash change or grep-back), applied one at a
time, and reverted.

| Mutant | Result |
|---|---|
| Restore the shipped drop (`shift()`, no park) | **12 tests red** |
| `unauthorized` falls through to transient retry | **6 red** |
| `retry()` stops enforcing the precondition | **3 red** |
| Parked entries become drainable on reload (POD-1220's shape) | **1 red** |
| Copy says "you no longer have access to this issue" | **1 red** |
| Retry button rendered unconditionally | **1 red** *(see below)* |
| Client table claims a confirm rule the contract lacks | **1 red** |

**One of my own guards could not say no, and the fix is recorded.** The retry
button test matched `queryByRole('button', {name: /Retry/})` and **survived** the
unconditional-render mutant: the label comes from the same code-derived copy, so
with no label there is no accessible name, so an always-present button read as
absent. Rewritten to assert the control's *presence* by test id. Re-run with the
mutant after the fix: red.

Lanes: `typecheck` 23/23 · client-core + commands + sync **1518 passed** · web
**1266 passed (166 files)** · mobile **34 passed** · `lint:boundaries` 0 new ·
`audit:declared-consumers`, `audit:browser-reach`, `audit:client-secrets` all
pass.

`audit:phase2-client` reports 4 — **pre-existing and not mine**. It is a
documented known-red (ledger: "merging an instrument red is sometimes correct" —
it landed at 6). Its detector matches `createReplica(` / `createKernelReplica(` /
`SyncStore.open(`; none of my changes add such a call, and the file it names
(`legacy-snapshot.ts:124`) is untouched here.

---

## 6. What this issue does NOT deliver, and why

Read this before treating the acceptance list as satisfied.

**Six acceptance criteria are already met by POD-370's kernel, not by me**, and I
verified rather than rebuilt them: revoked-while-offline rejection, eviction-is-
not-deletion, dead-letter privacy, per-partition FIFO, byte-identical
`unauthorized` records, and delivery-class enqueue refusal all have kernel tests
in `packages/sync/src/outbox/outbox.test.ts` and gates in the conformance suite
(`scoped/revoked-offline-with-queued-writes`, `scoped/rescope-keeps-the-outbox`).

**Four cannot be delivered in this tree at all, and no test here should pretend
otherwise:**

1. **The two-user concurrency test** and **the revoked-while-offline e2e with a
   second user.** There is one principal in this product. `client_sessions` has
   no user column, `CLIENT_PRINCIPAL_GRADE` is `device`, and the web replica is
   keyed to the constant `'default'`. User B does not exist to revoke anything.
2. **Delegation-chain re-auth from the outbox**, for the same reason — the chain
   needs a human at its root, and there are no user identities on the client yet.
3. **Airplane-mode e2e through the *kernel* outbox.** The web engine still drains
   the **legacy** client outbox; the kernel Outbox is not wired into it. That
   cutover is POD-372 / POD-306 territory and is a substantial piece of work
   (`createEngineOutbox`, the overlay fold, and `awaiting-truth` retirement all
   assume the legacy shape). **I deliberately did not build a UI over an Outbox
   nothing in the web app constructs** — that is the exact failure the ledger
   warns about, a surface that reports success while draining nothing.
4. **Browser-lane runtime verification.** The recovery surface is runtime-
   verified by mounting the real component over a **real** `Outbox` that has
   really refused a real write, and clicking it (`outbox-recovery.test.tsx`, 8
   tests, happy-dom). That is genuine runtime behaviour, but it is **not** the
   Playwright browser lane, and I am not claiming it is.

**Single-user parity holds by construction:** with one principal, the only
behaviour that changed is that a refused write is now recoverable instead of
deleted.

### Not done, worth filing

- Composer drafts: the whole-body-LWW overwrite risk is **recorded**, not fixed —
  §4 of `docs/multi-user-readiness.md` reserves the `op-stream` class for it and
  deliberately does not require building it yet. No new LWW dependency was added.
- `sweepExpired(maxAgeMs)` exists on the client outbox and **has no caller**. The
  age limit (D10's 14 days) is therefore not enforced client-side yet.
- The presence-class commands (`sessions.*`, `snoozes.*`) are still leaf
  `CommandDef`s, not full contracts, so the drift guard cannot check their
  confirmation rule. The unguarded list is asserted **exactly**, so the day one
  gains a contract, the test reddens and the row moves under the guard.
