/**
 * Session apply-time authorization and ownership (POD-1396).
 * Queued-input authorize-at-apply, drive gate, machine use, session owner.
 * Dispose: none.
 */


import type { SessionId, UserId } from '@podium/model'
import { asSessionId, asUserId, FIRST_ADMIN_USER_ID } from '@podium/model'
import {
  type CommandPrincipal,
  resolvePrincipal,
  userCommandPrincipal,
} from '../../command-principal'
import type { ClientPrincipal } from '../../gateway/client-principal'
import type { Capability } from '../../issue-authz'
import { machineUseDecision, ownershipFromMachines } from '../../machine-access'
import { sessionSpawnerParentId } from '../../steward'
import type { GrantRow } from '../../store/grants'
import { type InboxPrincipalReference, inboxPrincipalFromCommand } from './inbox'
import { assertMayCommandSession, resolveSessionTarget } from './session-access'
import type { Session } from './session'

export interface SessionAuthzPorts {
  clientControl: any
  deps: any
  listSessions: any
  machines: any
  sessions: any
  store: any
}

export class SessionAuthz {
  constructor(private readonly ports: SessionAuthzPorts) {}

  authorizeQueuedInputAtApply(input: {
    sessionId: SessionId
    principal: InboxPrincipalReference
    sourceMessageId: string | null
  }): { ok: true } | { ok: false; reason: string } {
    const refused = { ok: false, reason: 'session no longer exists' } as const
    const target = this.ports.sessions.get(input.sessionId)
    const ownership = this.sessionOwner(input.sessionId)
    if (!target || !ownership) return refused

    if (input.sourceMessageId) {
      const source = this.ports.deps.authorizeQueuedMessage?.(input.sourceMessageId)
      if (source && !source.ok) return source
    }

    if (input.principal.kind === 'system') return { ok: true }

    let principal: CommandPrincipal
    if (input.principal.kind === 'user') {
      const user = asUserId(input.principal.principalRef)
      if (
        !this.ports.store.users.get(user) ||
        input.principal.attribution.actor.kind !== 'user' ||
        input.principal.attribution.actor.id !== user ||
        input.principal.attribution.onBehalfOf !== user
      ) {
        return refused
      }
      const role = this.ports.store.users.roleOf(user)
      if (!role) return refused
      principal = userCommandPrincipal(user, role)
    } else {
      const actorSessionId = asSessionId(input.principal.principalRef)
      if (
        String(input.principal.delegation) !== actorSessionId ||
        input.principal.attribution.actor.kind !== 'agent' ||
        String(input.principal.attribution.actor.id) !== actorSessionId
      ) {
        return refused
      }
      principal = resolvePrincipal(this.capabilityForSession(actorSessionId), {
        parentSessionOf: (sessionId) =>
          sessionSpawnerParentId(this.ports.sessions.get(sessionId)?.spawnedBy),
        onBehalfOfFor: (sessionId) => this.sessionOwner(sessionId)?.owner ?? undefined,
      })
      if (
        principal.kind !== 'agent' ||
        !this.ports.store.users.get(principal.onBehalfOf) ||
        principal.onBehalfOf !== input.principal.attribution.onBehalfOf
      ) {
        return refused
      }
    }

    if (
      ownership.owner !== (principal.kind === 'user' ? principal.user : principal.onBehalfOf) &&
      !ownership.grants.includes(principal.kind === 'user' ? principal.user : principal.onBehalfOf)
    ) {
      return refused
    }
    if (
      machineUseDecision(principal, target.machineId, ownershipFromMachines(this.ports.machines)) !==
      'granted'
    ) {
      return refused
    }

    // Every apply — including outbox replay — re-runs the ordinary session
    // scope gate. The source message proves intent and ordering, never rights.
    const access = {
      listSessions: () => this.ports.listSessions(),
      issues: this.ports.deps.issueAccess,
      visibility: () => true,
    }
    const resolved = resolveSessionTarget(principal, input.sessionId, access)
    if (resolved.kind === 'absent') return refused
    try {
      assertMayCommandSession(principal, resolved.session, 'sessions.sendText', access)
    } catch {
      return refused
    }
    return { ok: true }
  }


  /**
   * Machine `use` for a browser principal against the session's host
   * (POD-1081 §4). Independent of session grants — share is not a back door.
   */
  machineUseForClient(
    principal: ClientPrincipal,
    sessionId: SessionId,
  ): 'granted' | 'denied' | 'absent' {
    const session = this.ports.sessions.get(sessionId) ?? this.ports.store.sessions.getSession(sessionId)
    if (!session) return 'absent'
    const command = userCommandPrincipal(asUserId(principal.user), principal.role)
    const ownership = ownershipFromMachines(this.ports.machines)
    // machineUseDecision collapses absent+denied to 'denied' when the principal
    // cannot see the machine; attach maps both to terminalOutcome unauthorized.
    return machineUseDecision(command, session.machineId, ownership) === 'granted'
      ? 'granted'
      : 'denied'
  }

  /** Live drive gate for requestControl / controller input (POD-1081 §3). */
  authorizeClientDrive(principal: ClientPrincipal, sessionId: SessionId): boolean {
    return this.ports.clientControl.authorizeDrive(principal, sessionId)
  }

  /** Set (replace) a session's agent action offer [spec:SP-c7f1]. A subsequent
   *  offer replaces the previous one. Persisted in the `offers` table (off-row,
   *  like snooze) and broadcast so every client's chat bar updates. */

