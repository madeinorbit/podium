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
 * - `policySetPool` (POD-7086): what a device holds under the server's policy
 *   once its first download finished, every collection with its marker. The
 *   pool's readers read whole records only, so the stubs are not in it.
 * - `firstDownloadStates` (POD-7087): every intermediate state of a first
 *   download on an empty device, in the policy's order (always and live,
 *   recent, the sidebar with what it comes with, the stubs), each with the
 *   markers it has so far. Its last state is the policy set.
 * Every candidate reads the device's collections through a loader port over
 * the feed's rows (`devicePort`): markers, stubs, and whether the device is
 * in its first download. The control's port says everything is complete.
 * Later issues add their own states (active-first stream) and feed them to
 * the same check.
 */
import { COLLECTIONS, matchesWhere, type Where } from '@podium/model'
import { createWorklistPool } from '../../../shared/src/clock-fixture-pool'
import { ISSUE_BOARD_SUMMARIES } from '@podium/client-graph/issue-board-schema'
import { MISSION_VIEW_SUMMARIES } from '@podium/client-graph/mission-view-schema'
import { MobxPool } from '@podium/client-graph/pool'
import { type EntityName, SCHEMA, tableColdRule } from '@podium/client-graph/shared/schema'
import { fixedLocals } from '@podium/client-graph/shared/locals-source'
import type { CollectionLoaderPort, LoaderInstance, RowRecord, RowSource } from '@podium/client-graph/shared/source'
import type { SliceLocals } from '../../../shared/src/slice-types'
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
  memoryAt('before engine')
  const ctx = await startEngineOnCorpus(buildCorpusCell(cell, seed))
  memoryAt('engine started')
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
  collectGarbage()
  memoryAt('engine dropped')
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

/** The control: one full bootstrap, every row resident, every collection complete. */
export function fullPool(feed: StartupFeed): MobxPool {
  const pool = new MobxPool(feed.locals)
  const port = devicePort(feed, { complete: 'all', stubs: 'all', firstDownload: false })
  pool.collections.attach(() => port)
  runInAction(() => pool.apply({ type: 'replace', rows: [...feed.rows] }))
  return pool
}

/** What a device holds of its collections in one state. */
export interface DeviceState {
  /** The collection ids with a marker, or every one (`all`, the full load). */
  readonly complete: ReadonlySet<string> | 'all'
  /** The issues the device holds a stub of: every one, or only these. */
  readonly stubs: ReadonlySet<string> | 'all'
  readonly firstDownload: boolean
}

/**
 * The device's collections over the feed's rows, as the one loader answers
 * them (`CollectionLoaderPort`): markers by collection id (an instance with
 * arguments is never complete here), the stubs of the issues the state holds,
 * online, nothing fetched.
 */
export function devicePort(feed: StartupFeed, state: DeviceState): CollectionLoaderPort {
  const issues = new Map<string, Record<string, unknown>>()
  for (const row of feed.rows)
    if (row.kind === 'issue' && (state.stubs === 'all' || state.stubs.has(row.id)))
      issues.set(row.id, row.value as unknown as Record<string, unknown>)
  const STUB = ['id', 'repoId', 'seq', 'stage', 'closedReason', 'archived', 'deletedAt', 'isDraftVessel', 'audience', 'parentId']
  const stubs = new Map<string, Readonly<Record<string, unknown>>>()
  const byParent = new Map<string, string[]>()
  for (const [id, value] of issues) {
    const stub: Record<string, unknown> = {}
    for (const field of STUB) if (value[field] !== undefined) stub[field] = value[field]
    stubs.set(id, stub)
    const parent = value['parentId']
    if (typeof parent === 'string' && parent !== '') {
      const list = byParent.get(parent) ?? []
      list.push(id)
      byParent.set(parent, list)
    }
  }
  const rows = [...stubs].map(([id, stub]) => ({ id, stub }))
  // The full load holds every instance complete, a "one record" one
  // included: a record it does not hold is not visible. A partial state's
  // instances with arguments are never complete here.
  const complete = (spec: LoaderInstance) =>
    state.complete === 'all' ||
    ((spec.args === undefined || Object.keys(spec.args).length === 0) &&
      state.complete.has(spec.collection))
  return {
    request: () => {},
    show: () => () => {},
    requestRecords: () => {},
    status: (spec) => (complete(spec) ? 'complete' : 'loading'),
    online: true,
    firstDownload: state.firstDownload,
    isComplete: (spec) => (complete(spec) ? {} : undefined),
    wasRefused: () => false,
    stubOf: (entity, id) => (entity === 'issueProjection' ? stubs.get(id) : undefined),
    stubsByParent: (parentId) => byParent.get(parentId) ?? [],
    stubRows: (entity) => (entity === 'issueProjection' ? rows : []),
    subscribe: () => () => {},
  }
}

/** Only the active rows, and nothing that says history is missing. */
export function partialPool(feed: StartupFeed): MobxPool {
  const pool = new MobxPool(feed.locals)
  runInAction(() => pool.apply({ type: 'replace', rows: feed.rows.filter((row) => !feed.cold(row.kind, row.id)) }))
  return pool
}

/** The steps of the first download, in the policy's order (`apps/server/src/sync/policy.ts`). */
export const FIRST_DOWNLOAD_STEPS = ['always', 'recent', 'sidebar', 'stubs'] as const
export type FirstDownloadStep = (typeof FIRST_DOWNLOAD_STEPS)[number]

