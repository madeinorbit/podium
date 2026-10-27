import { createPoolNavigationProvider } from '@podium/client-graph/navigation-provider'
import { loadingNavigationProvider } from '@podium/client-core/engine'
/**
 * The feeds a pool under test consumes from a scenario engine: the row source
 * and the engine-backed locals channel, drained together after each write,
 * plus the per-row scenario writes (methodology #1-#10) in order.
 */
import type { MobxPool } from '@podium/client-graph/pool'
import { attachRuntimeWriter, createRuntimeTransactions } from '@podium/client-graph/runtime-pool'
import type { LocalsSourceHandle } from '@podium/client-graph/shared/locals-source'
import type { RowSourceHandle } from '@podium/client-graph/shared/row-source'
import type { PoolTransactions } from '@podium/client-graph/write/transactions'
import type { LocalsSource, RowSource } from '../../shared/src/arm'
import { createRowSource, type RowSourceMode } from '../../shared/src/row-source'
import {
  armMarkReadRejection,
  type ScenarioEngine,
  writeArchiveIssue,
  writeBurst50,
  writeClockTick,
  writeEvictIssue,
  writeEvictKeeperIssue,
  writeHeartbeat,
  writeNewIssue,
  writeOptimisticEcho,
  writeOptimisticPress,
  writeParentReassignment,
  writePhaseChange,
  writeSelectionClick,
  writeStageMove,
  writeTitleRename,
} from '../../shared/src/scenarios'
import type { SliceLocals } from '../../shared/src/slice-types'
import { createEngineLocals } from './engine-locals'
import { insideArm, outsideArm } from './work-meter'

/** What a fenced arm consumes: the row source and the locals channel, drained together. */
export interface FenceFeeds {
  rows: RowSourceHandle
  locals: LocalsSourceHandle<SliceLocals>
  /** Drain both, rows first: what each step runs after its write. */
  flush(): void
  /**
   * Per-row reads (`RowSource.row`) the arm has made through `rows.source`
   * since the feeds opened: a lazy arm's loads (G2). Non-zero means the arm is
   * lazy.
   */
  rowReads(): number
  /**
   * POD-4746 — the rows (`kind:id`) the row feed's events named since the
   * last call, then forgets them: a step's changed items.
   */
  takeNamed(): string[]
  /** `owned` feeds: the log, which `attachPool` hands the arm's pool. */
  readonly transactions?: PoolTransactions
  /** `owned` feeds: attach the log to the arm's pool as the host does. */
  attachPool(pool: MobxPool): void
  dispose(): void
}

/**
 * `owned` (POD-5432): the production wiring of the pool owning optimism — the
 * runtime's transaction log paints the host's issue and session rows (`pooled`
 * feed) and the runtime's actions route through it. The arm's pool takes the
 * log through `attachPool`.
 */
export type FenceFeedMode = RowSourceMode | 'owned'

