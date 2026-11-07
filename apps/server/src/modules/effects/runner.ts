/**
 * THE ONE GENERIC TRIGGER AND THE RECOVERY SWEEP (ADR 12 D5 E2, POD-6357).
 *
 * FAST PATH. The runner listens to the effects repository's committed rows,
 * which arrive as an after-commit effect: after the outermost commit, outside
 * its lease, and never for a write that rolled back. A committed `pending` row is dispatched to the executor
 * registered for its kind. That is the transactional-outbox guarantee: a
 * record is dispatched if and only if it committed, at least once.
 *
 * RECOVERY PATH. At startup and on a slow sweep:
 *   - `pending` records past their deadline expire and never run;
 *   - `pending` records are dispatched again (a trigger lost in a crash between
 *     the commit and the dispatch);
 *   - `running` records with no live run in this process (the server stopped
 *     mid-run) go to the executor's `recover`, which checks the world and
 *     answers `succeeded`, `failed` or `unknown`. A `running` record is never run
 *     again silently: doing a merge twice can be worse than not knowing;
 *   - ended records past the retention window leave the feed, except `failed`
 *     and `unknown`, which stay until someone dismisses them (ADR 12 O5);
 *     tombstones past it are deleted.
 *
 * EXACTLY ONE RUN. A dispatch claims the record with a guarded UPDATE
 * (`pending` → `running`); of two dispatches (the fast path and the sweep, or two
 * commits that both showed it `pending`) exactly one gets the row back. The
 * in-flight set is live runtime state (which runs this process has going), not a
 * copy of the table: it only spares a second dispatch its claim statement and
 * tells the sweep which `running` rows are live.
 *
 * STATUS IS WRITTEN AS THE SYSTEM, CAUSED BY THE RECORD. Every write here runs in
 * a provenance scope whose `causationId` is the record id and which carries no
 * `mutationId`: it is not part of the create's write, and its receipt does not
 * cover it.
 */

import { createLogger, describeError } from '@podium/logger'
import type { EffectStatus } from '@podium/model'
import type { LedgerWriter, WriteScope } from '@podium/sync'
import type { EffectRow, EffectsRepository } from '../../store/effects'
import { withWriteProvenance } from '../../write-provenance'
import type {
  EffectExecutor,
  EffectExecutorRegistry,
  EffectOutcome,
  EffectRunContext,
} from './registry'

const log = createLogger('server:effects')

/** How often the sweep runs after the boot sweep. */
export const EFFECT_SWEEP_INTERVAL_MS = 60_000
/** How long an ended record stays on the feed (succeeded, cancelled, expired). */
export const EFFECT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** Rows one sweep step reads or writes at most; the next sweep takes the rest. */
export const EFFECT_SWEEP_BATCH = 100

export type EffectsRunnerRepository = Pick<
  EffectsRepository,
  | 'onCommitted'
  | 'get'
  | 'claim'
  | 'settle'
  | 'setStage'
  | 'expireDue'
  | 'listInStatus'
  | 'pruneFinished'
  | 'purgeTombstones'
>

export interface EffectsRunnerDeps {
  readonly repo: EffectsRunnerRepository
  /** The runner's own writer, a `server` origin (`effects.runner`). */
  readonly writer: Pick<LedgerWriter, 'commit'>
  readonly registry: EffectExecutorRegistry
  readonly now: () => number
  /** Schedule the slow sweep; returns a cancel. Injected so tests drive time. */
  readonly every?: (ms: number, fn: () => void) => () => void
}

interface LiveRun {
  /** Cancel or stop. */
  readonly abort: AbortController
  /** Stop alone. */
  readonly stop: AbortController
}

const defaultEvery = (ms: number, fn: () => void): (() => void) => {
  const timer = setInterval(fn, ms)
  timer.unref?.()
  return () => clearInterval(timer)
}

export class EffectsRunner {
  /** Runs this process has going, by record id. */
  private readonly live = new Map<string, LiveRun>()
  /** Every dispatch and recovery in flight, so `idle()` can wait for them. */
  private readonly work = new Set<Promise<void>>()
  private stopTimer: (() => void) | undefined
  private unsubscribe: (() => void) | undefined
  private sweeping: Promise<void> | undefined
  private stopped = false

  constructor(private readonly deps: EffectsRunnerDeps) {}

  /** Listen to commits, sweep once now, then on the slow cadence. */
  start(): void {
    if (this.unsubscribe !== undefined) return
    this.unsubscribe = this.deps.repo.onCommitted((rows) => this.onCommitted(rows))
    const every = this.deps.every ?? defaultEvery
    this.stopTimer = every(EFFECT_SWEEP_INTERVAL_MS, () => {
      void this.sweep()
    })
    void this.sweep()
  }

