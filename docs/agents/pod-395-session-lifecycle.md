# Session lifecycle extraction

Issue: POD-395  
Authority: `docs/multi-user-readiness.md`, read in full on 2026-08-01.  
Characterization basis: POD-392, commit `749fe740`, plus the current green oracle family.

## Boundary decision

Handoff remains a fourth module under `apps/server/src/modules/sessions/handoff/`.
The characterization shows an independent transaction boundary: export/import,
verified common-base selection, target worktree claim and hard sync, target resume,
source finalization, rollback after partial failure, live authorization rechecks, and
single-flight coordination. Lifecycle supplies ports and callbacks but does not absorb
that choreography.

Lifecycle owns create, resume, continue, stop/kill, hibernate, resurrect, daemon spawn
coordination, the live `Session` map, activity flush, and cumulative compute accounting.
The old `sessions/service.ts` entrypoint is deleted; no forwarding shim remains.

Native identity receipt persistence and acknowledgement live behind the explicit
`SessionBindingReceipts` seam that continues POD-737's binding-store ownership.
Browser-open intent/callback forwarding lives in `BrowserOpenGateway`. Neither is
classified as lifecycle merely because the old god object happened to route its frames.

## Authorization and ownership

Session creation declares parent inheritance: a session spawned under an issue inherits
the issue owner; otherwise it is owned by the transport principal's on-behalf-of human.
The agent remains the actor. The lifecycle persists that decision in
`sessions.owner_user_id`; no payload identity participates.

Spawn selection receives a live `MachineUseResolver`; explicit placement is checked
before preparation, and implicit placement filters candidates with the same resolver.
Existing-session commands, resurrect, and handoff re-resolve the transport principal and
machine grants at apply time. The local host sentinel is synthesized as owner-only compute.
Unauthorized, absent/invisible, and unreachable remain distinct where visibility permits.

Target-machine worktree reuse and hard sync occur only after the handoff module's target
`use` check, which is repeated immediately before target preparation.

## Module views

The durable session-state view is `SessionStateService`; attributed inbound/queued input
is `SessionInbox`; transfer state is `HandoffCoordinator`; runtime lifecycle state is
`SessionLifecycle`. Binding observations are `SessionBindingReceipts`; browser control
delivery is `BrowserOpenGateway`. All consume the same session model/store through
explicit ports. Live co-presence remains outside this durable family.

## Verification

Verified on 2026-08-01: all 39 session unit files plus the session cutover and browser-open
suites passed (40 files, 498 tests); all POD-392 oracle files passed; session integration
E2E passed (8 files, 31 tests); typecheck passed (22 packages); the deletion/serving-path
audits passed (83 tests); and the independent multi-instance lane passed. The repository
unit lane passed 626 files and 9,249 tests, with only three unrelated normalized-wire
performance timeouts while the shared dev host had load averages above 50.

The supervised dev-host redeploy completed successfully at 2026-08-01 10:11 CEST:
`podium-redeploy.service` returned status 0; server PID 3419555 became 3916754 and
daemon PID 3417444 became 3917616; `/health` returned `ok`; and `podium issue prime`
worked through the restarted server. The durable session scope remained active with its
original 2026-07-30 09:24:56 start time, and agent PID 1188165 retained that same start
time after the server, daemon and web restart.
