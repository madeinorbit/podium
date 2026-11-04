/**
 * Effect records (ADR 12 D5 E2, POD-6357): the `effects` table. Pure persistence;
 * the lifecycle (who may move a record where, the trigger, the sweep, the feed)
 * lives in `modules/effects/`.
 *
 * EVERY WRITE GOES THROUGH ONE FUNNEL ({@link EffectsRepository.write}): the rows a
 * statement returned are handed to the feed capture INSIDE its transaction, so
 * the table and the change log commit or roll back together, and handed to the
 * {@link EffectsRepository.onCommitted} listeners as an after-commit effect
 * (mechanism 3, `afterCommit`): after the OUTERMOST commit, outside its lease,
 * and never for a write that rolled back. That is what the one generic trigger
 * listens to.
 *
 * STATUS MOVES ARE GUARDED IN SQL. A move into a status is written as
 * `UPDATE … WHERE status IN (EffectLifecycle.allowedFrom(to))`, so zero rows back
 * means "refused": a claim (`pending` → `running`) that a second trigger lost, an
 * expiry of a record that has started, a finish of one already settled.
 */

import {
  EffectLifecycle,
  type EffectStatus,
  type EffectTargetKind,
  type UserId,
} from '@podium/model'
import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import { effects } from '../migrations/schema'
import { afterCommit } from './executor/executor'
import type { StoreDrizzle, StoreQueries, TransactionRunner } from './executor/sync-drizzle'
import {
  inListOf,
  inListSize,
  inListValues,
  param,
  prepared,
  preparedFamily,
} from './executor/sync-drizzle'

type EffectSelect = typeof effects.$inferSelect

/** One effect record, as the server holds it. Times are epoch milliseconds. */
export interface EffectRow {
  readonly id: string
  readonly kind: string
  readonly target: { readonly kind: EffectTargetKind; readonly id: string }
  /** The whole input, as the executor reads it. */
  readonly input: unknown
  readonly result: unknown
  readonly cancelRequested: boolean
  readonly status: EffectStatus
  readonly error: { readonly code: string; readonly message: string } | undefined
  readonly deadlineAt: number | undefined
  readonly attempts: number
  readonly stage: string | undefined
  readonly startedAt: number | undefined
  readonly finishedAt: number | undefined
  readonly createdBy: UserId | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly revision: number
  readonly deletedAt: number | undefined
}

/** Who an effect's audience is read from, through the tombstone. */
export interface EffectAudience {
  readonly targetKind: string
  readonly targetId: string
  readonly createdBy: UserId | null
}

/** Run inside the write's transaction with the rows it returned. */
export type EffectFeedCapture = (rows: readonly EffectRow[]) => Promise<void>

const parseJson = (text: string | null): unknown => {
  if (text === null) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

const orUndefined = <T>(value: T | null): T | undefined => (value === null ? undefined : value)

export function rowToEffect(r: EffectSelect): EffectRow {
  return {
    id: r.id,
    kind: r.kind,
    // The service writes only known target kinds; the column is plain text.
    target: { kind: r.targetKind as EffectTargetKind, id: r.targetId },
    input: parseJson(r.inputJson),
    result: parseJson(r.resultJson),
    cancelRequested: r.cancelRequested,
    // Text without a CHECK (see the schema); a successor's status reads as `unknown`.
    status: EffectLifecycle.isState(r.status) ? r.status : 'unknown',
    error: r.errorCode === null ? undefined : { code: r.errorCode, message: r.errorMessage ?? '' },
    deadlineAt: orUndefined(r.deadlineAt),
    attempts: r.attempts,
    stage: orUndefined(r.stage),
    startedAt: orUndefined(r.startedAt),
    finishedAt: orUndefined(r.finishedAt),
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    revision: r.revision,
    deletedAt: orUndefined(r.deletedAt),
  }
}

// Every query this repository runs, prepared once per store [POD-6147].

const P = (name: string) => sql.placeholder(name)
const idIs = () => eq(effects.id, param(effects.id, 'id'))
const live = () => isNull(effects.deletedAt)
const statusIn = (states: readonly EffectStatus[]) => inArray(effects.status, [...states])

const insertEffect = prepared((db: StoreDrizzle) =>
  db
    .insert(effects)
    .values({
      id: P('id'),
      kind: P('kind'),
      targetKind: P('targetKind'),
      targetId: P('targetId'),
      inputJson: P('inputJson'),
      status: P('status'),
      deadlineAt: P('deadlineAt'),
      createdBy: P('createdBy'),
      createdAt: P('now'),
      updatedAt: P('now'),
    })
    .returning()
    .prepare(),
)

/** By id, tombstones included: a create must never reuse a removed id. */
const effectById = prepared((db: StoreDrizzle) => db.select().from(effects).where(idIs()).prepare())

const audiencesOfIds = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({
      id: effects.id,
      targetKind: effects.targetKind,
      targetId: effects.targetId,
      createdBy: effects.createdBy,
    })
    .from(effects)
    .where(inListOf(effects.id, size))
    .prepare(),
)

