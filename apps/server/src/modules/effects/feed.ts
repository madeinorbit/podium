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
 * whole, with the input as its kind publishes it, except the server's own
 * machine scans ({@link effectOnFeed}).
 */

import type { EffectRecordWire } from '@podium/model'
import type { LedgerWriter } from '@podium/sync'
import { changeLogCommit } from '../../store/change-log-commit'
import type { EffectFeedCapture, EffectRow } from '../../store/effects'
import { SYSTEM_EFFECT_KINDS_OFF_FEED } from './published-input'
import type { EffectExecutorRegistry } from './registry'

/**
 * Whether an effect record is on the feed: a person's record, or a kind the
 * server's own starts still publish ({@link SYSTEM_EFFECT_KINDS_OFF_FEED}).
 */
export const effectOnFeed = (row: Pick<EffectRow, 'kind' | 'createdBy'>): boolean =>
  row.createdBy !== null || !SYSTEM_EFFECT_KINDS_OFF_FEED.includes(row.kind)

const iso = (ms: number | undefined): string | undefined =>
  ms === undefined ? undefined : new Date(ms).toISOString()

/**
 * The input as the kind publishes it; a kind this server does not serve
 * publishes none. The rule takes the STORED input, which the create parsed
 * with the kind's schema before storing it (POD-6770): a process that holds
 * no schema (the sync worker) publishes the same value. A stored input the
 * rule cannot read (not an object, a shape from before the rule) publishes
 * none.
 */
function publishedInput(row: EffectRow, registry: Pick<EffectExecutorRegistry, 'get'>): unknown {
  const executor = registry.get(row.kind)
  if (executor === undefined) return null
  if (executor.publish === undefined) return row.input ?? null
  if (row.input === null || typeof row.input !== 'object') return null
  try {
    return executor.publish(row.input) ?? null
  } catch {
    return null
  }
}

export function effectRecordOf(
  row: EffectRow,
  registry: Pick<EffectExecutorRegistry, 'get'>,
): EffectRecordWire {
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

/**
 * The capture installed on the repository: run inside every effect write's
 * transaction once the write returned rows, it commits through the Ledger,
 * which drains the database's change capture and appends the effect records
 * the write changed (POD-6920). A write that changes nothing returns no row,
 * so the repository does not call this and nothing is logged.
 */
export function makeEffectFeedCapture(ledger: Pick<LedgerWriter, 'commit'>): EffectFeedCapture {
  return changeLogCommit(ledger)
}
