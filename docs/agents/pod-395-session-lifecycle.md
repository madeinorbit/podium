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

Native identity receipt persistence and acknowledgement stay on the visible
`SessionBinding` seam for POD-737. Browser-open intent/callback forwarding stays a
gateway/control concern. Neither is classified as lifecycle merely because the old god
object happened to route its frames.

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
`SessionLifecycle`. All consume the same session model/store and expose explicit ports.
Live co-presence remains outside this durable family.

## Verification

The POD-392 oracle, session cutover audit, typecheck, full test lane, session E2E,
multi-instance lane, and dev-host live-redeploy survival are the completion evidence.
