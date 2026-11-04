/**
 * THE SESSION'S LIFECYCLE AS A GENERIC RECORD (ADR 12 D5 E1, POD-6356).
 *
 * `records.session.edit` sets what the session should be (`desired`, and
 * `force` for a stop that discards unsaved work) one spec revision further;
 * `records.session.remove` is kill, which deletes the session row as
 * `sessions.kill` always has. Both are checked against the record's revision by
 * the generic layer, so a stop queued on a laptop that arrives after a newer
 * start from a phone is refused instead of ending the process.
 *
 * The edit only WRITES. The lifecycle controller acts after the unit of work
 * commits (`afterCommit`), through the daemon channel, and records what it did
 * as `observedRevision`. The target check is the command plane's own for the
 * route this replaces, so the edit is never weaker than `sessions.stop` or
 * `sessions.kill`: owner or grant, issue scope, and machine `use`.
 */

import { SESSION_RECORD } from '@podium/commands'
import type { SessionDesired, SessionId } from '@podium/model'
import { onBehalfOfUser } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import { sessionCommandCtx } from '../sessions/command-ctx'
import { SyncWriteRefused } from '../sync-write/entry'
import { NO_TARGET, type SyncWriteRegistry } from '../sync-write/registry'
import { registerRecordKind } from './generic'

export interface SessionLifecycleRecordDeps {
  modules(): RegistryModules
}

const gone = (): never => {
  throw new SyncWriteRefused({ kind: 'target-not-found' })
}

export function registerSessionLifecycleRecord(
  registry: SyncWriteRegistry,
  deps: SessionLifecycleRecordDeps,
): void {
  const sessions = () => deps.modules().sessions

  registerRecordKind(registry, SESSION_RECORD, {
    target: async (op, id, { principal }) => {
      if (principal.kind === 'system') return undefined
      const plane = await sessionCommandCtx(deps.modules(), principal.capability, false, 'trpc')
      try {
        const row = await plane.target(
          id as SessionId,
          op === 'remove' ? 'sessions.kill' : 'sessions.stop',
        )
        return row === undefined ? undefined : NO_TARGET
      } catch {
        // A denied gate and an absent session are one answer (no existence oracle).
        return undefined
      }
    },
    read: async (id) => {
      const state = await sessions().desiredStateOf(id as SessionId)
      return state === undefined ? undefined : { revision: state.lifecycle.revision }
    },
    edit: async (ctx, id, patch) => {
      const desired = patch.desired as SessionDesired | undefined
      // `force` alone qualifies nothing: it belongs to the stop it is sent with.
      if (desired === undefined) {
        throw new SyncWriteRefused({ kind: 'invalid', details: ['patch.desired'] })
      }
      const sessionId = id as SessionId
      const principal = ctx.principal
      const revision = await sessions().editDesiredState(sessionId, desired, patch.force === true, {
        user: onBehalfOfUser(principal),
        agent: principal.kind === 'agent' ? principal.agentSessionId : null,
      })
      if (revision === undefined) gone()
      const controller = deps.modules().sessionLifecycleController
      ctx.afterCommit(() => {
        // Not awaited: the reply never waits on a daemon (ADR 12 D5). A failed
        // pass leaves the session pending for the next trigger.
        void controller.reconcile(sessionId, { principal }).catch(() => undefined)
      }, 'session-lifecycle')
      return { revision }
    },
    remove: async (_ctx, id) => {
      await sessions().killSession({ sessionId: id as SessionId })
      return { ok: true }
    },
  })
}
