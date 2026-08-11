/**
 * Session client / daemon presence plane (POD-1396).
 * Attach, reclaim, detach, reattach, open-url, client frames.
 * Dispose: none.
 */

import type { SessionId } from '@podium/model'
import type {
  ControlMessage,
  LiveServerMessage,
  MachinePrincipal,
  RoomRef,
  SessionOpenUrlMessage,
} from '@podium/protocol'
import { systemPrincipal } from '../../command-principal'
import type { SessionsClientFrame } from '../../gateway/client-frame-routing'
import type { ClientPrincipal } from '../../gateway/client-principal'
import type { ClientConn } from '../../gateway/client-registry'
import { machineUseDecision, ownershipFromMachines } from '../../machine-access'
import type { Session } from './session'

export interface SessionClientPlanePorts {
  browserOpen: any
  clientControl: any
  clients: any
  headless: any
  machineReconciler: any
  machines: any
  repository: any
  rpc: any
  state: any
  terminalProof: any
}

export class SessionClientPlane {
  constructor(private readonly ports: SessionClientPlanePorts) {}

  /**
   * A machine's daemon became reachable / went away — the SESSION half of
   * attach/detach. Delegated to {@link SessionMachineReconciler}; the gateway
   * (`gateway/daemon-mux.ts`) owns the transport half and calls these.
   */
  onMachineAttached(principal: MachinePrincipal): void {
    this.ports.machineReconciler.onAttached(principal)
  }

  onMachineDetached(principal: MachinePrincipal): void {
    this.ports.machineReconciler.onDetached(principal)
  }

  /**
   * The reattach control message for one survivor session.
   *
   * `recoveryMachineAccess` was computed ONCE per attach before this moved, and
   * is computed per session here. Identical result: the decision depends only on
   * `machineId` and the machines ownership snapshot, and the caller's loop is
   * synchronous, so nothing can change between iterations.
   */
  reattachMessageFor(session: Session, machineId: string): ControlMessage {
    const recoveryMachineAccess =
      machineUseDecision(
        systemPrincipal('session-rebind'),
        machineId,
        ownershipFromMachines(this.ports.machines),
      ) === 'granted'
        ? 'allowed'
        : 'denied'
    const observationLease = this.ports.terminalProof.fence(session)
    const requestedGeneration = observationLease?.observationGeneration ?? 1
    return {
      type: 'reattach',
      sessionId: session.sessionId,
      durableLabel: session.durableLabel,
      agentKind: session.agentKind,
      cwd: session.cwd,
      geometry: session.terminal.geometry,
      binding: {
        transitionId: `reattach:${session.sessionId}:${requestedGeneration}`,
        machineAccess: recoveryMachineAccess,
        sessionAccess: 'allowed',
        principal: { kind: 'system' },
        // WHO this session belongs to, for a survivor the daemon has no binding
        // record for (every session older than the binding store). The daemon
        // cannot know it; this row is where it lives. `principal` above is the
        // probe, not the owner — see SessionBindingReattachInstruction.adopt.
        adopt: {
          ownerUserId: session.ownerUserId,
          ...(session.issueId ? { issueId: session.issueId } : {}),
        },
      },
      ...(observationLease
        ? {
            observationGeneration: observationLease.observationGeneration,
            observationBindingVersion: observationLease.bindingVersion,
            observationProviderSessionId: observationLease.providerSessionId,
            ...(observationLease.checkpoint
              ? { observationCheckpoint: observationLease.checkpoint }
              : {}),
          }
        : {}),
      ...(session.resume ? { resume: session.resume } : {}),
      ...(this.ports.rpc.transcriptPathHint(
        { kind: 'system', id: 'session-attach' },
        {
          id: session.sessionId,
          machineId: session.machineId,
          ...(session.resume ? { resume: session.resume } : {}),
        },
      ) ?? {}),
      // Spawn-time floor for observer-based harnesses (codex): lets a reattached
      // observer discover a lazily-created rollout it never saw before the restart.
      ...(Number.isFinite(Date.parse(session.createdAt))
        ? { createdAtMs: Date.parse(session.createdAt) }
        : {}),
      ...(this.ports.state.draftSyncEnabled() ? { draftSync: true } : {}),
    } as ControlMessage
  }

