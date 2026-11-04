/**
 * THE ISSUE COMMANDS THE APPS QUEUE, ON THE SYNC WRITE ENTRY POINT
 * (POD-6350, ADR 12 D2).
 *
 * Each is registered from the issue command table (`registry.ts`): its contract,
 * a target resolver, and the table's own handler, run through the dispatcher so
 * revision arbitration (`exp-rev`) applies exactly as on every other transport.
 *
 * THE TARGET is the derived routes' guard (`guardIssueCommand` →
 * `checkIssueAccess`), answered as a target instead of thrown, so the entry point
 * makes the one `authorize` call with the envelope's confirmation:
 *
 *  - an operator (`all` scope), or a command with no target issue (the read
 *    marks, tuck): no target, the role decides;
 *  - a target that does not exist: no target either, as the guard lets it
 *    through; the handler's `IssueNotFound` is then a `target-not-found`
 *    refusal, as it was a 404;
 *  - an `owned` scope: the issue's owner and grants, or a refusal;
 *  - a `subtree` scope: the issue and its ancestors, where an out-of-scope write
 *    needs the confirmation.
 *
 * THE HANDLER runs without its own dedup (`withoutDedup`): the entry point has
 * already deduplicated by the envelope's mutationId. A definitive error from it
 * (a 4xx `TRPCError`, `IssueNotFound`, `IssueRefusal`) is a refusal carrying the
 * error as its cause, which the old routes rethrow unchanged. Anything else
 * propagates, and the outbox retries it.
 */

import { ISSUE_CONTRACTS, type IssueContractName } from '@podium/commands'
import type { SyncSubmitRefusal } from '@podium/protocol'
import { TRPCError } from '@trpc/server'
import type { RegistryModules } from '../../relay'
import { SyncWriteRefused } from '../sync-write/entry'
import { NO_TARGET, type SyncWriteRegistry, type SyncWriteTarget } from '../sync-write/registry'
import { commandAccess, type IssueCaller } from './command-ctx'
import { type AnyIssueCommandDef, issueRegistry } from './registry'
import { isIssueNotFound } from './service/not-found'
import { isIssueRefusal } from './service/refusal'

/** The issue commands the apps queue (client `OUTBOX_COMMANDS`), by proc name. */
export const QUEUED_ISSUE_COMMANDS = [
  'markRead',
  'markUnread',
  'setTucked',
  'update',
  'archive',
  'delete',
  'close',
  'defer',
  'undefer',
  'setLabels',
  'setPlacement',
  'restore',
] as const satisfies readonly (keyof typeof issueRegistry.defs)[]

export interface IssueSyncWriteDeps {
  modules(): RegistryModules
}

/** `checkIssueAccess`'s decision, as the target it would authorize. */
async function issueTarget(
  modules: RegistryModules,
  def: AnyIssueCommandDef,
  input: unknown,
  caller: IssueCaller,
): Promise<SyncWriteTarget> {
  const scope = caller.capability.scope
  if (scope.kind === 'all' || def.target === undefined) return NO_TARGET
  const access = commandAccess(modules.issues)
  const raw = def.target((input ?? {}) as Record<string, unknown>)
  // Display refs (#seq) resolve to the internal id before the scope check, scoped
  // to the bound issue's repo (#140), exactly as the guard does.
  const scopeRepoPath =
    scope.kind === 'subtree'
      ? ((await access.getMeta(scope.rootId))?.repoPath ?? undefined)
      : undefined
  const targetId = typeof raw === 'string' ? await access.resolveRef(raw, scopeRepoPath) : raw
  if (!targetId || !(await access.has(targetId))) return NO_TARGET
  if (scope.kind === 'owned') return (await access.ownedTarget?.(targetId, def.action)) ?? undefined
  return { id: targetId, ancestorIds: await access.ancestorIds(targetId) }
}

/** A definitive error from an issue handler, as a refusal; undefined to propagate. */
export function issueRefusalOf(error: unknown): SyncSubmitRefusal | undefined {
  if (isIssueNotFound(error)) return { kind: 'target-not-found' }
  if (isIssueRefusal(error)) return { kind: 'conflict' }
  if (!(error instanceof TRPCError)) return undefined
  switch (error.code) {
    case 'FORBIDDEN':
    case 'UNAUTHORIZED':
      return { kind: 'unauthorized' }
    case 'NOT_FOUND':
      return { kind: 'target-not-found' }
    case 'CONFLICT':
      return { kind: 'conflict' }
    case 'BAD_REQUEST':
      return { kind: 'invalid' }
    case 'PRECONDITION_FAILED':
      return { kind: 'confirmation-required' }
    default:
      return undefined
  }
}

export function registerIssueCommands(registry: SyncWriteRegistry, deps: IssueSyncWriteDeps): void {
  const defs = issueRegistry.defs as Record<string, AnyIssueCommandDef>
  for (const key of QUEUED_ISSUE_COMMANDS) {
    const def = defs[key]
    const contract = ISSUE_CONTRACTS[key as IssueContractName]
    if (!def || !contract) throw new Error(`sync write: no issue command named ${key}`)
    registry.register({
      contract,
      target: async (input, { principal }) =>
        principal.kind === 'system'
          ? undefined
          : await issueTarget(deps.modules(), def, input, {
              capability: principal.capability,
              principal,
            }),
      handle: async (ctx, input) => {
        const principal = ctx.principal
        // The entry point never lets a system principal through; the narrowing
        // is for the capability the dispatcher reads.
        if (principal.kind === 'system')
          throw new Error('issue write reached its handler as system')
        const caller: IssueCaller = { capability: principal.capability, principal }
        try {
          return await deps.modules().issueCommands.withoutDedup().run(caller, key, def, input)
        } catch (error) {
          const refusal = issueRefusalOf(error)
          if (refusal === undefined) throw error
          throw new SyncWriteRefused(refusal, { cause: error })
        }
      },
    })
  }
}
