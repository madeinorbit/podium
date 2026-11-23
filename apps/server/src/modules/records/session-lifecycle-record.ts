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
import { type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import { sessionCommandCtx } from '../sessions/command-ctx'
import { applyRename, mayWrite, ownedTarget } from '../sessions/rename-target-path'
import {
  type SessionStateDeps,
  sessionStateCommandForSync,
  sessionStatePrincipalFor,
} from '../sessions/session-state/registry'
import { SyncWriteRefused } from '../sync-write/entry'
import {
  NO_TARGET,
  type SyncWriteContext,
  type SyncWriteRegistry,
  type SyncWriteTarget,
} from '../sync-write/registry'
import { registerRecordKind } from './generic'

export interface SessionLifecycleRecordDeps {
  modules(): RegistryModules
}

/**
 * THE LABELS (POD-6406): `name`, `archived` and `workState` are plain fields of
 * the session record, each written by the command that always wrote it, under
 * that command's own gate: rename's (owned target, the live delegation ceiling,
 * the precedence rule for an agent's pick) and the session-state commands'
 * (`sessions.setArchived`, which parks an archived session after commit;
 * `sessions.setWorkState`). They never move the spec revision.
 */
const LABELS = ['name', 'archived', 'workState'] as const
type Edited = {
  readonly patch: Readonly<Record<string, unknown>>
  readonly unset: readonly string[]
}

const named = ({ patch, unset }: Edited): string[] => [
  ...Object.keys(patch).filter((k) => patch[k] !== undefined),
  ...unset,
]
const labelFields = (edited: Edited): string[] =>
  named(edited).filter((k) => (LABELS as readonly string[]).includes(k))
const touchesLifecycle = (edited: Edited): boolean =>
  named(edited).some((k) => !(LABELS as readonly string[]).includes(k))

function stateDeps(modules: RegistryModules): SessionStateDeps {
  return { sessions: modules.sessions, state: modules.sessions.state, mutations: modules.mutations }
}

function stateCommand(name: 'sessions.setArchived' | 'sessions.setWorkState') {
  const command = sessionStateCommandForSync(name)
  if (command === undefined) throw new Error(`records: no session-state command ${name}`)
  return command
}

async function labelTarget(
  modules: RegistryModules,
  sessionId: SessionId,
  principal: Exclude<CommandPrincipal, { kind: 'system' }>,
  labels: readonly string[],
  edited: Edited | undefined,
): Promise<SyncWriteTarget> {
  let target: SyncWriteTarget
  if (labels.includes('name')) {
    const owned = await ownedTarget({ sessions: modules.sessions }, sessionId)
    if (owned === undefined || !mayWrite(principal, owned)) return undefined
    target = owned
  }
  const caller = sessionStatePrincipalFor(principal)
  for (const [field, command] of [
    ['archived', 'sessions.setArchived'],
    ['workState', 'sessions.setWorkState'],
  ] as const) {
    if (!labels.includes(field)) continue
    const value = edited?.patch[field] ?? null
    const gate = await stateCommand(command).target(
      { sessionId, [field]: value },
      caller,
      stateDeps(modules),
    )
    if (gate === undefined) return undefined
    target ??= gate
  }
  return target
}

async function editLabels(
  modules: RegistryModules,
  ctx: SyncWriteContext,
  sessionId: SessionId,
  patch: Readonly<Record<string, unknown>>,
  unset: readonly string[],
): Promise<void> {
  const principal = ctx.principal
  if (typeof patch.name === 'string') {
    const outcome = await applyRename(
      { sessions: modules.sessions },
      ctx.ledger,
      { sessionId, name: patch.name },
      principal,
    )
    if (!outcome.ok) throw new SyncWriteRefused({ kind: 'conflict' })
  }
  const caller = sessionStatePrincipalFor(principal)
  if (typeof patch.archived === 'boolean') {
    await stateCommand('sessions.setArchived').handle(
      { sessionId, archived: patch.archived },
      caller,
      stateDeps(modules),
      ctx.ledger,
    )
  }
  if (patch.workState !== undefined || unset.includes('workState')) {
    await stateCommand('sessions.setWorkState').handle(
      { sessionId, workState: patch.workState ?? null },
      caller,
      stateDeps(modules),
      ctx.ledger,
    )
  }
}

/** An agent's `desired: stopped` (with or without `force`) on its own session. */
function isSelfStop(
  op: string,
  id: string,
  principal: CommandPrincipal,
  edited: Edited | undefined,
): boolean {
  if (op !== 'edit' || principal.kind !== 'agent' || principal.agentSessionId !== id) return false
  if (edited === undefined || edited.patch.desired !== 'stopped') return false
  return named(edited).every((field) => field === 'desired' || field === 'force')
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
    target: async (op, id, { principal, confirmed }, edited) => {
      if (principal.kind === 'system') return undefined
      const labels = edited === undefined ? [] : labelFields(edited)
      if (labels.length > 0) {
        // A label edit is the label command's own gate, never the lifecycle's,
        // and never mixed with a lifecycle edit in one write.
        if (edited !== undefined && touchesLifecycle(edited)) return undefined
        return await labelTarget(deps.modules(), id as SessionId, principal, labels, edited)
      }
      // A session may always stop itself [spec:SP-9904] (POD-6422): its agent's
      // own stop needs no scope, as the relay's self-stop never did. This kind
      // is not on the relay, so only the server's own adapters write it as an
      // agent (the relay's stop arm, `finishSelfStop`).
      if (isSelfStop(op, id, principal, edited)) return NO_TARGET
      // `confirmed` is the caller's --outside-scope (the routes send it so).
      const plane = await sessionCommandCtx(deps.modules(), principal.capability, confirmed, 'trpc')
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
    edit: async (ctx, id, patch, _expected, unset) => {
      if (labelFields({ patch, unset }).length > 0) {
        await editLabels(deps.modules(), ctx, id as SessionId, patch, unset)
        return { ok: true }
      }
      const desired = patch.desired as SessionDesired | undefined
      // `force` alone qualifies nothing: it belongs to the stop it is sent with.
      if (desired === undefined) {
        throw new SyncWriteRefused({ kind: 'invalid', details: ['patch.desired'] })
      }
      const sessionId = id as SessionId
      const principal = ctx.principal
      const revision = await sessions().editDesiredState(
        ctx.ledger,
        sessionId,
        desired,
        patch.force === true,
        {
          user: onBehalfOfUser(principal),
          agent: principal.kind === 'agent' ? principal.agentSessionId : null,
        },
      )
      if (revision === undefined) gone()
      const controller = deps.modules().sessionLifecycleController
      ctx.afterCommit(() => {
        // Not awaited: the reply never waits on a daemon (ADR 12 D5). A failed
        // pass leaves the session pending for the next trigger.
        void controller.reconcile(sessionId, { principal }).catch(() => undefined)
      }, 'session-lifecycle')
      return { revision }
    },
    remove: async (ctx, id) => {
      await sessions().killSession(ctx.ledger, { sessionId: id as SessionId })
      return { ok: true }
    },
  })
}
