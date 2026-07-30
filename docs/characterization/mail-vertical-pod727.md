# Agent-mail characterization oracle (POD-727)

Step 1 of the POD-640 mini-epic. Three suites plus one shared harness pin the **current**
behaviour of the agent-mail vertical so POD-728 (mail contracts + handlers) and POD-729
(cutover + deletion) can be proven behaviour-preserving rather than merely compiling.

**No production code changed.** Where the current behaviour is odd, or is an artefact of the
single-operator model, the test says so in a comment rather than asserting it as desirable.
This is an oracle for a migration, not a specification of the end state.

| File | Tests | Pins |
| --- | --- | --- |
| `apps/server/src/modules/messages/characterization-support.ts` | — | the shared harness |
| `…/characterization.delivery.test.ts` | 36 | delivery, threading, urgency, consumption |
| `…/characterization.authz.test.ts` | 26 | authz + identity, POD-463 |
| `…/characterization.spawn-await.test.ts` | 27 | spawn / await / ask lifecycle |

## Why the harness looks like this

The `IssueService`, `SessionStore` (messages repo, events, `issue_messages` mirror),
`MessageDeliveryService`, `MessageGate` and the spawn-on-wake wiring are the **real
production objects**. Only two things are faked, because a unit test cannot have them:

- the PTY transport (`sendText` / `queueText` / `interruptText`), which records every push
  **verbatim** so bodies can be asserted byte-for-byte;
- the session inventory.

Using the real `IssueService.resolveRef` is what makes the unknown-id vs out-of-scope-id
divergence observable at all. The hand-written fake in the existing gate tests throws on an
unknown ref, which hides the divergence completely.

The clock is injected. **No test sleeps before an assertion** (POD-757): bounded waits
converge through a poll seam that advances the injected clock and lets a test flip state
mid-wait, so a blocking send's confirmation travels the real transcript-echo path with zero
wall-clock time.

## The load-bearing distinctions, pinned

| Behaviour | Where |
| --- | --- |
| `delivered` = the push was confirmed (echo / turn boundary / injection); `read` = the recipient pulled its inbox | D6 |
| a peek is **not** a consume; only the caller's own issue box consumes | A4 |
| a reply is owed **only** for `--expect-response` or a `question` | D9 |
| unreplied mail redelivers **exactly once** through the stop hook, then the steward owns it | D9 |
| a substantive reply from the party that was asked ends the thread; a steward nag never does | D8 |
| self-delivery is suppressed — self-only is ledger-only, never queued | D10 |
| `interrupt` lands mid-turn; an ordinary message waits for the turn boundary | D3 |
| envelope byte-fidelity: operator unwrapped **and** unsanitized, everyone else control-stripped and framed | D2 |
| the sender is stamped from the capability; payload sender fields are never read (ADR 3 D7) | A1 |
| every wait is bounded — `await` always returns | S4 |

## What POD-728 must deliberately change

These are asserted **as today's behaviour**, so the change shows up as an edit to a test
rather than as silence.

1. **The existence oracle** (multi-user-readiness §3.1.5). An unknown issue id *succeeds* at
   the RPC layer and dead-letters at delivery; an id that exists but is outside the caller's
   scope throws `PRECONDITION_FAILED` and leaks the internal issue id in the message. The two
   are trivially distinguishable today. Pinned in A3, with the divergence itself asserted.
2. **`messages.ledger` is operator-only** and documented as such because it exposes other
   principals' traffic. POD-728 reclassifies it (own traffic for a member, cross-user at admin
   grade). Pinned in A5.
