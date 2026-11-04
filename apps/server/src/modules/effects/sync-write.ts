/**
 * THE EFFECT COMMANDS ON THE SYNC WRITE ENTRY POINT (ADR 12 D2, D5 E2; POD-6357).
 *
 * `effects.create`, `effects.cancel` and `effects.dismiss` (contracts in
 * `@podium/commands` `effects/contracts.ts`). The entry point runs every common
 * step; this file supplies, per command, the target and the write:
 *
 *  - TARGET: the executor kind's own live check on what the effect acts on. For
 *    cancel and dismiss it is asked again of the stored record's target, so
 *    whoever may ask for the effect may also call it off. A kind this server does
 *    not serve, and a record the caller cannot see, refuse alike (no oracle).
 *  - WRITE: inside the entry point's unit of work. A create never overwrites an
 *    id (ADR 12 D4); the same envelope again is the entry point's replay. Its
 *    input is parsed with the kind's schema, and a bad one is `invalid`.
 *
 * No effect runs here. The record commits `pending`, and the runner's trigger
 * picks it up after the commit.
 */

import {
  type EffectsCancelInput,
  type EffectsCreateInput,
  type EffectsDismissInput,
  effectsCancelContract,
  effectsCreateContract,
  effectsDismissContract,
} from '@podium/commands'
import { attributionOf, onBehalfOfUser } from '../../command-principal'
import type { EffectRow, EffectsRepository } from '../../store/effects'
import { SyncWriteRefused } from '../sync-write/entry'
import type { SyncTargetContext, SyncWriteRegistry, SyncWriteTarget } from '../sync-write/registry'
import type { EffectExecutorRegistry } from './registry'

export type EffectCommandRepository = Pick<
  EffectsRepository,
  'get' | 'insert' | 'requestCancel' | 'tombstone'
>

/** What a reply carries: never the input, which may hold content (a file's text)
 *  and is stored in the dedup ledger with the result. */
export interface EffectCommandResult {
  readonly id: string
  readonly status: EffectRow['status']
  readonly cancelRequested: boolean
}

const resultOf = (row: EffectRow): EffectCommandResult => ({
  id: row.id,
  status: row.status,
  cancelRequested: row.cancelRequested,
})

export interface EffectCommandDeps {
  readonly repo: EffectCommandRepository
  readonly executors: EffectExecutorRegistry
  readonly now: () => number
}

/** What the kind decides about the caller and this record's target. */
async function recordTarget(
  deps: EffectCommandDeps,
  id: string,
  ctx: SyncTargetContext,
): Promise<SyncWriteTarget> {
  const row = await deps.repo.get(id)
  if (row === undefined || row.deletedAt !== undefined) return undefined
  const executor = deps.executors.get(row.kind)
  if (executor === undefined) return undefined
  return await executor.target(row.target, ctx.principal)
}

export function registerEffectCommands(registry: SyncWriteRegistry, deps: EffectCommandDeps): void {
  registry.register({
    contract: effectsCreateContract,
    target: async (input: EffectsCreateInput, ctx) => {
      const executor = deps.executors.get(input.kind)
      if (executor === undefined) return undefined
      return await executor.target(input.target, ctx.principal)
    },
    handle: async (ctx, input: EffectsCreateInput): Promise<EffectCommandResult> => {
      const executor = deps.executors.get(input.kind)
      // The target step found it; a registry does not lose a kind in between.
      if (executor === undefined) throw new SyncWriteRefused({ kind: 'unauthorized' })
      const parsed = executor.input.safeParse(input.input)
      if (!parsed.success) {
        throw new SyncWriteRefused({
          kind: 'invalid',
          details: [
            ...new Set(parsed.error.issues.map((issue) => ['input', ...issue.path].join('.'))),
          ],
        })
      }
      const refusal = await executor.admit?.(parsed.data, input.target, ctx.principal)
      if (refusal !== undefined) throw new SyncWriteRefused(refusal)
      if ((await deps.repo.get(input.id)) !== undefined) {
        throw new SyncWriteRefused({ kind: 'conflict' })
      }
      const now = deps.now()
      const row = await deps.repo.insert(
        {
          id: input.id,
          kind: input.kind,
          target: input.target,
          input: parsed.data,
          deadlineAt: now + (input.deadlineMs ?? executor.deadlineMs),
          createdBy: onBehalfOfUser(ctx.principal),
          actor: attributionOf(ctx.principal).actor,
        },
        now,
      )
      return resultOf(row)
    },
  })

  registry.register({
    contract: effectsCancelContract,
    target: async (input: EffectsCancelInput, ctx) => await recordTarget(deps, input.id, ctx),
    handle: async (_ctx, input: EffectsCancelInput): Promise<EffectCommandResult> => {
      // Already ended, or already asked: nothing to change, and that is not a refusal.
      const row =
        (await deps.repo.requestCancel(input.id, deps.now())) ?? (await deps.repo.get(input.id))
      if (row === undefined) throw new SyncWriteRefused({ kind: 'target-not-found' })
      return resultOf(row)
    },
  })

  registry.register({
    contract: effectsDismissContract,
    target: async (input: EffectsDismissInput, ctx) => await recordTarget(deps, input.id, ctx),
    handle: async (_ctx, input: EffectsDismissInput): Promise<{ dismissed: true }> => {
      if ((await deps.repo.tombstone(input.id, deps.now())) === undefined) {
        // Still pending or running: it has to end (or be cancelled) first.
        throw new SyncWriteRefused({ kind: 'conflict' })
      }
      return { dismissed: true }
    },
  })
}
