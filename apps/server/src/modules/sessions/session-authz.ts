/**
 * Session apply-time authorization and ownership (POD-1396).
 * Queued-input authorize-at-apply, drive gate, machine use, session owner.
 * Dispose: none.
 */


import { createLogger, describeError } from '@podium/logger'
import type { SessionId, UserId } from '@podium/model'
import { asSessionId, asUserId, firstAdminMemberId } from '@podium/model'
import {
  type CommandPrincipal,
  resolvePrincipalAsync,
  userCommandPrincipal,
} from '../../command-principal'
import type { ClientPrincipal } from '../../gateway/client-principal'
import type { Capability } from '../../issue-authz'
import { machineUseDecision, ownershipSnapshotFromMachines } from '../../machine-access'
import { spawnedByParentSessionId } from '@podium/model'
import { granteesOf } from './session-state/grantees'
import type { SessionStore } from '../../store'
import type { SessionLifecycleDeps } from './session-lifecycle-types'
import type { SessionAccessDeps } from './session-access'
import { SUPERAGENT_AGENT_IDENTITY } from '../messages/types'
import { type InboxPrincipalReference, inboxPrincipalFromCommand } from './inbox'
import { assertMayCommandSession, resolveSessionTarget } from './session-access'
import type { Session } from './session'
import type { SessionOwnerMemo } from './session-state/service'

const log = createLogger('server:session-authz')

/** Derive database signatures from the store so async changes reach every read. */
export interface SessionAuthzStorePort {
  readonly users: Pick<SessionStore['users'], 'get' | 'roleOf' | 'earliestAdmin'>
  readonly sessions: Pick<SessionStore['sessions'], 'getSession'>
  readonly issues: Pick<SessionStore['issues'], 'getIssue' | 'getIssues'>
  readonly grants: Pick<SessionStore['grants'], 'listForResource' | 'listForResources'>
}

export interface SessionAuthzPorts {
  clientControl: import('./client-control').SessionClientControl
  deps: Pick<SessionLifecycleDeps, 'issueAccess' | 'authorizeQueuedMessage'>
  sessionById: SessionAccessDeps['sessionById']
  machines: import('../../machine-access').AsyncMachineRowSource
  /** Complete session registry, including parked sessions; the same map the
   * view projects. A missing id may still be resolved from durable storage. */
  sessions: { get(sessionId: SessionId): Session | undefined }
  store: SessionAuthzStorePort
}

export class SessionAuthz {
  constructor(private readonly ports: SessionAuthzPorts) {}

