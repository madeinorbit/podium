/**
 * POD-5594 — startup states for the "no wrong number" check
 * (`no-wrong-number.ts`), over the two-axis corpus (`buildCorpusCell`).
 *
 * `openStartupFeed(cell)` runs the real engine on the corpus, reads the pooled
 * row feed the app's pool reads once, and drops the engine (memory: the check
 * then holds only the rows). The feed's `source` serves those rows. From it:
 * - `fullPool`: the full bootstrap, every row resident (the CONTROL);
 * - `partialPool`: only the active rows (what the client's cold rule keeps
 *   resident), with nothing saying history is missing: today's pool on a
 *   partial store without markers;
 * - `lazyPool`: the production lazy pool on the whole feed before any cold
 *   row is loaded (`hydrateAll` then loads them as the app does).
 * Later issues add their own states (markers, active-first stream) and feed
 * them to the same check.
 */
import { createWorklistPool } from '@podium/client-graph/create'
import { ISSUE_BOARD_SUMMARIES } from '@podium/client-graph/issue-board-schema'
import { MISSION_VIEW_SUMMARIES } from '@podium/client-graph/mission-view-schema'
import { MobxPool } from '@podium/client-graph/pool'
import { type EntityName, SCHEMA, tableColdRule } from '@podium/client-graph/shared/schema'
import { fixedLocals } from '@podium/client-graph/shared/locals-source'
import type { RowRecord, RowSource } from '@podium/client-graph/shared/source'
import type { SliceLocals } from '@podium/client-graph/shared/slice-types'
import { mergePoolSummaries } from '@podium/client-graph/source-registry'
import { runInAction } from 'mobx'
import { referenceState } from '../../../diagnostics/reference-state'
import { createRowSource } from '../../../shared/src/row-source'
import { startEngineOnCorpus } from '../../../shared/src/scenarios'
import { buildCorpusCell, type CorpusCell } from '../fixture'
import { ask, type StartupQuestion } from './no-wrong-number'

export interface StartupFeed {
  /** The rows as a static feed: what a lazy pool reads its cold rows from. */
  readonly source: RowSource
  /** Every row the feed carries, as one bootstrap would install them. */
  readonly rows: readonly RowRecord[]
  readonly locals: SliceLocals
  /** The client's own cold rule over the feed (`tableColdRule`): history. */
  readonly cold: (kind: RowRecord['kind'], id: string) => boolean
}

export async function openStartupFeed(cell: CorpusCell, seed = 4443): Promise<StartupFeed> {
  const ctx = await startEngineOnCorpus(buildCorpusCell(cell, seed))
  let rows: RowRecord[], companions: RowRecord[], locals: SliceLocals
  const handle = createRowSource(ctx.engine, ctx.replica, { mode: 'pooled' })
  try {
    const live = handle.source
    companions = (live.companions?.() ?? []).filter((row) => row.value !== undefined)
    rows = [...live.snapshot('session'), ...live.snapshot('issue'), ...live.snapshot('worktree')]
      .filter((row) => row.value !== undefined)
      .concat(companions)
    locals = { selectedIssueId: null, coarseNow: referenceState(ctx.engine).coarseNow }
  } finally {
    handle.dispose()
    ctx.dispose()
  }
  const tables = new Map<string, Map<string, unknown>>()
  for (const row of rows) {
    let table = tables.get(row.kind)
    if (!table) tables.set(row.kind, (table = new Map()))
    table.set(row.id, row.value)
  }
  const rule = tableColdRule(SCHEMA, (entity) => tables.get(entity), locals.coarseNow)
  const cold = (kind: RowRecord['kind'], id: string) =>
    (kind === 'issue' || kind === 'session') && rule(kind as EntityName, id)
  const ownRows = new Map<RowRecord['kind'], RowRecord[]>()
  for (const row of rows.slice(0, rows.length - companions.length)) {
    let list = ownRows.get(row.kind)
    if (!list) ownRows.set(row.kind, (list = []))
    list.push(row)
  }
  const source: RowSource = {
    snapshot: (kind) => [...(ownRows.get(kind) ?? [])],
    companions: () => companions,
    subscribe: () => () => {},
    row: (kind, id) => tables.get(kind)?.get(id) as RowRecord['value'],
  }
  return { source, rows, locals, cold }
}

/** The control: one full bootstrap, every row resident. */
export function fullPool(feed: StartupFeed): MobxPool {
  const pool = new MobxPool(feed.locals)
  runInAction(() => pool.apply({ type: 'replace', rows: [...feed.rows] }))
  return pool
}

/** Only the active rows, and nothing that says history is missing. */
export function partialPool(feed: StartupFeed): MobxPool {
  const pool = new MobxPool(feed.locals)
  runInAction(() => pool.apply({ type: 'replace', rows: feed.rows.filter((row) => !feed.cold(row.kind, row.id)) }))
  return pool
}

/** The production lazy pool on the whole feed; nothing loads until `hydrateAll`. */
export function lazyPool(feed: StartupFeed): { pool: MobxPool; dispose(): void } {
  return createWorklistPool(feed.source, fixedLocals(feed.locals).source, {
    summaries: mergePoolSummaries(ISSUE_BOARD_SUMMARIES, MISSION_VIEW_SUMMARIES),
    worklist: 'demand',
    schedule: () => () => {},
  })
}

/** Ask, load what the questions demanded, and repeat until nothing is loading. */
export function hydrateAll(pool: MobxPool, questions: readonly StartupQuestion[], rounds = 16): number {
  let loaded = 0
  for (let round = 0; round < rounds; round++) {
    ask(pool, questions)
    const count = pool.hydrate()
    if (!count) return loaded
    loaded += count
  }
  throw new Error(`[startup-states] still loading after ${rounds} rounds`)
}
