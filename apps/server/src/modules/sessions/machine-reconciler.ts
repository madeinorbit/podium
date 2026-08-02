/**
 * DAEMON PRESENCE RECONCILIATION (POD-1396, from POD-1385's god-object audit).
 *
 * When a machine's daemon appears or vanishes, this reconciles that machine's
 * durable session rows against it. That is the whole job, and it is one job:
 * every step below exists because the persisted row and the live process can
 * disagree, and something has to decide which one is right.
 *
 * THE SEAM. `gateway/daemon-mux.ts` already owns the transport half — socket
 * registration, placeholder adoption, queued-control flush, the machine
 * broadcast and the `machine.connected` / `machine.disconnected` bus emits. It
 * called into `SessionLifecycle` for the SESSION half, which is these two
 * methods and nothing else. The caller was already treating this as one
 * capability; it now has a name.
 *
 * ORDER IS PART OF THE CONTRACT, not an implementation detail, and it is
 * preserved exactly as it ran inside lifecycle.ts:
 *
 *   1. re-arm queued sends (their drains parked while the daemon was away)
 *   2. trigger the transcript-lake catch-up sweep
 *   3. reset + push relay priorities — a fresh daemon knows none of them
 *   4. PARK ARCHIVED SURVIVORS **BEFORE** the probe fan-out, so an archived
 *      'reconnecting' row is parked rather than reattached (POD-108)
 *   5. probe survivors for reattach, view-priority first then most-recent
 *   6. re-establish headless transcript tails
 *
 * Step 4 before step 5 is the one a reader is most likely to "tidy" and the one
 * that silently resurrects archived sessions if reversed.
 *
 * THE DAEMON IS NOT THE AUTHORITY ON LIVENESS AND THE ROW IS NOT EITHER — the
 * durable host is. That is why 'exited' rows are probed too: a row can be
 * wrongly 'exited' when its attach client died while the master and agent
 * survived. The daemon either reattaches a live master (→ a bind → markLive) or
 * replies reattachFailed, and only then does 'exited' stand.
 */

import type { ControlMessage, MachinePrincipal } from '@podium/protocol'
import type { Session, SessionVolatileField } from './session'

export interface MachineReconcilerPorts {
  /** This machine's candidate sessions. Read-only: nothing here adds or removes. */
  sessions(): Iterable<Session>
  /** Re-arm a parked queued-send drain. */
  drainInbox(sessionId: Session['sessionId']): void
  /** Transcript-lake catch-up sweep for this machine. */
  triggerLakeSweep(machineId: string): void
  /** Clear the relay-priority delta cache, then re-push the full map. */
  resetPriorities(): void
  pushPriorities(): void
  /** Archive means stopped: park a survivor that is still live/reconnecting. */
  parkArchivedSession(sessionId: Session['sessionId']): void
  /** Build the reattach control message for one survivor. */
  reattachMessage(session: Session, machineId: string): ControlMessage
  toMachine(machineId: string, message: ControlMessage): void
  /** Rank survivors: lower tier reattaches sooner. */
  viewTiers(sessionIds: Session['sessionId'][]): Map<Session['sessionId'], number>
  /** Headless sessions have no PTY; re-establish their daemon-side tails. */
  rebindHeadless(session: Session): void
  markVolatileSessionDirty(sessionId: Session['sessionId'], fields: SessionVolatileField[]): void
  broadcastSessions(): void
}

export class SessionMachineReconciler {
  constructor(private readonly ports: MachineReconcilerPorts) {}

