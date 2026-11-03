import { spanOpen } from '../../store/executor/executor'
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
  onBehalfOfUser,
  resolvePrincipalAsync,
  userCommandPrincipal,
} from '../../command-principal'
import type { ClientPrincipal } from '../../gateway/client-principal'
import { type Capability, mayReachPrivate } from '../../issue-authz'
import { machineUseDecision, ownershipSnapshotFromMachines } from '../../machine-access'
import { spawnedByParentSessionId } from '@podium/model'
import type { SessionStore } from '../../store'
import type { SessionRecords } from './records'
import type { SessionLifecycleDeps } from './session-lifecycle-types'
import type { SessionAccessDeps } from './session-access'
import { SUPERAGENT_AGENT_IDENTITY } from '../messages/types'
import { type InboxPrincipalReference, inboxPrincipalFromCommand } from './inbox'
import {
  ambiguousSessionPrefixMessage,
  assertMayCommandSession,
  resolveSessionTarget,
} from './session-access'
import type { Session } from './session'
import type { SessionOwnerFacts, SessionOwnerMemo } from './session-state/service'

const log = createLogger('server:session-authz')

/** Derive database signatures from the store so async changes reach every read. */
export interface SessionAuthzStorePort {
  readonly users: Pick<SessionStore['users'], 'get' | 'roleOf' | 'earliestAdmin'>
  readonly sessions: Pick<SessionStore['sessions'], 'loadSession' | 'getSessions'>
}

export interface SessionAuthzPorts {
  clientControl: import('./client-control').SessionClientControl
  deps: Pick<SessionLifecycleDeps, 'issueAccess' | 'authorizeQueuedMessage'>
  sessionById: SessionAccessDeps['sessionById']
  machines: import('../../machine-access').AsyncMachineRowSource
  /** Complete session registry, including parked sessions; the same map the
   * view projects. A missing id may still be resolved from durable storage. */
  sessions: { get(sessionId: SessionId): Session | undefined }
  /** Who a session acts for, read from the database where it is not resident
   *  (POD-6160): one row read per operation, never the whole map. */
  records: Pick<SessionRecords, 'ownershipOf'>
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
    const target = await this.ports.records.ownershipOf(input.sessionId, 'queuedInputAtApply')
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

    // Private (design §2.3): only the session's own human may queue input into
    // it. A grant on it, or on the task it sits on, carries nothing.
    if (ownership.owner !== (principal.kind === 'user' ? principal.user : principal.onBehalfOf)) {
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
      ownerOf: async (sessionId: SessionId) => (await this.sessionOwner(sessionId))?.owner,
      issues: this.ports.deps.issueAccess,
    }
    const resolved = await resolveSessionTarget(principal, input.sessionId, access)
    if (resolved.kind === 'absent') return refused
    if (resolved.kind === 'ambiguous') {
      return {
        ok: false,
        reason: ambiguousSessionPrefixMessage(resolved.prefix, resolved.candidates),
      } as const
    }
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
     * A refusal on a target that EXISTS and passed the owner and machine
     * checks above names its rule. Those checks are the collapse that protects
     * the existence oracle; past them the target has nothing left to hide, and "session no
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
      (await this.ports.store.sessions.loadSession(sessionId))
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
    const s = await this.ports.records.ownershipOf(sessionId, 'capability')
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
   * THE OWNER of a session: the person who started it, or on whose behalf an
   * agent started it (design §2.3, POD-6283). Sessions are private, so this is
   * the whole authorization fact: no task owner stands in for it and no grant
   * widens it. A session on Alice's task that Bob started is Bob's.
   *
   * `undefined` means the session does not exist or has no owner, which every
   * caller treats exactly as a denial (§3.1.5's consistent-error rule).
   */
  async sessionOwner(
    sessionId: SessionId,
    /** Per-pass read-through memo [POD-1618]. Absent = read the row, the
     *  behaviour every single-session caller keeps. */
    memo?: SessionOwnerMemo,
  ): Promise<{ owner: UserId } | undefined> {
    const owner = (await this.ownershipOf(sessionId, memo))?.ownerUserId
    return owner ? { owner } : undefined
  }

  /**
   * MAY THE CALLER BEHIND `capability` REACH THIS SESSION (design §2.3)? Only
   * when its human (the person, or the root of an agent's delegation chain,
   * read live) owns it. The one answer for paths that take a capability rather
   * than a resolved principal: relayed session reads and stops, and delivering
   * an answer to an agent's question. An unresolvable caller reaches nothing.
   */
  async mayReachSession(capability: Capability, sessionId: SessionId): Promise<boolean> {
    let human: UserId | null
    try {
      human = onBehalfOfUser(
        await resolvePrincipalAsync(capability, {
          parentSessionOf: async (id) =>
            spawnedByParentSessionId((await this.ports.records.ownershipOf(id, 'capability'))?.spawnedBy),
          onBehalfOfFor: async (id) => (await this.sessionOwner(id))?.owner,
        }),
      )
    } catch {
      return false
    }
    return mayReachPrivate(human, { id: sessionId, owner: (await this.sessionOwner(sessionId))?.owner })
  }

  /**
   * Fill a pass's memo with the rows of the sessions that are not in memory, in
   * one batched read (POD-6160: a parked session is not in memory), so a
   * full-list pass asks the database once rather than once per session.
   * A MISSING id is recorded as `null`, because `ownershipOf` reads a miss in the
   * memo as "not looked up yet" and would query it again.
   */
  async primeOwnerMemo(memo: SessionOwnerMemo, sessionIds: readonly SessionId[]): Promise<void> {
    // A memo prepared before an in-span write is not an authority fact.
    if (spanOpen()) memo.sessions?.clear()
    const missing = sessionIds.filter((id) => this.ports.sessions.get(id) === undefined && !memo.sessions?.has(id))
    if (missing.length === 0) return
    const rows = await this.ports.store.sessions.getSessions(missing)
    const owners = (memo.sessions ??= new Map())
    for (const id of missing) owners.set(id, rows.get(id) ?? null)
  }

  /** A session's owner and issue: in memory, else the pass's memo, else its row. */
  private async ownershipOf(sessionId: SessionId, memo?: SessionOwnerMemo): Promise<SessionOwnerFacts | undefined> {
    const resident = this.ports.sessions.get(sessionId)
    if (resident) return resident
    const memoised = memo?.sessions?.get(sessionId)
    if (memoised !== undefined) return memoised ?? undefined
    return await this.storedOwnershipRecord(sessionId)
  }

  /** Through the operation's session loader (POD-6210): the lease that restores
   *  a parked session for the write this check admits reuses the row. */
  private async storedOwnershipRecord(sessionId: SessionId) {
    log.debug('session ownership registry miss; reading durable row', { sessionId })
    return this.ports.store.sessions.loadSession(sessionId)
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
  async inboxPrincipalForCapability(capability: Capability): Promise<InboxPrincipalReference> {
    return inboxPrincipalFromCommand(
      await resolvePrincipalAsync(capability, {
        parentSessionOf: async (sessionId) =>
          spawnedByParentSessionId((await this.ports.records.ownershipOf(sessionId, 'inboxPrincipal'))?.spawnedBy),
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
