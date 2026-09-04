# POD-2022 — Write-path receipt migration (W4)

> FIRST ACTION in your worktree: `git merge --ff-only issue/1761-agent-runtime` (your branch
> was created off main and lacks the epic docs). Epic plan:
> `docs/plans/pod-1761-agent-runtime-plan.md`. Spec: `docs/2026-08-07-agent-runtime-architecture.html`
> (§3 Turns, §9 phase 2 server half). Prereq: POD-2021 landed (the daemon runtime frames —
> flat camelCase names, `runtimeSend` etc. — + terminal driver receipts on the integration
> branch).

## Objective

Server-side senders stop inferring delivery from ready-polling and start consuming
`TurnReceipt`s — cluster by cluster, behind the same flag POD-2021 introduced. Flag off:
byte-identical behavior. Flag on: every migrated caller's delivery decision comes from a
receipt (`accepted / queued / refused / unverified`), never from re-reading
`agentState.phase`.

## Preconditions recorded from W3's reviews (address early, in this item)

1. **Lease-holder identity**: the driver's lease check keys on `lease.kind` + `options.origin`
   and never compares `lease.holder` — `SendOptions` carries no holder identity, so a second
   human-origin sender can interleave with a takeover holder. Extend the contract's send
   surface with the holder identity (or fold it into the acting principal) and enforce the
   comparison before migrating human-origin callers.
2. **Driver-side queue authorization**: `host.authorizeAtDrain` has no provider in the daemon
   (honestly declared at `injection.ts:174-188`) — a forwarded driver-side queue would drain
   unauthorized. Supply the provider (server-authorized principal reference resolution) before
   any cluster forwards queued turns to the daemon; until then queue stays server-completed.
3. **Coverage guard rails**: POD-2042 tracks the four W3 fixes currently pinned by no test
   (F1 adopted-session rawFirstTurn, F6 terminal-answer, F7 answeredBy, F8 array-prompt
   fingerprinting) — coordinate: those tests should exist before your clusters rely on the
   behaviors.

## Method (same for every cluster)

1. Identify the cluster's send entry points and its delivery-inference logic.
2. Add the receipt-based branch behind the flag. **Flag provenance is PER-SESSION, not
   global (reviewed):** receipts only exist for sessions spawned onto the contract path, so
   server callers branch on the session's recorded contract/driver fact (from the session
   row/binding, set at spawn by POD-2021's per-spawn field) — a global server env over mixed
   sessions mis-fires. The legacy branch stays intact and default.
3. Re-baseline in flag-on VARIANTS: new test files reusing the existing harness; flag-off
   test bodies stay untouched. One shared-support edit is expected and allowed:
   `characterization-support.ts`'s `mailHarness()` must grow a receipt-shaped transport
   seam beside its `sendText|queueText|interruptText` push seam — baselines untouched,
   harness extended.
4. Run cluster suites both ways; commit per cluster with a `Podium-Issue: POD-2022` trailer.
   `relay.ts` is the wiring seam for both `queueText` (~:1506) and `sendTextWhenReady`
   (~:1991) — it is touched by C1/C2 even though no cluster "owns" it; treat its edits as
   part of whichever cluster flips the verb.

`unverified` policy (uniform, decided — do not re-decide per caller): treat as
**delivered-unconfirmed**. Mail/steward: mark the row delivered-unconfirmed (ledger-visible),
no blind retry, confirmation still flips on transcript echo exactly as today. Chat: keep the
optimistic bubble, reconcile on echo (today's behavior, now with an honest name). Nothing
converts `unverified` into an error or a resend.

## The clusters, in landing order

### C1 — messages (`apps/server/src/modules/messages/`)
`service.ts` (the urgency × lifecycle table ~:1030–1120/:1371–1396, echo confirmation
`ECHO_CONFIRM_WINDOW_MS`/`MAX_ECHO_REQUEUES`, the `onSessionIdle`/sweep drain paths) +
`scheduler.ts` + `queued-apply.ts` + handlers `ask.ts`, `spawn-agent.ts` where they send.
(`pending-reminders.ts` is a read-only stop-hook query — not a send path, out.) Flag-on
shape: one `send()` per decision with the delivery mode the table picked; `queued` receipts
replace the outbox-depth guesswork; echo-confirmation logic stays (it is the
`unverified→confirmed` upgrade path). Characterization: the delivery pin is ONE file —
`modules/messages/characterization.delivery.test.ts` (D1–D13, 39 tests) — plus adjacent
pins you will brush: `messages/{service,cutover,gate-agent,spawn,multi-user}.test.ts`,
`modules/sessions/inbox.test.ts`, `steward.test.ts`. (`apps/server/src/characterization.test.ts`
is a CLI/issue pin — not yours.)

### C2 — steward (`apps/server/src/steward.ts`)
**Corrected mapping (reviewed):** `sendTextWhenReady` is implemented as `queueText` — the
DURABLE DB outbox that survives restarts and resurrects parked sessions (relay.ts:1991,
steward.ts:209). It migrates to `send({delivery:'queue'})` (server-completed, durable),
preserving wake/resurrect semantics — NOT `when-ready`, which under POD-2021's split is the
daemon's in-memory path and would silently downgrade steward nudges. Four call sites
(steward.ts ~:733/:850/:934/:1033). The causal gate (`isAcceptedLiveTerminalEvent`) is
untouched — it gates *triggers*, not sends.

### C3 — superagent tools (`apps/server/src/modules/superagent/tools.ts`)
Scope corrected (reviewed): `send_to_agent` routes through `modules.messages.send` — already
covered by C1. `answer_question` is menu-only by explicit contract (no text fallback) — not
a send path here; the Tray's `textFallback` caller is `issues.answerQuestion` in the issues
module → migrate it in C4. C3's real direct sends: the spawn tool's `queueText` (~:254),
`resume_and_send` → `sessions.resumeAndSend`, `continue_session`. `service.ts` turn
dispatch is headless-only — out of scope entirely.

### C4 — automations + revival + issues misc
`modules/automations/service.ts` (fresh-prompt `queueText` ~:670), `modules/sessions/
session-revival.ts` (resume-then-send), `modules/sessions/{lifecycle,session-wiring}.ts`
stragglers, `issue-util.ts` (`selectMailNudgeSession` consumes receipt outcomes instead of
phase peeks where it decides immediate-vs-outbox), and `issues.answerQuestion`'s
textFallback send (from C3's correction).

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
