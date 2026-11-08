/**
 * A HUMAN GATE'S DECISION AS A GENERIC EDIT (POD-6674, ADR 12 D3/D5 E2).
 *
 * `records.effect.edit` sets one field, `decision`, on an effect record whose
 * kind has a human gate (today: an agent's `approval`). Everything else about
 * an effect record stays its own: created, cancelled and dismissed by the
 * effect commands, every status move the executor's.
 *
 *  - TARGET: the kind's own check on the record (`onRecord`): an approval is
 *    decided only by its routed-to person. A record of a kind with no gate, an
 *    edit that clears the decision, and a record the caller may not see refuse
 *    alike (no oracle).
 *  - CONFLICT: `exp-rev`, held by the generic layer against the record revision
 *    and again in the guarded write, so the first decision wins and one made on
 *    a record that moved since is refused.
 *  - WRITE: the kind's `gate.decide`, inside the edit's unit of work. Nothing
 *    runs here: an approved record is claimed by the effect trigger after the
 *    commit, like any other `pending` record.
 */

import { EFFECT_RECORD } from '@podium/commands'
import type { EffectDecision } from '@podium/model'
import type { RegistryModules } from '../../relay'
import type { EffectRow } from '../../store/effects'
import { SyncWriteRefused } from '../sync-write/entry'
import type { SyncWriteRegistry } from '../sync-write/registry'
import { registerRecordKind } from './generic'

export interface EffectRecordDeps {
  modules(): RegistryModules
}

export function registerEffectRecord(registry: SyncWriteRegistry, deps: EffectRecordDeps): void {
  const effects = () => {
    const module = deps.modules().effects
    if (module === undefined) throw new Error('records: no effects module is composed')
    return module
  }
  /** A live record and the executor of its kind, when the kind has a gate. */
  const gated = async (id: string) => {
    const record = await effects().get(id)
    if (record === undefined || record.deletedAt !== undefined) return undefined
    const executor = effects().executors.get(record.kind)
    if (executor?.gate === undefined || executor.onRecord === undefined) return undefined
    return { record, executor, gate: executor.gate }
  }

  registerRecordKind(registry, EFFECT_RECORD, {
    target: async (_op, id, { principal }, edited) => {
      // A decision is made, never taken back.
      if ((edited?.unset.length ?? 0) > 0) return undefined
      const found = await gated(id)
      if (found === undefined || found.executor.onRecord === undefined) return undefined
      return await found.executor.onRecord(found.record, principal)
    },
    read: async (id) => {
      const record = await effects().get(id)
      return record === undefined || record.deletedAt !== undefined
        ? undefined
        : { revision: record.revision }
    },
    edit: async (ctx, id, patch, expected) => {
      const decision = patch.decision as EffectDecision | undefined
      if (decision === undefined) {
        throw new SyncWriteRefused({ kind: 'invalid', details: ['patch.decision'] })
      }
      // The generic layer asks every exp-rev edit for its revision first.
      if (expected === undefined) {
        throw new SyncWriteRefused({ kind: 'invalid', details: ['expectedRevision'] })
      }
      const found = await gated(id)
      if (found === undefined) throw new SyncWriteRefused({ kind: 'target-not-found' })
      const decided: EffectRow = await found.gate.decide(ctx, found.record, decision, expected)
      return { revision: decided.revision }
    },
  })
}