  /**
   * A machine's daemon became reachable — the SESSION half of what `attachDaemon`
   * used to do inline.
   *
   * `principal` is the transport-resolved MACHINE principal (ADR 3 D7). Every
   * write these steps make is a daemon-class observation attributed to that
   * machine — never to a person, and with no on-behalf-of (ADR 1's daemon writer
   * class; `docs/multi-user-readiness.md` §3.1.6 S5).
   */
  onAttached(principal: MachinePrincipal): void {
    const machineId = principal.machine

    // Re-arm queued-send delivery for this machine's sessions: their earlier drain
    // attempts parked while the daemon was away (single-flight + liveness wait make
    // this safe to fire eagerly; reattached sessions also re-trigger via 'bind').
    for (const s of this.ports.sessions()) {
      if (s.machineId === machineId && s.queuedMessageCount > 0) {
        this.ports.drainInbox(s.sessionId)
      }
    }

    // Attach trigger (transcript-mirror spec §2.3): catch-up sweep after server/daemon
    // downtime — re-enqueue this machine's unmirrored segments. No-op without a lake dir.
    this.ports.triggerLakeSweep(machineId)

    // A freshly-(re)connected daemon knows no session's relay priority. Clear the
    // delta cache so every current session re-sends as a change, then push the full
    // map — otherwise a daemon restart would leave the scheduler at its default
    // until the next viewState/attach happened to flip a session.
    this.ports.resetPriorities()
    this.ports.pushPriorities()

    // Archived survivors are never rebound — archive means stopped (POD-108).
    // Rows archived before archive learned to kill, or archived while this
    // machine's daemon was away, are still 'live'/'reconnecting' here; parking
    // them sends the kill now that a daemon can receive it. MUST run BEFORE the
    // probe fan-out below so an archived 'reconnecting' row is parked, not
    // reattached.
    for (const s of this.ports.sessions()) {
      if (s.machineId === machineId && !s.headless && s.archived) {
        this.ports.parkArchivedSession(s.sessionId)
      }
    }

    // Re-bind survivor sessions ON THIS MACHINE. 'reconnecting' = was live/starting
    // at boot. 'exited' (not archived) is also probed because a row can be wrongly
    // 'exited': its attach client died on a daemon restart while the master + agent
    // survived in their scope. The durable host, not the persisted row, is the
    // source of truth for liveness.
    //
    // View-priority first, then most-recently-used: the daemon gates its spawn
    // fan-out, so the order we send in decides who reattaches soonest. A session a
    // connected client is focused on must come back typable before the long
    // unwatched tail (POD-612); within a tier, lastActiveAt is an ISO string, so a
    // reverse lexical sort is newest-first.
    const probes = [...this.ports.sessions()].filter(
      (s) =>
        s.machineId === machineId &&
        !s.headless &&
        (s.status === 'reconnecting' || (s.status === 'exited' && !s.archived)),
    )
    const viewTiers = this.ports.viewTiers(probes.map((s) => s.sessionId))
    probes.sort(
      (a, b) =>
        (viewTiers.get(a.sessionId) ?? 3) - (viewTiers.get(b.sessionId) ?? 3) ||
        (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''),
    )
    for (const s of probes) {
      this.ports.toMachine(machineId, this.ports.reattachMessage(s, machineId))
    }

    // Headless sessions have no PTY to reattach; instead re-establish their
    // daemon-side transcript tails (fire-and-forget — re-issued on every daemon
    // connect, so a missed bind self-heals on the next attach).
    for (const s of this.ports.sessions()) {
      if (s.machineId !== machineId || !s.headless || !s.resume?.value) continue
      this.ports.rebindHeadless(s)
    }
  }

  /**
   * That machine's daemon went away — the SESSION half of `detachDaemon`. The
   * superseded-socket guard, the `machine.disconnected` emit and the machine
   * broadcast are the gateway's; this runs only once the gateway has decided the
   * detach is real, in the same position it occupied before.
   */
  onDetached(principal: MachinePrincipal): void {
    const machineId = principal.machine
    // The daemon that held THIS machine's sessions' PTY bridges is gone (daemon
    // restart/crash; durable masters survive in their own scopes). Drop only THIS
    // machine's live/starting sessions to 'reconnecting' so the next daemon to attach
    // re-binds them — onAttached only probes 'reconnecting'/'exited'. Sessions on
    // OTHER machines are untouched. Without this a daemon-only restart leaves sessions
    // 'live' but unattached: the server never re-asks and they orphan until a server
    // restart.
    const changed: Session[] = []
    for (const s of this.ports.sessions()) {
      if (s.machineId !== machineId) continue
      // Headless sessions stay 'live' across daemon restarts — no PTY bridge to
      // lose; their tails re-establish via rebindHeadless on the next attach.
      if (s.headless) continue
      if (s.markReconnecting()) changed.push(s)
    }
    if (changed.length > 0) {
      for (const session of changed)
        this.ports.markVolatileSessionDirty(session.sessionId, ['status'])
      this.ports.broadcastSessions()
    }
  }
}