  /** The capability a relayed agent session presents: worker, scoped to the issue whose
   *  worktree it runs in (subtree), else 'none' (may read + create, but writing an existing
   *  issue needs --outside-scope). Unknown session → most-restricted. */
  capabilityForSession(sessionId: SessionId): Capability {
    const s = this.ports.sessions.get(sessionId)
    if (!s) return { role: 'worker', scope: { kind: 'none' } }
    const attribution = { onBehalfOf: s.ownerUserId }
    // Explicit attachment wins over cwd containment (issue-as-workspace): an
    // attached / draft-bound session is scoped to ITS issue even when its cwd
    // sits in another issue's worktree (or none).
    const issueId = s.issueId ?? this.ports.deps.issueAccess.issueForCwd(s.cwd)
    return issueId
      ? {
          role: 'worker',
          scope: { kind: 'subtree', rootId: issueId },
          actorSessionId: sessionId,
          ...attribution,
        }
      : { role: 'worker', scope: { kind: 'none' }, actorSessionId: sessionId, ...attribution }
  }

  /**
   * Server-stamped inbox identity for an authenticated capability. The
   * delegation chain and owning human are read from live session rows each time;
   * callers receive only the opaque reference that the inbox persists.
   */

  /**
   * OWNER + GRANTS of a session, for the owner-or-grant policy (POD-380).
   *
   * `undefined` means the session does not exist — which the session-state envelope
   * treats identically to a denial (§3.1.5's consistent-error rule).
   *
   * Session rows still have no `owner` column, so existing sessions use
   * the instance's first-admin identity as a transitional owner. This is the ONE place
   * that answer is given; POD-1070 ownership work replaces it here rather than
   * in eleven handlers.
   */
  sessionOwner(sessionId: SessionId): { owner: UserId; grants: string[] } | undefined {
    const live = this.ports.sessions.get(sessionId)
    const durable = live ?? this.ports.store.sessions.getSession(sessionId)
    if (!durable) return undefined
    const issueId = durable.issueId ?? undefined
    const resourceKind = issueId ? 'issue' : 'session'
    const resourceId = issueId ?? sessionId
    const parentOwner = issueId
      ? (this.ports.store.issues.getIssue(issueId)?.ownerUserId ?? durable.ownerUserId)
      : durable.ownerUserId
    if (!parentOwner) return undefined
    const grants = [
      ...new Set(
        (this.ports.store.grants.listForResource(resourceKind, resourceId) as GrantRow[])
          .filter((edge) => edge.verb === 'read' || edge.verb === 'write' || edge.verb === 'manage')
          .map((edge) => edge.grantee),
      ),
    ]
    return { owner: parentOwner, grants }
  }

  /**
   * Machine `use` for a browser principal against the session's host
   * (POD-1081 §4). Independent of session grants — share is not a back door.
   */

  /**
   * Server-stamped inbox identity for an authenticated capability. The
   * delegation chain and owning human are read from live session rows each time;
   * callers receive only the opaque reference that the inbox persists.
   */
  inboxPrincipalForCapability(capability: Capability): InboxPrincipalReference {
    return inboxPrincipalFromCommand(
      resolvePrincipal(capability, {
        parentSessionOf: (sessionId) =>
          sessionSpawnerParentId(this.ports.sessions.get(sessionId)?.spawnedBy),
        onBehalfOfFor: (sessionId) => this.sessionOwner(sessionId)?.owner ?? undefined,
      }),
    )
  }

  /** In-process agent identity; absence fails closed instead of inventing one. */

  /**
   * Model + effort flags for a spawn message; 'auto' means no override.
   * Shared by every spawn path (fresh spawn AND resurrect) so a resumed session
   * keeps the configured model when it uses the configured coding harness.
   * `override` (from an issue's per-ticket model/effort) wins independently over
   * settings defaults — 'auto' inherits them for the configured coding harness
   * and means "no flag" for any other harness. Missing values follow the same
   * rule; selecting a different harness must not inherit that harness's model or effort
   * [spec:SP-7ff1].
   */
  /**
   * WHOSE PREFERENCES A SESSION-SPAWNING READ USES (POD-1213).
   *
   * `roles.*` and `autoContinue.*` are `preferences-personal` and live on
   * `user_preferences` now, so a read of the instance blob would see the model's
   * defaults rather than anyone's choices. `FIRST_ADMIN_USER_ID` is spelled out
   * here for the reason `IssueService.broadcastViewer` spells it out: this
   * build's transport authenticates one shared password, so the sole account is
   * the only true answer — and POD-315 replaces this body with the requesting
   * principal, with every caller already asking the question.
   */
  settingsViewer(): UserId {
    return FIRST_ADMIN_USER_ID
  }

  // ---- the sessions FEATURE PORT for client frames (gateway/client-mux.ts) ----
  /**
   * A client connection was admitted: send it the world it is owed.
   *
   * This used to be the tail of `attachClient`, which also minted the id,
   * registered the socket and sent `welcome`. Those are the gateway's now
   * (POD-390) and this is what remains: the session/issue/conversation/machine
   * bootstrap, byte-for-byte and in the same order.
   *
   * The `principal` is carried, not consulted — the bootstrap is NOT scoped by it
   * today (the publication AUTHORITY is what narrows a scoped socket, exactly as
   * before). POD-1077 is where a principal starts deciding content.
   */
}