export function openFenceFeeds(ctx: ScenarioEngine, mode: FenceFeedMode): FenceFeeds {
  const transactions = mode === 'owned' ? createRuntimeTransactions(ctx.engine) : null
  const raw = createRowSource(
    ctx.engine,
    ctx.replica,
    transactions === null
      ? { mode: mode as RowSourceMode }
      : { mode: 'pooled', pending: transactions.pending },
  )
  let stopWriter = (): void => {}
  if (transactions !== null) {
    transactions.bind(raw)
    stopWriter = attachRuntimeWriter(ctx.engine, transactions)
  }
  const rawLocals = createEngineLocals(ctx.engine)
  const clockStops: (() => void)[] = []
  let rowReads = 0
  let named = new Set<string>()
  const row = raw.source.row?.bind(raw.source)
  // The feed's own work runs outside the arm; each listener call is the arm's
  // (`work-meter.ts`). No-ops when no work is being measured.
  const source: RowSource = {
    snapshot: (kind) => outsideArm(() => raw.source.snapshot(kind)),
    ...(raw.source.companions
      ? { companions: () => outsideArm(() => raw.source.companions!()) }
      : {}),
    ...(raw.source.issueIdByRef
      ? { issueIdByRef: (ref: string) => outsideArm(() => raw.source.issueIdByRef!(ref)) }
      : {}),
    // POD-5407: the feed's own cold index, as production hands it to the pool:
    // the feed applies each publication to it before the arm hears it, so its
    // upkeep is the feed's work, not the arm's.
    ...(raw.source.cold
      ? { cold: (summaries) => outsideArm(() => raw.source.cold!(summaries)) }
      : {}),
    // POD-6136: the feed's facts index covers cold history sessions; the
    // pool's own index would count only the sessions it loaded.
    ...(raw.source.issueSessionFact ? { issueSessionFact: raw.source.issueSessionFact } : {}),
    subscribe: (listener) =>
      raw.source.subscribe((event) => {
        for (const record of event.rows) named.add(`${record.kind}:${record.id}`)
        insideArm(() => listener(event))
      }),
    ...(row === undefined
      ? {}
      : {
          row(kind: 'issue' | 'session', id: string) {
            rowReads += 1
            return outsideArm(() => row(kind, id))
          },
        }),
  }
  const localsSource: LocalsSource<SliceLocals> = {
    get: () => rawLocals.source.get(),
    subscribe: (listener) =>
      rawLocals.source.subscribe((changed) => insideArm(() => listener(changed))),
  }
  const locals: LocalsSourceHandle<SliceLocals> = {
    source: localsSource,
    get stats() {
      return rawLocals.stats
    },
    flush: () => rawLocals.flush(),
    dispose: () => rawLocals.dispose(),
  }
  const rows: RowSourceHandle = {
    source,
    get stats() {
      return raw.stats
    },
    flush: () => raw.flush(),
    dispose: () => raw.dispose(),
  }
  const feeds: FenceFeeds = {
    rows,
    locals,
    ...(transactions === null ? {} : { transactions }),
    attachPool(pool: MobxPool): void {
      const clock = (ctx.engine as unknown as { fixtureClock?: { subscribe(tick: (now: number) => void): () => void } }).fixtureClock
      if (clock) clockStops.push(clock.subscribe(value => pool.clock.advance(value)))
      ctx.engine.setNavigationProvider(createPoolNavigationProvider(pool))
      if (transactions !== null)
        pool.attachTransactions(transactions, true)
    },
    flush(): void {
      rows.flush()
      locals.flush()
    },
    rowReads: () => rowReads,
    takeNamed(): string[] {
      const taken = [...named].sort()
      named = new Set()
      return taken
    },
    dispose(): void {
      ctx.engine.setNavigationProvider(loadingNavigationProvider)
      stopWriter()
      for (const stop of clockStops) stop()
      transactions?.dispose()
      rows.dispose()
      locals.dispose()
    },
  }
  return feeds
}

/** One per-row scenario write, settled. */
export interface FenceScenario {
  scenario: string
  write(ctx: ScenarioEngine): Promise<unknown>
}

/** #8b: one tick across the finished-grace boundary (`SIDEBAR_FINISHED_GRACE_MS`). */
const GRACE_CROSSING_TICK_MS = 24 * 60 * 60 * 1000

/** Every per-row scenario (#1-#10), in methodology order, on one engine. */
export const FENCE_SCENARIOS: readonly FenceScenario[] = [
  { scenario: 'unrelatedHeartbeat', write: writeHeartbeat },
  { scenario: 'visibleSessionPhaseChange', write: writePhaseChange },
  { scenario: 'selectionClick', write: (ctx) => writeSelectionClick(ctx) },
  { scenario: 'visibleTitleRename', write: (ctx) => writeTitleRename(ctx) },
  { scenario: 'stageMoveAcrossGroups', write: (ctx) => writeStageMove(ctx) },
  { scenario: 'newIssue', write: (ctx) => writeNewIssue(ctx) },
  { scenario: 'archiveIssue', write: (ctx) => writeArchiveIssue(ctx) },
  { scenario: 'evictWithoutRevision', write: (ctx) => writeEvictIssue(ctx) },
  { scenario: 'evictKeeperWithoutRevision', write: (ctx) => writeEvictKeeperIssue(ctx) },
  { scenario: 'parentReassignment', write: (ctx) => writeParentReassignment(ctx) },
  { scenario: 'clockTick', write: (ctx) => writeClockTick(ctx, 60_000) },
  { scenario: 'clockGraceCrossing', write: (ctx) => writeClockTick(ctx, GRACE_CROSSING_TICK_MS) },
  { scenario: 'optimisticPress', write: (ctx) => writeOptimisticPress(ctx) },
  { scenario: 'optimisticEcho', write: (ctx) => writeOptimisticEcho(ctx) },
  {
    scenario: 'optimisticPressRejected',
    write: async (ctx) => {
      armMarkReadRejection(ctx)
      await writeOptimisticPress(ctx)
    },
  },
  { scenario: 'burst50', write: writeBurst50 },
]
