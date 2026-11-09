/**
 * SUPERAGENT THREADS AS SYNCED RECORDS (POD-6675, ADR 12 D1; design POD-5620
 * §1.7).
 *
 * A thread used to reach a client by one `superagent.listThreads` read at
 * startup, so a thread made on another device never appeared, and whether a turn
 * was running was an in-memory flag that read answered. Each thread is now a
 * `superagentThread` record on the feed, its owner's alone (`per-user-state`):
 *
 *  - THE FEED CAPTURE. Every write of `superagent_threads` hands the rows it
 *    wrote to {@link makeThreadFeedCapture} inside its own transaction
 *    (`SuperagentRepository.writeThreads`), so the record follows the row
 *    whoever moved it: a superagent command, the turn runner, a reset, the boot
 *    back-fill. Inside a command the change carries that command's provenance.
 *  - THE OWNER'S EDITS. `records.superagentThread.edit`: the title, the archive
 *    flag, the model and the effort, each its own field (last writer wins). An
 *    edit names the record by its feed id, which names the owner, and only that
 *    owner may write it.
 *  - STATUS is the server's: which thread it is, its headless session, whether
 *    a turn is running (`turnRunning`) and whether the last one failed
 *    (`lastTurnFailure`), written by `SuperagentService` at turn start, failure
 *    and end.
 *  - BOOT TRUTH ({@link reconcileSuperagentThreads}): every active member gets
 *    a global thread (no read creates one any more), `turnRunning` is set from
 *    the pending-turn rows, and every stored thread is reconciled onto the log.
 *
 * Rolling back needs no data step: the four status columns are additive, and an
 * older build parses this kind's log rows as unknown and advances its cursor.
 */