/** The claim: `pending` → `running`, one more attempt. Not when cancel was asked. */
const claimEffect = prepared((db: StoreDrizzle) =>
  db
    .update(effects)
    .set({
      status: 'running',
      attempts: sql`${effects.attempts} + 1`,
      startedAt: P('now'),
      updatedAt: P('now'),
      revision: sql`${effects.revision} + 1`,
    })
    .where(
      and(
        idIs(),
        live(),
        statusIn(EffectLifecycle.allowedFrom('running')),
        eq(effects.cancelRequested, false),
      ),
    )
    .returning()
    .prepare(),
)

/** An ending (or `unknown`): one shape per target status, each guarded by the machine. */
const settleEffect = preparedFamily((db: StoreDrizzle, to: EffectStatus) =>
  db
    .update(effects)
    .set({
      status: to,
      errorCode: P('errorCode'),
      errorMessage: P('errorMessage'),
      resultJson: P('resultJson'),
      stage: P('stage'),
      finishedAt: EffectLifecycle.isTerminal(to) ? P('now') : sql`${effects.finishedAt}`,
      updatedAt: P('now'),
      revision: sql`${effects.revision} + 1`,
    })
    .where(and(idIs(), live(), statusIn(EffectLifecycle.allowedFrom(to))))
    .returning()
    .prepare(),
)

const stageEffect = prepared((db: StoreDrizzle) =>
  db
    .update(effects)
    .set({ stage: P('stage'), updatedAt: P('now'), revision: sql`${effects.revision} + 1` })
    .where(and(idIs(), live(), eq(effects.status, 'running')))
    .returning()
    .prepare(),
)

/** Cancel asked of a record that has not started: it ends here, never runs. */
const cancelPendingEffect = prepared((db: StoreDrizzle) =>
  db
    .update(effects)
    .set({
      status: 'cancelled',
      cancelRequested: true,
      finishedAt: P('now'),
      updatedAt: P('now'),
      revision: sql`${effects.revision} + 1`,
    })
    .where(and(idIs(), live(), eq(effects.status, 'pending')))
    .returning()
    .prepare(),
)

/** Cancel asked of a running (or lost-track) record: the executor decides. */
const flagCancelEffect = prepared((db: StoreDrizzle) =>
  db
    .update(effects)
    .set({ cancelRequested: true, updatedAt: P('now'), revision: sql`${effects.revision} + 1` })
    .where(
      and(
        idIs(),
        live(),
        inArray(effects.status, ['running', 'unknown']),
        eq(effects.cancelRequested, false),
      ),
    )
    .returning()
    .prepare(),
)

/** Off the feed. Only a record that has ended (or that nobody can settle: `unknown`). */
const tombstoneEffect = prepared((db: StoreDrizzle) =>
  db
    .update(effects)
    .set({ deletedAt: P('now'), updatedAt: P('now'), revision: sql`${effects.revision} + 1` })
    .where(and(idIs(), live(), inArray(effects.status, [...EffectLifecycle.terminal, 'unknown'])))
    .returning()
    .prepare(),
)