3. **The whole operator principal class**, pinned assertion by assertion in A6 and S3:
   sender derivation (`scope: 'all'` ⇒ operator; `scope: 'none'` + `actorSessionId` ⇒ an
   **agent**, never the operator), unwrapped-vs-enveloped rendering with the question
   exception, exemption from the wake cooldown *and* from the daily spawn budget, the
   "the operator" labels on both sides, `toKind: 'operator'` rows staying queued for UI pickup
   and being skipped by both `attemptDelivery` and the sweep, `replyTarget` falling back to
   `operator` for superagent/operator/system senders, and `senderKey` collapsing every
   operator to the literal `operator` and every superagent to the literal `superagent` — so
   **all superagent traffic shares one cooldown bucket today**.
4. **The unreachable-machine arm** of `spawnAgent` (S2), pinned so that the use-grant denial
   POD-728 adds (§3.1.4 M5) can be told apart from a machine simply being offline.

## Findings recorded as-is, not fixed

The brief forbids fixing anything here. Three expectations of mine that the code contradicted
are pinned as the code behaves, each with a comment:

1. An **unfiltered** `messages.ledger` query returns nothing at all, not everything. (No
   accidental firehose — defensible.)
2. `awaitAgent` on a session that **never existed** throws `session not found` from the
   session-target gate. The in-loop `gone` result is reachable only for a child that vanishes
   *during* the wait. (Both arms are now pinned separately.)
3. An agent's spawn that fails **inside** the spawn seam has already consumed a unit of the
   daily budget, and the in-memory counter is not refunded. It is not durable either (no
   `agent.spawned` event), so a restart forgives it. A fail-closed brake, so not a bug.

None was filed as an issue.

## Mutation testing — proof the net catches regressions

Each mutation was applied to the product, the three suites were run, and the product was
reverted with `git checkout --`. **16 mutations, 15 killed.**

| # | Mutation | Result |
| --- | --- | --- |
| M1 | treat every injection as a confirmed delivery (`delivered` ⇒ `read` collapse) | **7 tests red** |
| M2 | make every named-issue peek consume | **2 red** |
| M3 | remove self-delivery suppression (session arm) | **1 red** |
| M4 | let a busy `next-turn` type mid-turn instead of holding for the boundary | **2 red** |
| M5 | make every message owe a reply (`expectsResponse` defaults true) | **6 red** |
| M6 | sanitize + envelope the operator's body | **3 red** |
| M7 | stamp the sender as `operator` instead of from the capability | **2 red** |
| M8 | converge the unknown-id error onto the out-of-scope one (what POD-728 must do) | **2 red** |
| M9 | report the `await` timeout as a clean finish | **3 red** |
| M11 | remove the wake-cooldown brake | **3 red** |
| M12 | let a peer keep `interrupt` (clamp matrix) | **2 red** |
| M13 | let a `notification` satisfy a requested response | **1 red** ¹ |
| M14 | drop the once-only stop-hook reminder marking | **1 red** |
| M15 | hand a legacy raw ref straight to the issue mirror (POD-463) | **3 red** |
| M16 | never brake a direct agent spawn (spawn budget) | **2 red** |
| M17 | remove `recordWake`'s operator early-return | **1 red** |
| M10 | remove the operator check in `send`'s cooldown branch | **SURVIVED** ² |

¹ M13 initially survived: every existing assertion on the notification guard used a
system/steward sender, for whom `isRecipientOf` already decides the outcome (a system sender
has no `sessionId`, so it can never be the recipient of a session-addressed message). An
assertion was added for the **asked agent itself** replying with `kind: 'notification'`, which
is the case that actually exercises the guard. M13 now goes red.

² M10 survives **by design**, not for want of coverage. The operator's cooldown exemption is
implemented twice: the `from.kind !== 'operator'` check in `send`, and `recordWake`'s early
return. With `recordWake` intact no cooldown row is ever written for an operator, so the hot
check can never fire — the `send`-side check is redundant. The effective half is pinned:
removing it alone (M17) goes red, and removing both (M10+M17) goes red.

## Verification

Run from the worktree root:

```sh
bun --bun vitest run --config vitest.unit.config.ts apps/server/src/modules/messages
```