import { SUPERAGENT_THREAD_RECORD } from '@podium/commands'
import {
  parseSuperagentThreadRowId,
  type SuperagentThreadWire,
  superagentThreadRowId,
  type UserId,
  type UserRole,
} from '@podium/model'
import type { EntityChangeSpec, LedgerWriter } from '@podium/sync'
import { type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import type { SessionStore, SuperagentThreadRow } from '../../store'
import type { SuperagentThreadFeedCapture } from '../../store/superagent'
import { registerRecordKind } from '../records/generic'
import { SyncWriteRefused } from '../sync-write/entry'
import type { SyncWriteRegistry } from '../sync-write/registry'

/** The record as its owner's devices hold it: the server-only fields left out. */
export function superagentThreadWireOf(row: SuperagentThreadRow): SuperagentThreadWire {
  return {
    threadId: row.id as SuperagentThreadWire['threadId'],
    ownerUserId: row.ownerUserId,
    kind: row.kind,
    ...(row.originSessionId !== undefined ? { originSessionId: row.originSessionId } : {}),
    ...(row.repoPath !== undefined ? { repoPath: row.repoPath } : {}),
    ...(row.agentKind !== undefined ? { agentKind: row.agentKind } : {}),
    ...(row.podiumSessionId !== undefined ? { podiumSessionId: row.podiumSessionId } : {}),
    ...(row.title !== undefined ? { title: row.title } : {}),
    archived: row.archived,
    ...(row.model !== undefined ? { model: row.model } : {}),
    ...(row.effort !== undefined ? { effort: row.effort } : {}),
    resumable: row.harnessSessionId !== undefined,
    turnRunning: row.turnRunning,
    lastTurnFailure: row.lastTurnFailure,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function superagentThreadChangeOf(row: SuperagentThreadRow): EntityChangeSpec {
  return {
    entity: 'superagentThread',
    id: superagentThreadRowId(row.ownerUserId, row.id),
    op: 'upsert',
    value: superagentThreadWireOf(row),
  }
}

/** The capture installed on the repository: a mirror of the rows each write made. */
export function makeThreadFeedCapture(
  ledger: Pick<LedgerWriter, 'capture'>,
): SuperagentThreadFeedCapture {
  return async (rows) => {
    await ledger.capture(rows.map(superagentThreadChangeOf))
  }
}

/** What the boot reconcile appends through: the boot's `server` writer. */
export interface ThreadReconcileWriter {
  reconcile(
    entity: Parameters<LedgerWriter['reconcile']>[0],
    rows: { id: string; value: unknown }[],
  ): Promise<unknown>
}

export async function reconcileSuperagentThreads(
  writer: ThreadReconcileWriter,
  store: Pick<SessionStore, 'superagent'>,
): Promise<void> {
  await store.superagent.seedMemberGlobalThreads()
  await store.superagent.syncTurnRunningWithPendingTurns()
  const threads = await store.superagent.allThreadsForBootReconcile()
  await writer.reconcile(
    'superagentThread',
    threads.map((row) => ({
      id: superagentThreadRowId(row.ownerUserId, row.id),
      value: superagentThreadWireOf(row),
    })),
  )
}

export interface ThreadRecordDeps {
  readonly threads: () => Pick<
    SessionStore['superagent'],
    'getSuperagentThread' | 'updateSuperagentThreadBinding'
  >
  /** The account's live role, or undefined (disabled, or no account). */
  readonly roleOf: (user: UserId) => Promise<UserRole | undefined>
}

const gone = (): never => {
  throw new SyncWriteRefused({ kind: 'target-not-found' })
}

/** The caller's own thread named by a feed id, or undefined. */
function ownThreadKey(id: string, principal: CommandPrincipal) {
  if (principal.kind === 'system') return undefined
  const human = onBehalfOfUser(principal)
  let key: ReturnType<typeof parseSuperagentThreadRowId>
  try {
    key = parseSuperagentThreadRowId(id)
  } catch {
    return undefined
  }
  return human !== null && key.userId === human ? key : undefined
}

/** A spec patch as the repository writes it: a cleared cell is `null`. */
function threadPatch(
  patch: Readonly<Record<string, unknown>>,
  unset: readonly string[],
): { title?: string | null; archived?: boolean; model?: string | null; effort?: string | null } {
  const out: {
    title?: string | null
    archived?: boolean
    model?: string | null
    effort?: string | null
  } = {}
  if (typeof patch.title === 'string') out.title = patch.title
  if (typeof patch.archived === 'boolean') out.archived = patch.archived
  if (typeof patch.model === 'string') out.model = patch.model
  if (typeof patch.effort === 'string') out.effort = patch.effort
  for (const name of unset) {
    if (name === 'title' || name === 'model' || name === 'effort') out[name] = null
  }
  return out
}

export function registerSuperagentThreadRecords(
  registry: SyncWriteRegistry,
  deps: ThreadRecordDeps,
): void {
  registerRecordKind(registry, SUPERAGENT_THREAD_RECORD, {
    target: async (_op, id, { principal }) => {
      const key = ownThreadKey(id, principal)
      if (key === undefined) return undefined
      // Another person's thread, or one that does not exist, is one answer.
      const thread = await deps.threads().getSuperagentThread(key.threadId, key.userId)
      if (thread === undefined) return undefined
      // The kind's role floor, read live: a disabled account writes nothing.
      if ((await deps.roleOf(key.userId)) === undefined) return undefined
      return { kind: 'per-user-row', userId: key.userId }
    },
    edit: async (ctx, id, patch, _expected, unset) => {
      const key = ownThreadKey(id, ctx.principal) ?? gone()
      const thread = (await deps.threads().getSuperagentThread(key.threadId, key.userId)) ?? gone()
      const values = threadPatch(patch, unset)
      // The global thread is always there: it is never archived.
      if (values.archived === true && thread.kind === 'global') {
        throw new SyncWriteRefused({
          kind: 'invalid',
          message: 'the global superagent thread cannot be archived',
          details: ['archived'],
        })
      }
      if (Object.keys(values).length === 0) return { ok: true }
      await ctx.ledger.commit({
        // The row's own capture publishes the record inside this unit, under
        // this command's provenance.
        write: async () => await deps.threads().updateSuperagentThreadBinding(thread.id, values),
        changes: () => [],
      })
      return { ok: true }
    },
  })
}