/** The sweep's expiry: pending records whose deadline has passed, a bounded batch. */
const expireDueEffects = prepared((db: StoreDrizzle) =>
  db
    .update(effects)
    .set({
      status: 'expired',
      errorCode: 'deadline',
      errorMessage: 'It waited past its deadline and never ran.',
      finishedAt: P('now'),
      updatedAt: P('now'),
      revision: sql`${effects.revision} + 1`,
    })
    .where(
      inArray(
        effects.id,
        db
          .select({ id: effects.id })
          .from(effects)
          .where(
            and(
              eq(effects.status, 'pending'),
              isNotNull(effects.deadlineAt),
              lte(effects.deadlineAt, param(effects.deadlineAt, 'now')),
              live(),
            ),
          )
          .orderBy(asc(effects.deadlineAt))
          .limit(P('limit')),
      ),
    )
    .returning()
    .prepare(),
)

/** Records in one status, oldest first, a bounded page (the sweep's re-dispatch). */
const effectsInStatus = preparedFamily((db: StoreDrizzle, status: 'pending' | 'running') =>
  db
    .select()
    .from(effects)
    .where(and(eq(effects.status, status), live()))
    // The index's own order after the equality: no sort.
    .orderBy(asc(effects.deadlineAt))
    .limit(P('limit'))
    .prepare(),
)

/** Finished records that were kept for the retention window, a bounded batch. */
const pruneFinishedEffects = prepared((db: StoreDrizzle) =>
  db
    .update(effects)
    .set({ deletedAt: P('now'), updatedAt: P('now'), revision: sql`${effects.revision} + 1` })
    .where(
      inArray(
        effects.id,
        db
          .select({ id: effects.id })
          .from(effects)
          .where(
            and(
              // `failed` and `unknown` stay until someone dismisses them (ADR 12 O5).
              inArray(effects.status, ['succeeded', 'cancelled', 'expired']),
              lte(effects.finishedAt, param(effects.finishedAt, 'cutoff')),
              live(),
            ),
          )
          .limit(P('limit')),
      ),
    )
    .returning()
    .prepare(),
)

/** Tombstones older than the feed's retention: gone from every device already. */
const purgeTombstones = prepared((db: StoreDrizzle) =>
  db
    .delete(effects)
    .where(
      inArray(
        effects.id,
        db
          .select({ id: effects.id })
          .from(effects)
          .where(lte(effects.deletedAt, param(effects.deletedAt, 'cutoff')))
          .limit(P('limit')),
      ),
    )
    .returning({ id: effects.id })
    .prepare(),
)

/** Under SQLite's bound-parameter limit, like the other batched readers. */
const AUDIENCE_CHUNK = 500

export interface NewEffect {
  readonly id: string
  readonly kind: string
  readonly target: { readonly kind: EffectTargetKind; readonly id: string }
  readonly input: unknown
  readonly deadlineAt: number | undefined
  readonly createdBy: UserId | null
}

export interface EffectSettlement {
  readonly error?: { readonly code: string; readonly message: string }
  readonly result?: unknown
  readonly stage?: string
}

/** Called with the rows of a committed write. */
export type EffectsCommittedListener = (rows: readonly EffectRow[]) => void

