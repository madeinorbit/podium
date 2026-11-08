/**
 * EFFECT RECORDS ON THE FEED (ADR 12 D5 E2, POD-6357).
 *
 * The capture is installed on the effects repository and runs inside the
 * transaction of every write to the table, with the rows the write returned
 * (the messages feed's pattern, `modules/message-feed`). The table and the
 * change log commit or roll back together, so no status reaches a device that
 * the table never held, and no status move escapes the feed, whoever made it.
 *
 * A tombstoned row leaves the feed (`remove`); every other row is upserted
 * whole, with the input as its kind publishes it.
 */

import type { EffectRecordWire } from '@podium/model'
import type { EntityChangeSpec, LedgerWriter } from '@podium/sync'
import type { EffectFeedCapture, EffectRow } from '../../store/effects'
import type { EffectExecutorRegistry } from './registry'

const iso = (ms: number | undefined): string | undefined =>
  ms === undefined ? undefined : new Date(ms).toISOString()

/** The input as the kind publishes it; a kind this server does not serve publishes none. */
function publishedInput(row: EffectRow, registry: EffectExecutorRegistry): unknown {
  const executor = registry.get(row.kind)
  if (executor === undefined) return null
  if (executor.publish === undefined) return row.input ?? null
  const parsed = executor.input.safeParse(row.input)
  return parsed.success ? (executor.publish(parsed.data) ?? null) : null
}

export function effectRecordOf(row: EffectRow, registry: EffectExecutorRegistry): EffectRecordWire {
  const deadline = iso(row.deadlineAt)
  const startedAt = iso(row.startedAt)
  const finishedAt = iso(row.finishedAt)
  return {
    id: row.id as EffectRecordWire['id'],
    kind: row.kind,
    target: row.target,
    input: publishedInput(row, registry),
    ...(row.result === undefined ? {} : { result: row.result }),
    cancelRequested: row.cancelRequested,
    // A gated record's decision (POD-6674); a kind with no gate carries none.
    ...(row.decision === undefined
      ? {}
      : { decision: row.decision === 'awaiting' ? null : row.decision }),
    ...(row.deciders === undefined ? {} : { deciders: [...row.deciders] }),
    effect: {
      status: row.status,
      ...(row.error === undefined ? {} : { error: row.error }),
      ...(deadline === undefined ? {} : { deadline }),
      attempts: row.attempts,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(finishedAt === undefined ? {} : { finishedAt }),
      ...(row.stage === undefined ? {} : { stage: row.stage }),
    },
    createdBy: row.createdBy,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    revision: row.revision,
  }
}

export function effectChangeOf(row: EffectRow, registry: EffectExecutorRegistry): EntityChangeSpec {
  if (row.deletedAt !== undefined) return { entity: 'effect', id: row.id, op: 'remove' }
  return { entity: 'effect', id: row.id, op: 'upsert', value: effectRecordOf(row, registry) }
}

export function makeEffectFeedCapture(
  ledger: Pick<LedgerWriter, 'capture'>,
  registry: EffectExecutorRegistry,
): EffectFeedCapture {
  return async (rows) => {
    await ledger.capture(rows.map((row) => effectChangeOf(row, registry)))
  }
}