  /**
   * Re-establish a headless session's daemon-side transcript tail.
   *
   * DELIBERATELY NOT AWAITED, exactly as before the move. It is re-issued on
   * every daemon connect, so a missed bind self-heals on the next attach; making
   * it awaited here would serialise the rebind loop behind daemon round-trips.
   */
  rebindHeadless(session: Session): void {
    if (!session.resume?.value) return
    void this.ports.headless
      .headlessBind({
        sessionId: session.sessionId,
        agentKind: session.agentKind,
        cwd: session.cwd,
        resumeValue: session.resume.value,
      })
      .then((r: { ok: boolean; error?: string }) => {
        if (!r.ok) {
          console.warn(
            `[podium] headless bind failed for ${session.sessionId}: ${r.error ?? 'unknown'}`,
          )
        }
      })
  }

  /** Route a control message to the daemon that owns `machineId` (modules/machines);
   *  queued if that machine is briefly offline. Kept as a property so Session
   *  toDaemon closures and every internal call site bind through one seam. */
  private readonly toMachine = (machineId: string, msg: ControlMessage): void =>
    this.ports.machines.toMachine(machineId, msg)

  /**
   * Recompute per-session output-relay priority across every client and push the
   * deltas to the daemon. computePriorities re-iterates its `clients` argument
   * ONCE PER SESSION, so a single-use iterator (this.ports.clients.values()) would
   * exhaust after the first session and read every later session as tier 3 —
   * materialize it to an array. Only CHANGED sessions are sent (diffed against
   * lastPriority) so a viewState/attach churn never re-floods the whole map.
   */

  sessionsChangedForMachine(machineId: string): void {
    this.ports.repository.sessionsChangedForMachine(machineId)
  }

  /**
   * A machine's daemon became reachable / went away — the SESSION half of
   * attach/detach. Delegated to {@link SessionMachineReconciler}; the gateway
   * (`gateway/daemon-mux.ts`) owns the transport half and calls these.
   */

  // ---- the sessions FEATURE PORT for client frames (gateway/client-mux.ts) ----
  /**
   * A client connection was admitted: send it the world it is owed.
   *
   * This used to be the tail of attachClient, which also minted the id,
   * registered the socket and sent welcome. Those are the gateway now
   * (POD-390). Entity bootstrap belongs exclusively to FeedServing; this hook
   * replays only session draft state and the machine list.
   */
  onClientAttached(principal: ClientPrincipal, client: ClientConn): void {
    this.ports.clientControl.onAttached(principal, client)
  }

  /** Feature-owned consequence of a successful stream-room join. */
  onRoomJoined(client: ClientConn, room: RoomRef): void {
    if (room.kind === 'session') this.ports.browserOpen.replayPending(client)
  }

  /** Authorization/view invalidation seam: the main authority changed one client world. */

  onClientReclaim(prior: ClientConn, next: ClientConn): void {
    this.ports.clientControl.reclaim(prior, next)
  }

  /**
   * A client connection is gone: sweep the session state it held.
   *
   * The gateway has ALREADY removed it from the connection set when this runs
   * (`client-mux.ts` explains why that ordering is behaviour-identical: every
   * read below is off the connection object or the per-session client maps, and
   * the two recomputes at the end always ran after the removal anyway).
   */
  onClientDetached(principal: ClientPrincipal, client: ClientConn): void {
    this.ports.clientControl.onDetached(principal, client)
  }
  /** Gateway/control-plane entrypoint for the typed session.openUrl event. */
  onOpenUrl(request: SessionOpenUrlMessage): void {
    this.ports.browserOpen.onOpenUrl(request)
  }

  /**
   * Reconnect reclaim: a freshly connected client (`next`) presents the id of its
   * previous socket (`priorId`). Move that stale client's controller roles onto
   * `next`, then evict it. Roles are transferred BEFORE eviction so detachClient's
   * "reassign to some other attached client" fallback doesn't hand control to a
   * third party (or drop it) in the window before `next` re-sends its attaches.
   * The client's own `attach` messages (which follow `hello`) then re-establish
   * PTY membership and resume the output stream.
   */
  /**
   * One SESSION-OWNED client frame, attributed to the connection it arrived on.
   *
   * This used to be `onClientMessage` — a switch over the WHOLE client union
   * reached by id lookup, which made the sessions service the multiplexer AND
   * the socket owner for the client plane. The mux is the gateway's now
   * (POD-390); what remains is the session-owned subset the routing table
   * assigns to this port, with `SessionsClientFrame` making that subset a
   * compile-checked type rather than a comment. `ping`/`pong` is no longer here:
   * a liveness echo is transport, and the gateway answers it.
   *
   * The principal is carried and not consulted: authorization on this plane is
   * the command envelope's (`sessions.setDraft` below routes through it), and a
   * device-grade principal has nothing to decide that today's single-user trust
   * model does not already settle. See `gateway/client-principal.ts`.
   */

