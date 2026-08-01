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

Lifecycle coordinates create, resume, continue, stop/kill, hibernate, resurrect and daemon
spawn/reattach. `SessionTerminal` owns live PTY state and cumulative activity counters;
`SessionRepository` owns their coalesced durable activity flush alongside row/ledger commits.
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

The remaining projections map one-to-one to model views: `SessionView` is the sole
reader-scoped `SessionMeta` mapper; `SessionRepository` owns durable row/ledger projection;
`SessionPublicationCoordinator` owns prepared client publication; and `SessionStateService`
owns durable overlays. Runtime ownership is explicit too: `SessionTerminal` owns PTY/activity
state, `SessionInbox` owns attributed queued input, `SessionWorkspace` owns machine-scoped
repo/worktree operations, `SessionDaemonLifecycle` applies daemon runtime events, and
`SessionDaemonProjection` applies daemon metadata. `SessionLifecycle` coordinates create,
resume, stop, hibernate, resurrect and kill across those ports. Handoff remains
`HandoffCoordinator`; binding receipts remain `SessionBindingReceipts`; browser control
remains `BrowserOpenGateway`.

## Verification

Verified after the final split on 2026-08-01: the session unit, cutover and browser-open
suites passed 41 files/498 tests; the POD-392 oracle passed 10 files/183 tests; and session
integration E2E passed 8 files/31 tests. Typecheck passed 22/22 packages, the rearchitecture
audit stayed exact at 31 items/169 sites, the serving-path audit passed 5/5 and every mutation
probe, and the independent multi-instance lane passed. The full repository unit lane executed
631 files/9,271 tests: 625 files and 9,248 tests passed, 3 files/19 tests were skipped, and the
only remaining failures were POD-1308's two 20-second normalized-wire cases and 180-second
live-scale benchmark. The extraction reduced `lifecycle.ts` from 5,105 lines/177 method-like
entries to 2,954 lines/76 class methods; `Session` itself is 717 lines and runtime-only.

The supervised dev-host redeploy completed successfully at 2026-08-01 10:11 CEST:
`podium-redeploy.service` returned status 0; server PID 3419555 became 3916754 and
daemon PID 3417444 became 3917616; `/health` returned `ok`; and `podium issue prime`
worked through the restarted server. The durable session scope remained active with its
original 2026-07-30 09:24:56 start time, and agent PID 1188165 retained that same start
time after the server, daemon and web restart.