  /** Stop listening and sweeping; aborts live runs and waits for them to settle. */
  async stop(): Promise<void> {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.stopTimer?.()
    this.stopTimer = undefined
    for (const run of this.live.values()) {
      run.stop.abort()
      run.abort.abort()
    }
    await this.idle()
  }

  /** Resolves once every dispatch, recovery and sweep started so far has settled. */
  async idle(): Promise<void> {
    while (this.work.size > 0 || this.sweeping !== undefined) {
      await Promise.allSettled([...this.work, ...(this.sweeping ? [this.sweeping] : [])])
    }
  }

  /** The fast path: after the outermost commit, never for a rolled-back write. */
  private onCommitted(rows: readonly EffectRow[]): void {
    if (this.stopped) return
    for (const row of rows) {
      if (row.deletedAt !== undefined) continue
      if (row.status === 'pending') {
        this.track(this.dispatch(row.id))
      } else if (row.cancelRequested) {
        // A cancel committed while the run is live: tell the executor.
        this.live.get(row.id)?.abort.abort()
      }
    }
  }

  private track(promise: Promise<void>): void {
    this.work.add(promise)
    void promise.finally(() => this.work.delete(promise))
  }

  /**
   * Dispatch the pending records of one kind now (POD-6398): what a kind with
   * `ready` asks for when the world changes (a machine attached), instead of
   * waiting for the next sweep. The dispatch asks `ready` again.
   */
  async poke(kind: string): Promise<void> {
    if (this.stopped) return
    const rows = await this.deps.repo.listInStatus('pending', EFFECT_SWEEP_BATCH)
    const runs: Promise<void>[] = []
    for (const row of rows) {
      if (row.kind !== kind || this.live.has(row.id)) continue
      const run = this.dispatch(row.id)
      this.track(run)
      runs.push(run)
    }
    await Promise.all(runs)
  }

  /** The recovery path. One sweep at a time; a sweep asked for during one joins it. */
  async sweep(): Promise<void> {
    if (this.stopped) return
    if (this.sweeping !== undefined) return await this.sweeping
    const run = this.sweepOnce().catch((error: unknown) => {
      log.warn('effects: sweep failed', { error: describeError(error) })
    })
    this.sweeping = run
    try {
      await run
    } finally {
      this.sweeping = undefined
    }
  }

  private async sweepOnce(): Promise<void> {
    const { repo, now } = this.deps
    // Expiry first, so a record past its deadline is never dispatched below.
    await this.sweepWrite(async (scope) => await repo.expireDue(scope, now(), EFFECT_SWEEP_BATCH))
    for (const row of await repo.listInStatus('pending', EFFECT_SWEEP_BATCH)) {
      if (!this.live.has(row.id)) this.track(this.dispatch(row.id))
    }
    for (const row of await repo.listInStatus('running', EFFECT_SWEEP_BATCH)) {
      if (!this.live.has(row.id)) this.track(this.recover(row))
    }
    await this.sweepWrite(
      async (scope) =>
        await repo.pruneFinished(scope, now() - EFFECT_RETENTION_MS, now(), EFFECT_SWEEP_BATCH),
    )
    await this.sweepWrite(
      async (scope) =>
        await repo.purgeTombstones(scope, now() - EFFECT_RETENTION_MS, EFFECT_SWEEP_BATCH),
    )
  }

  /** Claim one record and run it. Safe to call any number of times for one id. */
  private async dispatch(id: string): Promise<void> {
    if (this.live.has(id) || this.stopped) return
    const live: LiveRun = { abort: new AbortController(), stop: new AbortController() }
    // Held from before the claim, so a second dispatch in the same tick returns.
    this.live.set(id, live)
    try {
      const { repo, registry, now } = this.deps
      const row = await repo.get(id)
      if (row === undefined || row.status !== 'pending' || row.deletedAt !== undefined) return
      const executor = registry.get(row.kind)
      if (executor === undefined) {
        await this.write(id, async (scope) =>
          repo.settle(scope, id, 'failed', { error: noExecutor(row.kind) }, now()),
        )
        return
      }
      if (row.deadlineAt !== undefined && row.deadlineAt <= now()) {
        await this.write(id, async (scope) =>
          repo.settle(scope, id, 'expired', { error: DEADLINE }, now()),
        )
        return
      }
      const parsed = executor.input.safeParse(row.input)
      if (!parsed.success) {
        await this.write(id, async (scope) =>
          repo.settle(scope, id, 'failed', { error: badInput(parsed.error.message) }, now()),
        )
        return
      }
      // Not ready (POD-6398): stays pending, untouched, for the sweep or a poke.
      if (executor.ready !== undefined && !(await executor.ready(row, parsed.data))) return
      const claimed = await this.write(id, async (scope) => await repo.claim(scope, id, now()))
      if (claimed === undefined) return
      const outcome = await this.runExecutor(executor, claimed, parsed.data, live, 'run')
      await this.settle(claimed, outcome)
    } catch (error) {
      log.warn('effects: dispatch failed', { id, error: describeError(error) })
    } finally {
      this.live.delete(id)
    }
  }

