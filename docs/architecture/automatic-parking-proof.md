# Automatic parking proof ownership

POD-4297 retains automatic parking as an explicitly owned **host safety service**
for C09/C10 of POD-3744. Driver `hibernate()` executes retirement; its resume check,
`health().alive`, and an idle state are not evidence that retirement will lose no work.
This boundary survives removal of legacy PTY control APIs.

## Owners and consumer

- `HostsService` owns family-specific quiet policy and candidate selection for memory,
  load, count and idle-backstop pressure. Every automatic **agent** park requests
  `requireTerminalProof: true`, including unknown-phase sessions and the backstop.
  Shells retain their separate fresh-spawn policy; explicit human stop/archive is separate.
- `SessionTerminalProof` owns gathering and judging the no-work facts. Evidence includes
  observer generation, binding, provider cursor and terminal fence; input/output/resume
  timestamps and counters; queued input, pending mail, auto-continue, queue drains,
  native subagent identities/counts and active child sessions; and resume availability.
  Native subagent identities block even if a provider reports a zero count.
- `ObservationCheckpointsRepository` owns durable candidates, distinct live-poll
  confirmation and compare-and-consume. Replayed confirmations cannot earn the second
  pass. Changed facts require new evidence; a spent proof cannot be reused in its generation.
- `SessionTeardown.hibernateSession` re-derives the evidence inside the session-row
  transaction and consumes the exact durable candidate before committing hibernation.
  A mismatch or failed consume rolls back; process retirement occurs only after commit.

Terminal quiet uses event time plus terminal activity stamps. Server/embedded quiet
uses contract event time. Unknown phase retains at least the four-hour quiet floor.
None of those clocks waives proof. A contract-backed session with no causal evidence
producer stays live, even after the backstop. This intentionally removes the old
unknown-phase and backstop proof bypasses.

## Migration constraint

POD-3744 must retain these host services and their observation evidence path until a
replacement supplies equivalent causal facts and transactional consumption. Do not wire
an automatic host sweep directly to `AgentSessionHandle.hibernate()`, or synthesize a
candidate from idle/health/resume. Contract-only sessions remain ineligible while that
producer is absent; the host does not manufacture evidence from silence.

## Falsification coverage

`apps/server/src/terminal-hibernation-proof.test.ts` exercises changed generation,
new input/output and queue activity, pending mail, all active-work facts, missing resume,
replayed live confirmation, changes between check and transaction, failed consumption,
and rollback when the session-row write fails. `modules/hosts/service.test.ts` and
`service-contract-quiet.test.ts` exercise proof refusal under host pressure and backstop,
family-specific quiet stamps, and the unknown-phase floor.