  /**
   * Reconnect reclaim: a freshly connected client (`next`) presents the id of its
   * previous socket (`priorId`). Move that stale client's controller roles onto
   * `next`, then evict it. Roles are transferred BEFORE eviction so detachClient's
   * "reassign to some other attached client" fallback doesn't hand control to a
   * third party (or drop it) in the window before `next` re-sends its attaches.
   * The client's own `attach` messages (which follow `hello`) then re-establish
   * PTY membership and resume the output stream.
   */
  /**
   * One SESSION-OWNED client frame, attributed to the connection it arrived on.
   *
   * This used to be `onClientMessage` — a switch over the WHOLE client union
   * reached by id lookup, which made the sessions service the multiplexer AND
   * the socket owner for the client plane. The mux is the gateway's now
   * (POD-390); what remains is the session-owned subset the routing table
   * assigns to this port, with `SessionsClientFrame` making that subset a
   * compile-checked type rather than a comment. `ping`/`pong` is no longer here:
   * a liveness echo is transport, and the gateway answers it.
   *
   * The principal is carried and not consulted: authorization on this plane is
   * the command envelope's (`sessions.setDraft` below routes through it), and a
   * device-grade principal has nothing to decide that today's single-user trust
   * model does not already settle. See `gateway/client-principal.ts`.
   */
  onSessionClientFrame(
    principal: ClientPrincipal,
    client: ClientConn,
    message: SessionsClientFrame,
  ): void {
    this.ports.clientControl.onFrame(principal, client, message)
  }

  /** Hand an issue the worktree its session is actually working in [spec:SP-4ef9].
   *  Two ways in: the agent DECLARES it (`podium worktree`), or the HARNESS makes its
   *  own worktree and the session's hooks start reporting from it (Claude's
   *  EnterWorktree — POD-664 left the worktree real on disk with the issue holding
   *  neither branch nor path). Podium adopts what the harness did rather than fighting
   *  it; branch and path are stamped together so the issue can never hold half of one.
   *
   *  Every guard earns its place — this stamps a path the AGENT chose, not one podium
   *  created: only a real linked worktree (a main checkout is never a workspace, and an
   *  issue claiming main would swallow every unattached session — [spec:SP-595b]), only
   *  in the issue's own repo, only when the issue owns no worktree yet, and never one
   *  another issue already owns (a `cd` into a sibling's workspace must not steal it).
   *
   *  Declaring (`podium worktree`) vs being observed makes no difference to the stamp:
   *  the guards below decide, and `explicit` only buys a send the daemon would otherwise
   *  dedup away. Both answer the same question — is the session working in a worktree
   *  its issue doesn't know about? */
  // ---- the sessions FEATURE PORT for daemon frames (gateway/daemon-mux.ts) ----
  /**
   * One SESSION-OWNED daemon frame, attributed to the machine that sent it.
   *
   * This used to be `onDaemonMessageFrom` — a switch over the WHOLE daemon union,
   * which made the sessions service the multiplexer for host metrics, repo scans,
   * credential relays, approvals, the agent relay and every RPC reply. The mux is
   * the gateway's now (POD-389); what remains is the session-keyed subset the
   * routing table assigns to this port, and `SessionsDaemonFrame` makes that
   * subset a compile-checked type rather than a comment.
   *
   * The frames are session-keyed and machine-agnostic in their LOOKUP, but the
   * machine still matters: several cases refuse a frame from a machine that does
   * not own the session (handoff leaves a stale daemon able to send late frames
   * for a session id now hosted elsewhere), and every write they make is a
   * daemon-class observation attributed to `principal`.
   */
}