  async authorizeQueuedInputAtApply(input: {
    sessionId: SessionId
    principal: InboxPrincipalReference
    sourceMessageId: string | null
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const refused = { ok: false, reason: 'session no longer exists' } as const
    const target = this.ports.sessions.get(input.sessionId)
    const ownership = await this.sessionOwner(input.sessionId)
    if (!target || !ownership) return refused

    if (input.sourceMessageId) {
      const authorization: Promise<import('./inbox').InboxAuthorizationDecision> | undefined =
        this.ports.deps.authorizeQueuedMessage?.(input.sourceMessageId)
      const source = await authorization
      if (source && !source.ok) return source
    }

    if (input.principal.kind === 'system') return { ok: true }

    let principal: CommandPrincipal
    if (input.principal.kind === 'user') {
      const user = asUserId(input.principal.principalRef)
      if (
        !(await this.ports.store.users.get(user)) ||
        input.principal.attribution.actor.kind !== 'user' ||
        input.principal.attribution.actor.id !== user ||
        input.principal.attribution.onBehalfOf !== user
      ) {
        return refused
      }
      const role = await this.ports.store.users.roleOf(user)
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
        delegated = await resolvePrincipalAsync(await this.capabilityForSession(actorSessionId), {
          parentSessionOf: async (sessionId) =>
            spawnedByParentSessionId((await this.ports.sessionById(sessionId))?.spawnedBy),
          onBehalfOfFor: async (sessionId) => (await this.sessionOwner(sessionId))?.owner ?? undefined,
        })
      } catch {
        return refused
      }
      principal = delegated
      if (
        principal.kind !== 'agent' ||
        !(await this.ports.store.users.get(principal.onBehalfOf)) ||
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
      machineUseDecision(
        principal,
        target.machineId,
        await ownershipSnapshotFromMachines(this.ports.machines),
      ) !==
      'granted'
    ) {
      return refused
    }

    // Every apply — including outbox replay — re-runs the session gate against
    // CURRENT rights. The source message proves intent and ordering, never rights.
    const access = {
      sessionById: (sessionId: SessionId) => this.ports.sessionById(sessionId),
      issues: this.ports.deps.issueAccess,
      visibility: () => true,
    }
    const resolved = await resolveSessionTarget(principal, input.sessionId, access)
    if (resolved.kind === 'absent') return refused
    /**
     * RIGHTS ARE RE-CHECKED; THE SCOPE CONFIRMATION IS NOT RE-ASKED (POD-3226).
     *
     * `assertMayCommandSession` carries two different answers. `forbidden` is a
     * rights boundary (a viewer role, an issueless target that only its parent
     * or the operator may command) and D8 says a row that lost its rights is
     * rejected — so that half still runs here. `confirm-required` is ADR 3 D2's
     * scope-crossing footgun guard: the sender may always satisfy it, and the
     * gate that ACCEPTED this row already did (`--outside-scope` on a command
     * send, or a mail rule that never asks — a worker replying to its
     * coordinator on the parent issue, `issue mail send` to any visible box).
     * A queued row carries no confirmation envelope, so re-asking here could
     * only refuse what was already allowed. It did: a worker's reply to its
     * coordinator died whenever the coordinator was busy or had a queued row,
     * and landed whenever it was idle, because only the queued path re-asks.
     * `overrideScope` answers the confirmation the send gate already took. It
     * is applied to EVERY queued row, not only mail: every producer of an
     * agent row (command send, mail send/reply, issue mail, wake) ran its own
     * scope policy before the row existed, and none of them can re-present a
     * confirmation here.
     *
     * A refusal on a target that EXISTS and passed the owner, grant and
     * machine checks above names its rule. Those checks are the collapse that
     * protects the existence oracle (`visibility` is unconditional at this
     * site); past them the target has nothing left to hide, and "session no
     * longer exists" sent two agents hunting for a coordinator that was alive.
     */
    try {
      await assertMayCommandSession(principal, resolved.session, 'sessions.sendText', access, true)
    } catch (error) {
      const detail = describeError(error)
      return { ok: false, reason: `not authorized: ${detail}` }
    }
    return { ok: true }
  }


  /**
   * Machine `use` for a browser principal against the session's host
   * (POD-1081 §4). Independent of session grants — share is not a back door.
   */
  async machineUseForClient(
    principal: ClientPrincipal,
    sessionId: SessionId,
  ): Promise<'granted' | 'denied' | 'absent'> {
    const session =
      this.ports.sessions.get(sessionId) ??
      (await this.ports.store.sessions.getSession(sessionId))
    if (!session) return 'absent'
    const command = userCommandPrincipal(asUserId(principal.user), principal.role)
    const ownership = await ownershipSnapshotFromMachines(this.ports.machines)
    // machineUseDecision collapses absent+denied to 'denied' when the principal
    // cannot see the machine; attach maps both to terminalOutcome unauthorized.
    return machineUseDecision(command, session.machineId, ownership) === 'granted'
      ? 'granted'
      : 'denied'
  }

  /** Live drive gate for requestControl / controller input (POD-1081 §3). */
  authorizeClientDrive(principal: ClientPrincipal, sessionId: SessionId): Promise<boolean> {
    return this.ports.clientControl.authorizeDrive(principal, sessionId)
  }

  /** Set (replace) a session's agent action offer [spec:SP-c7f1]. A subsequent
   *  offer replaces the previous one. Persisted in the `offers` table (off-row,
   *  like snooze) and broadcast so every client's chat bar updates. */

  /** The capability a relayed agent session presents: worker, scoped to the issue whose
   *  worktree it runs in (subtree), else 'none' (may read + create, but writing an existing
   *  issue needs --outside-scope). Unknown session → most-restricted. */
  async capabilityForSession(sessionId: SessionId): Promise<Capability> {
    const s = this.ports.sessions.get(sessionId)
    if (!s) return { role: 'worker', scope: { kind: 'none' } }
    const attribution = { onBehalfOf: s.ownerUserId }
    // Explicit attachment wins over cwd containment (issue-as-workspace): an
    // attached / draft-bound session is scoped to ITS issue even when its cwd
    // sits in another issue's worktree (or none).
    const issueId = s.issueId ?? await this.ports.deps.issueAccess.issueForCwd(s.cwd)
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
   * THE OWNER of a session: the human who STARTED it (B1, PDM-133).
   *
   * `undefined` means the session does not exist — which the session-state envelope
   * treats identically to a denial (§3.1.5's consistent-error rule).
   *
   * ---------------------------------------------------------------------------
   * THE ATTACHED ISSUE NO LONGER DECIDES, AND THAT IS THE WHOLE CHANGE
   * ---------------------------------------------------------------------------
   *
   * This used to read `memoIssueOwner(issueId) ?? durable.ownerUserId`: the owner
   * of the ATTACHED ISSUE outranked the session's own durable owner, and issue
   * grants — not session grants — decided who else got in. Under one account both
   * answers named the same person, so the precedence was invisible. With two
   * accounts it is the private-execution boundary itself:
   *
   *   - Bob starts an agent on Alice's task. The row says Bob. The old answer
   *     said Alice, so Alice could read, drive and resume Bob's run (MU-07/08).
   *   - Reassigning a task to Carol moved every private session on it to Carol,
   *     because the session's authority was a lookup THROUGH the issue rather
   *     than a fact ON the session.
   *
   * The accepted architecture says the opposite on both counts: a private run
   * keeps its initiating human after task reassignment, and reassignment never
   * transfers session rights (execution charter, product contract). So authority
   * is now the durable row, full stop, and an unowned row is `undefined` rather
   * than a fallback to somebody plausible.
   *
   * DELEGATION IS NOT AN EXCEPTION TO THIS. An agent reaches its human through
   * `resolvePrincipalAsync`'s `onBehalfOf` chain and is compared against this
   * owner; it never widens the ceiling, which is why nothing here consults a
   * capability.
   *
   * GRANTS ARE INACTIVE HISTORY (B1 requirement 4). The rows stay in the store —
   * nothing is deleted and no migration runs — but they no longer confer access
   * to a session, so this returns an empty list rather than reading them. Session
   * SHARING is deferred out of v1 by the charter; resurrecting it means deciding
   * a verb model, not re-enabling a lookup. The empty array is deliberate and
   * load-bearing: `mayReadOwned` and `contextFromOwnership` both take `grants`,
   * and handing them the old issue-derived list is exactly the leak above.
   */
  async sessionOwner(
    sessionId: SessionId,
    /**
     * Per-pass read-through memo [POD-1618]. RETAINED, and no longer consulted
     * HERE: it existed to batch the issue-row and grant-edge reads this function
     * just stopped making, and a durable-row read is the only lookup left. The
     * parameter stays because `SessionStateService` and the lifecycle port pass
     * it positionally and `primeOwnerMemo` still fills it for the projection
     * pass; removing it is a cross-module signature change that belongs with the
     * memo's own retirement, filed beneath PDM-139 rather than smuggled in here.
     */
    _memo?: SessionOwnerMemo,
  ): Promise<{ owner: UserId; grants: string[] } | undefined> {
    const durable = this.ports.sessions.get(sessionId) ?? await this.storedOwnershipRecord(sessionId)
    if (!durable) return undefined
    const owner = durable.ownerUserId
    if (!owner) return undefined
    return { owner, grants: [] }
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
  async primeOwnerMemo(memo: SessionOwnerMemo, sessionIds: readonly SessionId[]): Promise<void> {
    const byKind = new Map<string, Set<string>>()
    const issueIds = new Set<string>()
    for (const sessionId of sessionIds) {
      const durable = this.ports.sessions.get(sessionId) ?? await this.storedOwnershipRecord(sessionId)
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
      const found = await this.ports.store.issues.getIssues(wantedIssues)
      for (const id of wantedIssues) memo.issues.set(id, found.get(id) ?? null)
    }
    for (const [kind, ids] of byKind) {
      const wanted = [...ids].filter((id) => !memo.grants.has(`${kind}:${id}`))
      if (wanted.length === 0) continue
      const found = await this.ports.store.grants.listForResources(kind, wanted)
      for (const id of wanted) {
        memo.grants.set(`${kind}:${id}`, granteesOf(found.get(id) ?? []))
      }
    }
  }

  private async storedOwnershipRecord(sessionId: SessionId) {
    log.debug('session ownership registry miss; reading durable row', { sessionId })
    return this.ports.store.sessions.getSession(sessionId)
  }

  // `memoIssueOwner` and `memoGrantees` lived here. They were the read-through
  // halves of the ownership memo, and `sessionOwner` was their only caller; with
  // the issue-owner precedence and the grant lookup gone (B1, PDM-133) they had
  // no remaining call site. Deleted rather than left unreferenced: an unused
  // private that still knows how to answer "who owns this, via the issue" is the
  // next refactor's temptation to call it again.

  /**
   * Machine `use` for a browser principal against the session's host
   * (POD-1081 §4). Independent of session grants — share is not a back door.
   */

  /**
   * Server-stamped inbox identity for an authenticated capability. The
   * delegation chain and owning human are read from live session rows each time;
   * callers receive only the opaque reference that the inbox persists.
   */
  async inboxPrincipalForCapability(capability: Capability): Promise<InboxPrincipalReference> {
    return inboxPrincipalFromCommand(
      await resolvePrincipalAsync(capability, {
        parentSessionOf: (sessionId) =>
          spawnedByParentSessionId(this.ports.sessions.get(sessionId)?.spawnedBy),
        onBehalfOfFor: async (sessionId) => (await this.sessionOwner(sessionId))?.owner ?? undefined,
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
   * defaults rather than anyone's choices. `firstAdminMemberId()` is spelled out
   * here for the reason `IssueService.broadcastViewer` spells it out: this
   * build's transport authenticates one shared password, so the sole account is
   * the only true answer — and POD-315 replaces this body with the requesting
   * principal, with every caller already asking the question.
   */
  async settingsViewer(): Promise<UserId> {
    return (await firstAdminMemberId(this.ports.store))
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
