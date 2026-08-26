/**
 * Session apply-time authorization and ownership (POD-1396).
 * Queued-input authorize-at-apply, drive gate, machine use, session owner.
 * Dispose: none.
 */


import type { SessionId, UserId, IssueId } from '@podium/model'
import { asSessionId, asUserId, FIRST_ADMIN_USER_ID } from '@podium/model'
import {
  type CommandPrincipal,
  resolvePrincipal,
  userCommandPrincipal,
} from '../../command-principal'
import type { ClientPrincipal } from '../../gateway/client-principal'
import type { Capability } from '../../issue-authz'
import { machineUseDecision, ownershipFromMachines } from '../../machine-access'
import { spawnedByParentSessionId } from '@podium/model'
import type { GrantRow } from '../../store/grants'
import { SUPERAGENT_AGENT_IDENTITY } from '../messages/types'
import { type InboxPrincipalReference, inboxPrincipalFromCommand } from './inbox'
import { assertMayCommandSession, resolveSessionTarget } from './session-access'
import type { Session } from './session'
import type { SessionOwnerMemo } from './session-state/service'

export interface SessionAuthzPorts {
  clientControl: any
  deps: any
  listSessions: any
  sessionById: any
  machines: any
  sessions: any
  store: any
}

/**
 * The grantees a set of edges confers READ-or-better on — the ONE definition
 * [POD-1653].
 *
 * It is a free function because two paths now need it: the per-resource read
 * and the batched prime. A verb set spelled twice is the shape where a later
 * verb addition lands on one path only, and the failure would be silent and
 * security-relevant (a grantee visible through one path, invisible through the
 * other, depending purely on whether a pass primed).
 */