/** The collections each step marks complete. */
const STEP_COLLECTIONS: Readonly<Record<FirstDownloadStep, readonly string[]>> = {
  always: ['session.live', 'session.asking'],
  recent: ['issueProjection.recent', 'session.recent'],
  sidebar: ['issueProjection.sidebar'],
  stubs: ['issueProjection.stubs'],
}

/**
 * The policy set (POD-7086, design POD-7059 "Collections"): the browser's
 * policy (30 recent days) over the feed's rows, with what each held record
 * comes with. Issues: the sidebar and the recent ones, their parent chains,
 * and the issue of every held session. Sessions: live, asking and recent ones,
 * and the sessions of a sidebar issue that are not archived. Every other kind
 * is kept whole (the "always" group and the issue companions). Markers say
 * these collections are complete; the readers POD-7087 moved read them.
 */
export function policySetPool(feed: StartupFeed, recentDays = 30): MobxPool {
  return firstDownloadPool(feed, FIRST_DOWNLOAD_STEPS.length, recentDays)
}

/**
 * One intermediate state of a first download on an empty device (POD-7087):
 * the first `steps` steps arrived, each collection with its marker and what
 * its records come with; the later ones not yet. `steps` = 4 is the policy set.
 */
export function firstDownloadPool(feed: StartupFeed, steps: number, recentDays = 30): MobxPool {
  const done = FIRST_DOWNLOAD_STEPS.slice(0, steps)
  const now = feed.locals.coarseNow ?? Date.now()
  const where = (collection: string): Where => {
    const rule = COLLECTIONS.get(collection)?.where
    if (rule === undefined) throw new Error(`[startup-states] ${collection} has no rule`)
    return rule
  }
  const holds = (collection: string, value: unknown): boolean =>
    matchesWhere(where(collection), (value ?? {}) as Record<string, unknown>, { now, args: { recentDays } })
  const issues = new Map<string, Record<string, unknown>>()
  const sessions = new Map<string, Record<string, unknown>>()
  for (const row of feed.rows) {
    if (row.kind === 'issue') issues.set(row.id, row.value as unknown as Record<string, unknown>)
    if (row.kind === 'session') sessions.set(row.id, row.value as unknown as Record<string, unknown>)
  }
  const issueRules = done.flatMap((step) => STEP_COLLECTIONS[step].filter((c) => c.startsWith('issueProjection.') && c !== 'issueProjection.stubs'))
  const sessionRules = done.flatMap((step) => STEP_COLLECTIONS[step].filter((c) => c.startsWith('session.')))
  const heldIssues = new Set<string>()
  const sidebar = new Set<string>()
  for (const [id, value] of issues) {
    if (issueRules.includes('issueProjection.sidebar') && holds('issueProjection.sidebar', value)) sidebar.add(id)
    if (sidebar.has(id) || issueRules.some((c) => c !== 'issueProjection.sidebar' && holds(c, value))) heldIssues.add(id)
  }
  const heldSessions = new Set<string>()
  for (const [id, value] of sessions) {
    if (sessionRules.some((c) => holds(c, value))) heldSessions.add(id)
    // A sidebar issue comes with its sessions that are not archived.
    const issueId = value['issueId']
    if (typeof issueId === 'string' && sidebar.has(issueId) && value['archived'] !== true)
      heldSessions.add(id)
  }
  // A session comes with its issue.
  for (const id of heldSessions) {
    const issueId = sessions.get(id)?.['issueId']
    if (typeof issueId === 'string' && issues.has(issueId)) heldIssues.add(issueId)
  }
  // An issue comes with its parent, and so every ancestor.
  for (const id of [...heldIssues]) {
    let parent = issues.get(id)?.['parentId']
    while (typeof parent === 'string' && issues.has(parent) && !heldIssues.has(parent)) {
      heldIssues.add(parent)
      parent = issues.get(parent)?.['parentId']
    }
  }
  const pool = new MobxPool(feed.locals)
  const port = devicePort(feed, {
    complete: new Set(done.flatMap((step) => STEP_COLLECTIONS[step])),
    stubs: done.includes('stubs') ? 'all' : heldIssues,
    firstDownload: steps < FIRST_DOWNLOAD_STEPS.length,
  })
  pool.collections.attach(() => port)
  runInAction(() =>
    pool.apply({
      type: 'replace',
      rows: feed.rows.filter((row) =>
        row.kind === 'issue' ? heldIssues.has(row.id) : row.kind === 'session' ? heldSessions.has(row.id) : true,
      ),
    }),
  )
  return pool
}

/**
 * The production lazy pool on the whole feed; nothing loads until
 * `hydrateAll`. The device holds the whole feed, every collection complete.
 */
export function lazyPool(feed: StartupFeed): { pool: MobxPool; dispose(): void } {
  const port = devicePort(feed, { complete: 'all', stubs: 'all', firstDownload: false })
  return createWorklistPool({ ...feed.source, loader: () => port }, fixedLocals(feed.locals).source, {
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
    collectGarbage()
    memoryAt(`hydrate round ${round}`)
    const count = pool.hydrate()
    if (!count) return loaded
    loaded += count
  }
  throw new Error(`[startup-states] still loading after ${rounds} rounds`)
}

/** Between pools: give back what a disposed pool held (Bun, when present). */
export function collectGarbage(): void {
  ;(globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true)
}

/** Resident memory at a named stage, on stderr (the 3 GB worker cap). */
export function memoryAt(stage: string): void {
  if (process.env['PODIUM_STARTUP_MEMORY'] !== '1') return
  const { rss, heapUsed } = process.memoryUsage()
  process.stderr.write(`[startup-states] ${stage}: rss ${Math.round(rss / 1048576)} MiB, heap ${Math.round(heapUsed / 1048576)} MiB\n`)
}
