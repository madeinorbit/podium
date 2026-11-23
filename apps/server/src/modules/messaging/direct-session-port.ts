/**
 * The Telegram bridge's way into sessions AS THE BOUND USER (POD-6212).
 *
 * Every verb is a dispatch of the session command plane under that user's own
 * principal, minted from their account row exactly as a web request's is — so
 * an attached chat can do what the user could do from the web and nothing more,
 * and the command plane's own gates (issue write access, machine use) decide.
 * Transcript reads go through the same reader-checked read the web uses.
 */

import { isSessionReconnecting, type SessionId, type UserId } from '@podium/model'
import { userCommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import type { SessionStore } from '../../store'
import { sessionCommandCtx } from '../sessions/command-ctx'
import { dispatchSessionCommand, type SessionCommandCtx } from '../sessions/command-plane'
import type { SessionFacts } from '../sessions/facts'
import { readSessionRefs } from '../sessions/refs'
import type { AttachableSession, DirectSessionPort, SessionResolution } from './session-attachment'

const RUNNING_STATUSES = ['live', 'starting'] as const

export function directSessionPort(
  modules: RegistryModules,
  store: Pick<SessionStore, 'issues' | 'repos' | 'users'>,
): DirectSessionPort {
  /** The user's command context; undefined for an account that is gone or disabled. */
  const commandCtx = async (userId: UserId): Promise<SessionCommandCtx | undefined> => {
    const role = await store.users.roleOf(userId)
    if (!role) return undefined
    return await sessionCommandCtx(modules, userCommandPrincipal(userId, role).capability)
  }

  /** Does the command plane let this user command this session? A refusal and
   *  an unknown id are the same "no". */
  const commandable = async (ctx: SessionCommandCtx, sessionId: SessionId): Promise<boolean> => {
    try {
      return (await ctx.target(sessionId, 'sessions.sendText')) !== undefined
    } catch {
      return false
    }
  }

  const attachable = async (facts: readonly SessionFacts[]): Promise<AttachableSession[]> => {
    const refs = await readSessionRefs(store, facts)
    return facts.map((f) => {
      const ref = refs.get(f.sessionId)
      return {
        sessionId: f.sessionId,
        ownerUserId: f.ownerUserId,
        label: f.name || f.title,
        ...(ref ? { ref } : {}),
        status: f.status,
        reconnecting: isSessionReconnecting(f.status, modules.machines.hasDaemon(f.machineId)),
        archived: f.archived,
        headless: f.headless,
        agentKind: f.agentKind,
        resumable: f.resume !== undefined,
        ...(f.agentState ? { phase: f.agentState.phase } : {}),
        lastActiveAt: f.lastActiveAt,
      }
    })
  }

  const describe = async (userId: UserId, sessionId: SessionId): Promise<AttachableSession | undefined> => {
    const ctx = await commandCtx(userId)
    if (!ctx || !(await commandable(ctx, sessionId))) return undefined
    const facts = await modules.sessions.readSessionFactsById(sessionId)
    return facts ? (await attachable([facts]))[0] : undefined
  }

  return {
    describe,

    resolve: async (userId, identifier): Promise<SessionResolution> => {
      const resolved = await modules.readToolkit.resolveIdentifier(identifier.trim())
      if (resolved.kind === 'session') {
        const session = await describe(userId, resolved.sessionId)
        return session ? { kind: 'session', session } : { kind: 'absent' }
      }
      if (resolved.kind === 'absent') return resolved
      // A prefix shared with OTHER users' sessions must not name them: narrow
      // the candidates to the user's own before answering.
      const own = (await modules.sessions.readSessionFactsByIds(resolved.candidates)).filter(
        (f) => f.ownerUserId === userId,
      )
      const [only] = own
      if (own.length === 1 && only) {
        const session = await describe(userId, only.sessionId)
        return session ? { kind: 'session', session } : { kind: 'absent' }
      }
      if (own.length === 0) return { kind: 'absent' }
      const ids = own.map((f) => f.sessionId).sort()
      return {
        kind: 'ambiguous',
        message: `“${identifier}” matches several of your sessions (${ids.join(', ')}). Use more of the id.`,
      }
    },

    listRunning: async (userId) =>
      await attachable(
        (await modules.sessions.readSessionFactsWithStatuses(RUNNING_STATUSES)).filter(
          (f) => f.ownerUserId === userId && !f.archived && !f.headless,
        ),
      ),

    send: async (userId, sessionId, text) => {
      const ctx = await commandCtx(userId)
      if (!ctx) return { ok: false, reason: 'your account is not active' }
      const outcome = await dispatchSessionCommand(ctx, 'sendText', { sessionId, text })
      return {
        ok: outcome.ok,
        ...(outcome.queued !== undefined ? { queued: outcome.queued } : {}),
        ...(outcome.position !== undefined ? { position: outcome.position } : {}),
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      }
    },

    interrupt: async (userId, sessionId) => {
      const ctx = await commandCtx(userId)
      if (!ctx) return { ok: false, reason: 'your account is not active' }
      const outcome = await dispatchSessionCommand(ctx, 'interrupt', { sessionId })
      return { ok: outcome.ok, ...('reason' in outcome && outcome.reason ? { reason: outcome.reason } : {}) }
    },

    wake: async (userId, sessionId) => {
      const ctx = await commandCtx(userId)
      if (!ctx) return { ok: false, reason: 'your account is not active' }
      const outcome = await dispatchSessionCommand(ctx, 'resurrect', { sessionId })
      return { ok: outcome.ok, ...(outcome.reason ? { reason: outcome.reason } : {}) }
    },

    readTail: async (userId, sessionId, limit) =>
      (
        await modules.rpc.readTranscript(
          { sessionId, direction: 'before', limit },
          { kind: 'user', id: userId },
        )
      ).items,
  }
}
