# POD-2022 — Write-path receipt migration (W4)

> FIRST ACTION in your worktree: `git merge --ff-only issue/1761-agent-runtime` (your branch
> was created off main and lacks the epic docs). Epic plan:
> `docs/plans/pod-1761-agent-runtime-plan.md`. Spec: `docs/2026-08-07-agent-runtime-architecture.html`
> (§3 Turns, §9 phase 2 server half). Prereq: POD-2021 landed (the daemon `runtime.*` frame
> family + terminal driver receipts exist on the integration branch).

## Objective

Server-side senders stop inferring delivery from ready-polling and start consuming
`TurnReceipt`s — cluster by cluster, behind the same flag POD-2021 introduced. Flag off:
byte-identical behavior. Flag on: every migrated caller's delivery decision comes from a
receipt (`accepted / queued / refused / unverified`), never from re-reading
`agentState.phase`.

## Method (same for every cluster)

1. Identify the cluster's send entry points and its delivery-inference logic.
2. Add the receipt-based branch behind the flag; the legacy branch stays intact and default.
3. Re-baseline that cluster's characterization tests in a flag-on variant (do not weaken the
   flag-off baselines — add, don't edit, wherever the harness allows).
4. Run cluster suites both ways; commit per cluster with a `Podium-Issue: POD-2022` trailer.

`unverified` policy (uniform, decided — do not re-decide per caller): treat as
**delivered-unconfirmed**. Mail/steward: mark the row delivered-unconfirmed (ledger-visible),
no blind retry, confirmation still flips on transcript echo exactly as today. Chat: keep the
optimistic bubble, reconcile on echo (today's behavior, now with an honest name). Nothing
converts `unverified` into an error or a resend.

## The clusters, in landing order

### C1 — messages (`apps/server/src/modules/messages/`)
`service.ts` + `scheduler.ts` + `queued-apply.ts` + handlers (`ask.ts`,
`pending-reminders.ts`, `spawn-agent.ts` where it sends). Today's shape: urgency × lifecycle
table choosing `sendText`/`queueText`/interrupt-inject, with transcript-echo confirmation and
turn-boundary drains. Flag-on shape: one `send()` per decision with the delivery mode the
table picked; `queued` receipts replace the outbox-depth guesswork; echo-confirmation logic
stays (it is the `unverified→confirmed` upgrade path). Characterization:
`characterization.delivery` suites re-baselined flag-on.

### C2 — steward (`apps/server/src/steward.ts`)
`sendTextWhenReady` → `send({delivery:'when-ready'})`; the causal gate
(`isAcceptedLiveTerminalEvent`) is untouched — it gates *triggers*, not sends. Parent-nudge
wake path uses `send` with wake semantics (revival still owns resurrect).

### C3 — superagent (`apps/server/src/modules/superagent/`)
`tools.ts` (`send_to_agent`, `resume_and_send`, `answer_question` text fallback) and
`service.ts` turn dispatch where it targets PTY sessions. Headless-thread turns are NOT in
scope (they ride the headless path until W5/phase-5 rework).

### C4 — automations + revival + inbox misc
`modules/automations/service.ts` (fresh-prompt `queueText`), `session-revival.ts`
(resume-then-send), `lifecycle.ts`/`session-wiring.ts` stragglers, `issue-util.ts`
(`selectMailNudgeSession` delivery decision consumes receipt outcomes instead of phase
peeks where it decides immediate-vs-outbox).

### C5 — sweep + guard
Grep for remaining direct users of the legacy send verbs behind flag-on paths; add a lint
or test asserting that flag-on server code does not call the legacy inbox verbs directly
(allowlist the legacy branch itself). Update `docs/plans/pod-1761-agent-runtime-plan.md`'s
W4 checklist with what was migrated.

## Out of scope
Removing the legacy path (that happens when the operator flips the default, after testing).
Daemon changes. UI changes beyond what receipts already surface through existing frames.
Auto-continue (its trigger is state-based, its send is one `continue` text — migrate it in
C4 only if trivial, otherwise note-and-skip).

## Acceptance checklist
- [ ] Flag off: all existing suites green, unmodified.
- [ ] Flag on: C1–C4 characterization variants green; no migrated caller reads
      `agentState.phase` to decide delivery (asserted by the C5 guard).
- [ ] `unverified` visibly ledgered in messages (test proves a withheld echo produces
      delivered-unconfirmed, not a retry storm).

## Pitfalls
- Do not "fix" delivery semantics while migrating — same decisions, new evidence. Every
  behavioral improvement idea becomes a subissue of POD-1761, not a change here.
- The messages brakes/clamps (`brakes.ts`) exist for interrupt storms — receipts don't
  replace them; leave them wired.
- Steward's causal gate and the receipt path answer different questions (may-I-trigger vs
  did-it-deliver) — do not merge them.
- Characterization re-baselining is the point, not a chore: a diff you can't explain in the
  new baseline is a bug in your migration.