export class EffectsRepository {
  private readonly rootDb: StoreDrizzle
  private readonly transact: TransactionRunner
  private feedCapture: EffectFeedCapture | undefined
  private readonly listeners = new Set<EffectsCommittedListener>()

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.transact = queries.createOrJoinTransaction
  }

  /** Every committed write's rows, after the outermost commit: the trigger's one source. */
  onCommitted(listener: EffectsCommittedListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** A getter: transactions are routed ambiently (see `AutomationsRepository.db`). */
  protected get db(): StoreDrizzle {
    return this.rootDb
  }

  /** Install the feed capture, run inside every write's transaction. */
  setFeedCapture(capture: EffectFeedCapture): () => void {
    this.feedCapture = capture
    return () => {
      if (this.feedCapture === capture) this.feedCapture = undefined
    }
  }

  /** The one write funnel. */
  private async write(query: () => Promise<EffectSelect[]>): Promise<EffectRow[]> {
    return await this.transact(async () => {
      const written = (await query()).map(rowToEffect)
      if (written.length === 0) return written
      const capture = this.feedCapture
      if (capture !== undefined) await capture(written)
      afterCommit(() => {
        for (const listener of this.listeners) listener(written)
      }, 'effects:committed')
      return written
    })
  }

  private async one(query: () => Promise<EffectSelect[]>): Promise<EffectRow | undefined> {
    return (await this.write(query))[0]
  }

  async insert(effect: NewEffect, now: number): Promise<EffectRow> {
    const row = await this.one(
      async () =>
        await insertEffect(this.db).all({
          id: effect.id,
          kind: effect.kind,
          targetKind: effect.target.kind,
          targetId: effect.target.id,
          inputJson: JSON.stringify(effect.input ?? null),
          status: 'pending',
          deadlineAt: effect.deadlineAt ?? null,
          createdBy: effect.createdBy,
          now,
        }),
    )
    if (row === undefined) throw new Error(`effects: insert of ${effect.id} returned no row`)
    return row
  }

  /** By id, tombstones included. */
  async get(id: string): Promise<EffectRow | undefined> {
    const row = await effectById(this.db).get({ id })
    return row === undefined ? undefined : rowToEffect(row)
  }

  /** Each asked effect's audience facts, through the tombstone; absent ids are absent. */
  async audiencesOf(ids: readonly string[]): Promise<Map<string, EffectAudience>> {
    const out = new Map<string, EffectAudience>()
    const unique = [...new Set(ids)]
    for (let at = 0; at < unique.length; at += AUDIENCE_CHUNK) {
      const chunk = unique.slice(at, at + AUDIENCE_CHUNK)
      const size = inListSize(chunk.length)
      for (const row of await audiencesOfIds(this.db, size).all(inListValues(chunk, size))) {
        out.set(row.id, {
          targetKind: row.targetKind,
          targetId: row.targetId,
          createdBy: row.createdBy,
        })
      }
    }
    return out
  }

  /** `pending` → `running`. `undefined`: someone else claimed it, or it ended. */
  async claim(id: string, now: number): Promise<EffectRow | undefined> {
    return await this.one(async () => await claimEffect(this.db).all({ id, now }))
  }

  /** A guarded move into `to`. `undefined`: the record is not where `to` may come from. */
  async settle(
    id: string,
    to: EffectStatus,
    settlement: EffectSettlement,
    now: number,
  ): Promise<EffectRow | undefined> {
    return await this.one(
      async () =>
        await settleEffect(this.db, to).all({
          id,
          now,
          errorCode: settlement.error?.code ?? null,
          errorMessage: settlement.error?.message ?? null,
          resultJson: settlement.result === undefined ? null : JSON.stringify(settlement.result),
          stage: settlement.stage ?? null,
        }),
    )
  }

  async setStage(id: string, stage: string, now: number): Promise<EffectRow | undefined> {
    return await this.one(async () => await stageEffect(this.db).all({ id, stage, now }))
  }

  /** Cancel: a pending record ends `cancelled`; a running one is flagged for its executor. */
  async requestCancel(id: string, now: number): Promise<EffectRow | undefined> {
    return (
      (await this.one(async () => await cancelPendingEffect(this.db).all({ id, now }))) ??
      (await this.one(async () => await flagCancelEffect(this.db).all({ id, now })))
    )
  }

  /** Dismiss: off the feed. `undefined` for a record that has not ended. */
  async tombstone(id: string, now: number): Promise<EffectRow | undefined> {
    return await this.one(async () => await tombstoneEffect(this.db).all({ id, now }))
  }

  async expireDue(now: number, limit: number): Promise<EffectRow[]> {
    return await this.write(async () => await expireDueEffects(this.db).all({ now, limit }))
  }

  async listInStatus(status: 'pending' | 'running', limit: number): Promise<EffectRow[]> {
    return (await effectsInStatus(this.db, status).all({ limit })).map(rowToEffect)
  }

  async pruneFinished(cutoff: number, now: number, limit: number): Promise<EffectRow[]> {
    return await this.write(
      async () => await pruneFinishedEffects(this.db).all({ cutoff, now, limit }),
    )
  }

  /** Hard-delete tombstones; the feed removed them when they were tombstoned. */
  async purgeTombstones(cutoff: number, limit: number): Promise<number> {
    return (await purgeTombstones(this.db).all({ cutoff, limit })).length
  }
}
