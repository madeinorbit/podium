# Update progress heartbeats — Implementation Plan

**Epic:** POD-2087 · **Spec:** `2026-08-14-update-operations-design.md` §3.3, P4
**Protocol:** `2026-08-14-updater-worker-protocol.md`
**Blocked by:** Update operation choreography.

**Goal:** The system can always tell moving from stuck: daemons report download percent,
the engine stamps liveness, deadlines fire on timers, and the poll-aged grant deadline is
deleted.

**Owns:** `packages/protocol/src/messages/update.ts` (additive `percent`),
`packages/runtime/src/update-delivery.ts` (+ git variant reporting), `apps/daemon/src/grant-apply.ts`,
`apps/server/src/modules/updates/service.ts` (deadline removal + percent intake),
`apps/server/src/modules/updates/operation.ts` (deadline config), tests.

## Context

- `updateStatus` frames: `{grantId?, state, version, detail?}`
  (`packages/protocol/src/messages/update.ts`); daemons emit `downloading` once and
  `restarting` once (`apps/daemon/src/grant-apply.ts:76-118`). A 9-minute download is
  silent.
- The 10-min grant deadline ages **only when `fleet()` is read**
  (`service.ts:379`, `GRANT_DEADLINE_MS`); the download itself has a 5-min timeout
  (`update-delivery.ts:43`); git delivery has an 8-min budget chosen to expire before the
  10-min silence deadline (`update-delivery-git.ts:46`).
- The operations engine (already merged) owns timer-driven deadlines and the `stalled`
  sub-state; this issue feeds it real heartbeats and moves deadline authority there.

## Tasks

- [ ] **Protocol** — `updateStatus` gains optional `percent` (integer 0–100) and optional
  `phaseDetail` (short machine string, e.g. `"downloading"`). Additive; absent tolerated;
  conformance-style test that an old frame without them still parses.
- [ ] **Daemon reporting** — `update-delivery.ts`: stream the download with a progress
  callback (content-length aware; unknown length reports bytes only, percent absent).
  A pure `decideProgressReport(lastSentAt, lastPercent, now, percent)` (report every 2 s
  OR every 5 percentage points, whichever first) gates emission — unit-tested, no timers.
  `grant-apply.ts` threads a reporter into delivery and emits `updateStatus` heartbeats
  with the same `grantId`. Git delivery reports phase transitions (fetch/checkout/install
  steps) as heartbeats without percent.
- [ ] **Server intake** — `onStatus` accepts heartbeat frames (same state, new percent)
  and forwards them to the engine: `recordProgress(opId, 'machines', { place, percent })`.
  The existing "restart silence deadline on every accepted report" behavior now feeds
  `lastProgressAt` instead of a private timestamp.
- [ ] **Deadline authority moves** — delete the `fleet()`-read aging
  (`GRANT_DEADLINE_MS` block at `service.ts:379`); the operation's step deadlines
  (configured per step: download silence ~90 s, restart total ~5 min, machines step total
  generous) are the only timeout. `stalled` → one automatic `ensure()` retry → typed
  `failed` (codes from the choreography issue: `machine-unreachable` / `stalled`).
  For a machine mid-grant, retry means: re-issue the grant to that machine (the grant
  runner already serializes and supersedes safely — `grant-apply.ts:135-155`).
- [ ] **Budget coherence** — assert (in one table, tested) that per-phase budgets nest:
  download timeout (5 min) < download-step deadline < machines-step total; git budget
  (8 min) < its step deadline. No magic numbers scattered — one config object.

## Testing

Fake-clock engine tests (silence → stalled → retry → failed); `decideProgressReport`
table; frame-compat test; an integration test where a fake daemon reports 3 heartbeats
and the operation's `places[].percent` advances. Gates: typecheck, focused, `bun run
test`, and `bun run test:e2e` (grant behavior changed).

## Acceptance

- With no poller attached (nothing reads `fleet()`), a silent grant still ages into
  `stalled` and then `failed` under a fake clock — the drill the old design could not pass.
- A live dev-source update drive shows percent advancing in `operations.active` (curl the
  endpoint mid-download; record the two snapshots in your issue state).
- Old daemons (no percent) still converge: absent heartbeats fall back to phase-report
  liveness only, with the step deadline as the guard.