  /** A `running` record with no live run: the executor checks the world. */
  private async recover(row: EffectRow): Promise<void> {
    if (this.live.has(row.id) || this.stopped) return
    const live: LiveRun = { abort: new AbortController(), stop: new AbortController() }
    this.live.set(row.id, live)
    try {
      const executor = this.deps.registry.get(row.kind)
      const parsed = executor?.input.safeParse(row.input)
      const outcome: EffectOutcome =
        executor?.recover === undefined || parsed === undefined || !parsed.success
          ? { status: 'unknown', error: LOST_TRACK }
          : await this.runExecutor(executor, row, parsed.data, live, 'recover')
      await this.settle(row, outcome)
    } catch (error) {
      log.warn('effects: recovery failed', { id: row.id, error: describeError(error) })
    } finally {
      this.live.delete(row.id)
    }
  }

  private async runExecutor(
    executor: EffectExecutor,
    record: EffectRow,
    input: unknown,
    live: LiveRun,
    which: 'run' | 'recover',
  ): Promise<EffectOutcome> {
    const { repo, now } = this.deps
    const ctx: EffectRunContext<unknown> = {
      record,
      input,
      signal: live.abort.signal,
      stopped: live.stop.signal,
      stage: async (stage, result) => {
        await this.write(
          record.id,
          async (scope) => await repo.setStage(scope, record.id, stage, now(), result),
        )
      },
      cancelRequested: async () => (await repo.get(record.id))?.cancelRequested === true,
    }
    try {
      const fn = which === 'run' ? executor.run : executor.recover
      if (fn === undefined) return { status: 'unknown', error: LOST_TRACK }
      return await fn.call(executor, ctx)
    } catch (error) {
      // The executor lost track after the effect may have happened.
      log.warn('effects: executor threw', {
        id: record.id,
        kind: record.kind,
        error: describeError(error),
      })
      return {
        status: 'unknown',
        error: { code: 'executor-error', message: describeError(error) },
      }
    }
  }

  private async settle(record: EffectRow, outcome: EffectOutcome): Promise<void> {
    // The work goes on without this run: the record stays running for recovery.
    if (outcome.status === 'running') return
    const { repo, now } = this.deps
    const to: EffectStatus = outcome.status
    const settlement =
      outcome.status === 'succeeded'
        ? { ...(outcome.result === undefined ? {} : { result: outcome.result }) }
        : outcome.status === 'failed'
          ? {
              error: outcome.error,
              ...(outcome.result === undefined ? {} : { result: outcome.result }),
            }
          : outcome.status === 'unknown'
            ? { error: outcome.error ?? LOST_TRACK }
            : {}
    const settled = await this.write(record.id, async (scope) =>
      repo.settle(scope, record.id, to, settlement, now()),
    )
    if (settled === undefined) {
      log.info('effects: outcome not applied; the record moved on', {
        id: record.id,
        to,
      })
    }
  }

  /** One status write as the system, caused by the record. */
  /**
   * One write of the runner's, under the record's causation, as a commit on the
   * runner's own writer (`effects.runner`, ADR 12 D9): the row change gets its
   * scope there, and the effects table's capture appends its feed change in the
   * same unit.
   */
  private async write<T>(recordId: string, fn: (scope: WriteScope) => Promise<T>): Promise<T> {
    return await withWriteProvenance(
      { causationId: recordId },
      async () => (await this.deps.writer.commit({ write: fn, changes: () => [] })).result,
    )
  }

  /** A sweep's write, on the runner's own writer. */
  private async sweepWrite<T>(fn: (scope: WriteScope) => Promise<T>): Promise<T> {
    return (await this.deps.writer.commit({ write: fn, changes: () => [] })).result
  }
}

const DEADLINE = { code: 'deadline', message: 'It waited past its deadline and never ran.' }
const LOST_TRACK = {
  code: 'lost-track',
  message: 'The server stopped while this was running; it may or may not have happened.',
}
const noExecutor = (kind: string) => ({
  code: 'no-executor',
  message: `This server does not run ${kind} effects.`,
})
const badInput = (message: string) => ({ code: 'invalid-input', message })
