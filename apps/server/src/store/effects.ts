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
import type { WriteScope } from '@podium/sync'
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm'
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
  /** Who acted: `session:<id>` for an agent, the user id for a person. */
  readonly actor: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly revision: number
  readonly deletedAt: number | undefined
}

/** Who an effect's audience is read from, through the tombstone. */
export interface EffectAudience {
  /** The executor's kind: an instance-wide kind is read by every admin (POD-6358). */
  readonly kind: string
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
    actor: r.actor,
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
      actor: P('actor'),
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
      kind: effects.kind,
      targetKind: effects.targetKind,
      targetId: effects.targetId,
      createdBy: effects.createdBy,
    })
    .from(effects)
    .where(inListOf(effects.id, size))
    .prepare(),
)

// The live records on targets of SEVERAL kinds in one read (POD-6401): every
// listed kind crossed with every listed id, seeking `idx_effects_target`; the
// caller keeps only the (kind, id) pairs it asked for. Keyed `<kinds>x<ids>`.
// The index is named with INDEXED BY: on default statistics the planner costs
// `deleted_at IS NULL` on `idx_effects_deleted` below the crossed seeks, and
// that walk reads every live record (POD-6599). Ordered as the index is, by
// target, then `created_at`, then rowid, so the seeks need no sort: the caller
// orders across targets itself and needs only each target's oldest-first order.
const liveOnTargetKeys = preparedFamily((db: StoreDrizzle, shape: string) => {
  const [kindSize, idSize] = shape.split('x').map(Number) as [number, number]
  return (
    db
      // Bare column names: the FROM is an INDEXED BY clause, not the table object.
      .select({
        id: sql<string>`id`,
        targetKind: sql<string>`target_kind`,
        targetId: sql<string>`target_id`,
      })
      .from(sql`${effects} INDEXED BY idx_effects_target`)
      .where(
        and(
          inListOf(effects.targetKind, kindSize, 'kind'),
          inListOf(effects.targetId, idSize, 'id'),
          live(),
        ),
      )
      .orderBy(
        asc(effects.targetKind),
        asc(effects.targetId),
        asc(effects.createdAt),
        asc(sql`rowid`),
      )
      .prepare()
  )
})

/** One live record's place, as {@link EffectsRepository.liveOnTargets} returns it. */
export interface EffectOnTarget {
  readonly id: string
  readonly targetKind: string
  readonly targetId: string
}

/** Which records {@link EffectsRepository.newestOnTarget} asks for. */
export type EffectPhase = 'active' | 'succeeded'

const PHASE_STATUSES: Record<EffectPhase, readonly EffectStatus[]> = {
  active: ['pending', 'running'],
  succeeded: ['succeeded'],
}

/** One kind's newest live record on one target in a phase (`idx_effects_kind_target`). */
const newestOnTargetIn = preparedFamily((db: StoreDrizzle, phase: EffectPhase) =>
  db
    .select()
    .from(effects)
    .where(
      and(
        eq(effects.kind, param(effects.kind, 'kind')),
        eq(effects.targetKind, param(effects.targetKind, 'targetKind')),
        eq(effects.targetId, param(effects.targetId, 'targetId')),
        statusIn(PHASE_STATUSES[phase]),
        live(),
      ),
    )
    // The index's own order after its three equalities: no sort.
    .orderBy(desc(effects.createdAt))
    .limit(1)
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
      // A settlement without a result keeps the one published while it ran.
      resultJson: sql`coalesce(${P('resultJson')}, ${effects.resultJson})`,
      stage: P('stage'),
      finishedAt: EffectLifecycle.isTerminal(to) ? P('now') : sql`${effects.finishedAt}`,
      updatedAt: P('now'),
      revision: sql`${effects.revision} + 1`,
    })
    .where(and(idIs(), live(), statusIn(EffectLifecycle.allowedFrom(to))))
    .returning()
    .prepare(),
)