function granteesOf(edges: readonly GrantRow[]): string[] {
  return [
    ...new Set(
      edges
        .filter((edge) => edge.verb === 'read' || edge.verb === 'write' || edge.verb === 'manage')
        .map((edge) => edge.grantee),
    ),
  ]
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
      /**
       * THE SUPERAGENT IS NOT A DELEGATED SESSION (POD-2838).
       *
       * It is an in-process server job with no transport row, and it sends mail
       * under a LITERAL agent identity — `SUPERAGENT_AGENT_IDENTITY`, never a
       * session id. Resolving it through `capabilityForSession` is a category
       * error: there is no session, so the empty capability comes back and
       * `resolvePrincipal` reads it as a HUMAN capability and throws.
       *
       * So it is admitted here, where the `kind: 'system'` principal above is
       * already admitted, because that is the category it is in. THIS GRANTS
       * NOTHING NEW: superagent-attributed mail to an idle session is typed
       * synchronously through `sendText`/`typeText`, which consults no drain
       * gate at all — this boundary was never what stood between a forged
       * attribution and the PTY, and `messages.send`'s own acceptance of
       * caller-supplied attribution is where that question belongs. What
       * changes is only that the queued path stops CRASHING where the
       * synchronous path delivers.
       */
      if (input.principal.principalRef === SUPERAGENT_AGENT_IDENTITY) return { ok: true }
      /**
       * AND THE BOUNDARY RETURNS A VERDICT, WHATEVER HAPPENS (POD-2838).
       *
       * `resolvePrincipal` throws on two reachable inputs — a delegation naming
       * no live session, and a live session with no owner — and the throw does
       * not fail closed. It escapes `deliverNext` into `tick`, killing the drain
       * pass with the row neither delivered, nor removed, nor handed to
       * `authorization.rejected`: the exact silent loss the durable queue exists
       * to prevent, reached through the guard meant to prevent it. An
       * unresolvable principal carries no authority, so it refuses — and a
       * refusal is VISIBLE, because the caller removes the row and reports it.
       */
      let delegated: CommandPrincipal
      try {
        delegated = resolvePrincipal(this.capabilityForSession(actorSessionId), {
          parentSessionOf: (sessionId) =>
            spawnedByParentSessionId(this.ports.sessions.get(sessionId)?.spawnedBy),
          onBehalfOfFor: (sessionId) => this.sessionOwner(sessionId)?.owner ?? undefined,
        })
      } catch {
        return refused
      }
      principal = delegated
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
      sessionById: (sessionId: SessionId) => this.ports.sessionById(sessionId),
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
  sessionOwner(
    sessionId: SessionId,
    /** Per-pass read-through memo [POD-1618]. Absent = look everything up, the
     *  behaviour every single-session caller keeps. */
    memo?: SessionOwnerMemo,
  ): { owner: UserId; grants: string[] } | undefined {
    const live = this.ports.sessions.get(sessionId)
    const durable = live ?? this.ports.store.sessions.getSession(sessionId)
    if (!durable) return undefined
    const issueId = durable.issueId ?? undefined
    const resourceKind = issueId ? 'issue' : 'session'
    const resourceId = issueId ?? sessionId
    // Both lookups below repeat per session in a full-list pass and collapse to
    // a handful of distinct keys: every session on one issue asks for the SAME
    // issue row and the SAME grant edges [POD-1618].
    const parentOwner = issueId
      ? (this.memoIssueOwner(issueId, memo) ?? durable.ownerUserId)
      : durable.ownerUserId
    if (!parentOwner) return undefined
    const grants = this.memoGrantees(resourceKind, resourceId, memo)
    return { owner: parentOwner, grants }
  }

  /**
   * Fill a pass's grant memo in ONE read per resource kind [POD-1653].
   *
   * `memoGrantees` collapses repeated keys, which is everything POD-1618 needed
   * for issue-backed sessions: a hundred sessions on one issue ask one question.
   * A session with NO issue keys on its own id, so there is nothing to collapse
   * — every such session was its own statement, and on the live host ~1145 of
   * them per pass each returned zero rows. Coalescing cannot fix a set of
   * distinct keys; only asking for them together can.
   *
   * Freshness is unchanged. This runs at the START of the pass the memo belongs
   * to, reads live rows, and writes the same values `memoGrantees` would have
   * computed. A pass that primes and a pass that does not see the same edges;
   * the difference is 2 statements instead of ~1200.
   *
   * The empty array matters: a primed key with no edges must be RECORDED as
   * empty, or `memoGrantees` reads the miss as "not looked at yet" and issues
   * the per-resource query anyway — which is precisely the statement being
   * removed, and the reason this fills every requested key rather than only the
   * ones the batched read returned.
   */
  primeOwnerMemo(memo: SessionOwnerMemo, sessionIds: readonly SessionId[]): void {
    const byKind = new Map<string, Set<string>>()
    const issueIds = new Set<string>()
    for (const sessionId of sessionIds) {
      const live = this.ports.sessions.get(sessionId)
      const durable = live ?? this.ports.store.sessions.getSession(sessionId)
      if (!durable) continue
      const issueId = durable.issueId ?? undefined
      if (issueId) issueIds.add(issueId)
      const kind = issueId ? 'issue' : 'session'
      const id = issueId ?? sessionId
      const bucket = byKind.get(kind) ?? new Set<string>()
      bucket.add(id)
      byKind.set(kind, bucket)
    }
    // The issue half of the same memo. `memoIssueOwner` collapses ~1200 sessions
    // onto their distinct issues; this collapses those onto one statement. A
    // MISSING id must still be recorded — as null — because `memoIssueOwner`
    // reads a `has()` miss as "not looked up yet" and would re-query it.
    const wantedIssues = [...issueIds].filter((id) => !memo.issues.has(id))
    if (wantedIssues.length > 0) {
      const found = this.ports.store.issues.getIssues(wantedIssues)
      for (const id of wantedIssues) memo.issues.set(id, found.get(id) ?? null)
    }
    for (const [kind, ids] of byKind) {
      const wanted = [...ids].filter((id) => !memo.grants.has(`${kind}:${id}`))
      if (wanted.length === 0) continue
      const found = this.ports.store.grants.listForResources(kind, wanted)
      for (const id of wanted) {
        memo.grants.set(`${kind}:${id}`, granteesOf((found.get(id) ?? []) as GrantRow[]))
      }
    }
  }

  private memoIssueOwner(issueId: IssueId, memo?: SessionOwnerMemo): UserId | undefined {
    if (!memo) return this.ports.store.issues.getIssue(issueId)?.ownerUserId ?? undefined
    if (!memo.issues.has(issueId)) {
      memo.issues.set(issueId, this.ports.store.issues.getIssue(issueId))
    }
    return (memo.issues.get(issueId) as { ownerUserId?: UserId } | null)?.ownerUserId ?? undefined
  }

  private memoGrantees(
    resourceKind: string,
    resourceId: string,
    memo?: SessionOwnerMemo,
  ): string[] {
    const compute = (): string[] =>
      granteesOf(this.ports.store.grants.listForResource(resourceKind, resourceId) as GrantRow[])
    if (!memo) return compute()
    const key = `${resourceKind}:${resourceId}`
    const hit = memo.grants.get(key)
    if (hit !== undefined) return hit
    const value = compute()
    memo.grants.set(key, value)
    return value
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
          spawnedByParentSessionId(this.ports.sessions.get(sessionId)?.spawnedBy),
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