/** A stage, and with it the result known so far when one is given (POD-6358). */
const stageEffect = prepared((db: StoreDrizzle) =>
  db
    .update(effects)
    .set({
      stage: P('stage'),
      resultJson: sql`coalesce(${P('resultJson')}, ${effects.resultJson})`,
      updatedAt: P('now'),
      revision: sql`${effects.revision} + 1`,
    })
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
  readonly actor?: string | null
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

  /**
   * The one write funnel. `effects` is a synced table: every public writer takes
   * the commit's write scope (ADR 12 D9, POD-6594), so it runs inside a
   * `Ledger.commit` made by a sync command or a declared server origin. The
   * capture installed here appends the rows' feed changes in that same unit.
   */
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

  async insert(_scope: WriteScope, effect: NewEffect, now: number): Promise<EffectRow> {
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
          actor: effect.actor ?? null,
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

  /**
   * The newest live record of one kind on one target that is still running
   * (`active`) or that succeeded: a machine's last scan, or the scan already
   * under way there.
   */
  async newestOnTarget(
    kind: string,
    target: { readonly kind: EffectTargetKind; readonly id: string },
    phase: EffectPhase,
  ): Promise<EffectRow | undefined> {
    const row = await newestOnTargetIn(this.db, phase).get({
      kind,
      targetKind: target.kind,
      targetId: target.id,
    })
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
          kind: row.kind,
          targetKind: row.targetKind,
          targetId: row.targetId,
          createdBy: row.createdBy,
        })
      }
    }
    return out
  }

  /**
   * The live records on any of these targets, oldest first per target: what a
   * change in a target's audience re-scopes (POD-6401). Tombstones are left out,
   * since they have no value left to deliver.
   */
  async liveOnTargets(
    targets: readonly { readonly kind: string; readonly id: string }[],
  ): Promise<EffectOnTarget[]> {
    if (targets.length === 0) return []
    const wanted = new Set(targets.map((target) => `${target.kind}\u0000${target.id}`))
    const kinds = [...new Set(targets.map((target) => target.kind))]
    const ids = [...new Set(targets.map((target) => target.id))]
    const kindSize = inListSize(kinds.length)
    const out: EffectOnTarget[] = []
    for (let at = 0; at < ids.length; at += AUDIENCE_CHUNK) {
      const chunk = ids.slice(at, at + AUDIENCE_CHUNK)
      const idSize = inListSize(chunk.length)
      const rows = await liveOnTargetKeys(this.db, `${kindSize}x${idSize}`).all(
        inListValues(chunk, idSize, 'id', inListValues(kinds, kindSize, 'kind')),
      )
      for (const row of rows) {
        if (wanted.has(`${row.targetKind}\u0000${row.targetId}`)) out.push(row)
      }
    }
    return out
  }

  /** `pending` → `running`. `undefined`: someone else claimed it, or it ended. */
  async claim(_scope: WriteScope, id: string, now: number): Promise<EffectRow | undefined> {
    return await this.one(async () => await claimEffect(this.db).all({ id, now }))
  }

  /** A guarded move into `to`. `undefined`: the record is not where `to` may come from. */
  async settle(
    _scope: WriteScope,
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

  /**
   * A running record's progress. `result` is what the executor already knows
   * of its answer (an update's operation id), published while it runs; absent,
   * the result stays as it was.
   */
  async setStage(
    _scope: WriteScope,
    id: string,
    stage: string,
    now: number,
    result?: unknown,
  ): Promise<EffectRow | undefined> {
    const resultJson = result === undefined ? null : JSON.stringify(result)
    return await this.one(
      async () => await stageEffect(this.db).all({ id, stage, now, resultJson }),
    )
  }

  /** Cancel: a pending record ends `cancelled`; a running one is flagged for its executor. */
  async requestCancel(_scope: WriteScope, id: string, now: number): Promise<EffectRow | undefined> {
    return (
      (await this.one(async () => await cancelPendingEffect(this.db).all({ id, now }))) ??
      (await this.one(async () => await flagCancelEffect(this.db).all({ id, now })))
    )
  }

  /** Dismiss: off the feed. `undefined` for a record that has not ended. */
  async tombstone(_scope: WriteScope, id: string, now: number): Promise<EffectRow | undefined> {
    return await this.one(async () => await tombstoneEffect(this.db).all({ id, now }))
  }

  async expireDue(_scope: WriteScope, now: number, limit: number): Promise<EffectRow[]> {
    return await this.write(async () => await expireDueEffects(this.db).all({ now, limit }))
  }

  async listInStatus(status: 'pending' | 'running', limit: number): Promise<EffectRow[]> {
    return (await effectsInStatus(this.db, status).all({ limit })).map(rowToEffect)
  }

  async pruneFinished(
    _scope: WriteScope,
    cutoff: number,
    now: number,
    limit: number,
  ): Promise<EffectRow[]> {
    return await this.write(
      async () => await pruneFinishedEffects(this.db).all({ cutoff, now, limit }),
    )
  }

  /** Hard-delete tombstones; the feed removed them when they were tombstoned. */
  async purgeTombstones(_scope: WriteScope, cutoff: number, limit: number): Promise<number> {
    return (await purgeTombstones(this.db).all({ cutoff, limit })).length
  }
}
