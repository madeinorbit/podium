/**
 * POD-4934 — the tracking objects the hand-rolled pool builds, counted from
 * outside and held to a committed baseline (the hand mirror of
 * `arms/mobx/pool/tracking-counts.test.ts`).
 *
 * WHAT IS COUNTED. The pool is created on the scenario feed as the arm
 * creates it (`handPoolArm.create`, one `replace`), then a first paint of a
 * 20-row window is read. A hand census (`harness/src/hand-census.ts`) traps
 * the graph's own class, so every cell built (`CellGraph.cell`) and every
 * cell body run (`CellGraph.run`) is seen as it happens; subscriptions are
 * read off the pool's public listener maps at each checkpoint
 * (`hand-census.ts` says why they are not trapped). Nothing else asks the
 * pool what it built. Two checkpoints, per scale (1x, 4x):
 *
 * - `startup`: after `create` returns (bootstrap done, nothing drawn);
 * - `firstPaint`: after the window's watchers first ran.
 *
 * At each: cells (total, still live, per part — `view`, `own`, `member`,
 * `rankOf`, `placement`, `activity`, the `rollup:*` filings and verdicts),
 * subscriptions taken (per kind: row, group, groups, order, ids) and still
 * live, and what is attached to rows the list does not need: cells whose id
 * is a CLOSED issue (`closedAt` set), an issue the schema's residency rule
 * keeps COLD (`SCHEMA.issue.cold`), or a cold session. Per visible row (the
 * parity oracle's visible rows, not the pool's) is recorded beside, for
 * reading.
 *
 * THE PHASES of startup, as counts of work (never times): `create`
 * (`handPoolArm.create` outside `apply`: the pool's constructor, its tables,
 * closure, filings and order) with `ingest` nested inside it
 * (`HandPool.apply`: the replace, residency, the relation engine's upkeep
 * and the commit's drains), then `firstPaint` (the window's watchers). Per
 * phase: cells built, cell bodies run, subscriptions taken and ended.
 *
 * THE FIRST PAINT, without React: happy-dom has no layout, so the real list
 * draws every row, not a window. The window's watchers are made instead, one
 * subscription per `useSyncExternalStore` the list would mount, reading what
 * each reads: the list (`PoolList`: the grouped view plus each lane, through
 * `groupsView` and `groupLanes`), each header in the window (its group's
 * lanes), and per row its slot (the view, else its residence) plus the drawn
 * fields (`ROW_DISPLAYED_FIELDS`, read off the view). The window is the first
 * 20 rows in list order, with the headers among them. A cold row in it queues
 * a load that never lands here (the load window never closes): what is
 * counted is the paint before loads.
 *
 * THE GATE. Every count is compared with `tracking-counts.baseline.json`:
 * more than the baseline fails (growth), and so does less (a stale baseline
 * would let the next change grow back unseen). A change that moves a count
 * updates the baseline in the same commit, with its issue and a reason:
 *
 *   POD_HAND_TRACKING_COUNTS_UPDATE="POD-1234: why the counts moved" \
 *     bun run test:file -- packages/worklist-proto/arms/hand/pool/tracking-counts.test.ts
 *
 * rewrites the file from the measured counts (and still checks nothing else).
 *
 * THE WRITE LAYER. The same census runs twice more on the arm that owns
 * optimism (`writableHandPoolArm`, re-applying the kernel outbox at
 * creation): `write-idle` (the layer attached, nothing pending) and
 * `write-pending` (title edits on the last rows of the paint window queued in
 * the kernel outbox, re-applied at creation, never receipted:
 * `harness/src/writable-arm.ts`). Their counts are keyed
 * `write-idle.<scale>x.*` and `write-pending.<scale>x.*` in the same
 * baseline; the bare pool keeps its `<scale>x.*` keys. The layer's own
 * construction and its bootstrap are charged to `create`.
 *
 * PLANT (proven red, restored with cp; POD-4934): one extra leaked cell per
 * admitted closure member (`graph.cell('plant:…')` in
 * `VisibleCollection.admit`), which fails the gate by growth.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openFenceFeeds, parityLocals } from '../../../harness/src/fence-scenarios'
import {
  handPhaseMethod,
  startHandCensus,
  type HandCensus,
  type HandCensusSnapshot,
} from '../../../harness/src/hand-census'
import {
  legacyDerivationFromStore,
  snapshotFromStore,
  visibleIssueRows,
} from '../../../harness/src/oracle/index'
import { writeResult } from '../../../harness/src/results'
import {
  PENDING_TITLE_EDITS,
  pendingTitleEditsOn,
  silentTransport,
  WRITE_VARIANTS,
  type WriteVariant,
} from '../../../harness/src/writable-arm'
import { createReadFence } from '../../../shared/src/instrument/reads'
import { ROW_DISPLAYED_FIELDS } from '../../../shared/src/row-view'
import { type FixtureScale, startScenarioEngine } from '../../../shared/src/scenarios'
import { coldByRule, type EntityName, SCHEMA, tableColdContext } from '../../../shared/src/schema'
import { handPoolArm, type HandPoolHandle } from './arm'
import { HandPool } from './pool'
import { writableHandPoolArm, type WritableHandPoolHandle } from './write/arm'

// happy-dom rewrites `import.meta.url` (the package's own `test` lane); resolve
// from the lane's cwd instead, as work-per-change.test.tsx does.
const PACKAGE_DIR = process.cwd().endsWith(join('packages', 'worklist-proto'))
  ? process.cwd()
  : join(process.cwd(), 'packages', 'worklist-proto')
const BASELINE_PATH = join(PACKAGE_DIR, 'arms', 'hand', 'pool', 'tracking-counts.baseline.json')
const UPDATE = process.env['POD_HAND_TRACKING_COUNTS_UPDATE']

/** The first paint's window, in rows. */
const WINDOW_ROWS = 20

interface Baseline {
  /** The issue that last moved the counts. */
  updatedBy: string
  /** Why they moved. */
  reason: string
  counts: Record<string, number>
}

/** What the rows are, read from the feed (not the pool). */
interface RowFacts {
  issues: ReadonlySet<string>
  sessions: ReadonlySet<string>
  closedIssues: ReadonlySet<string>
  coldIssues: ReadonlySet<string>
  coldSessions: ReadonlySet<string>
  visibleRows: number
}

function rowFacts(
  ctx: Awaited<ReturnType<typeof startScenarioEngine>>,
  feeds: ReturnType<typeof openFenceFeeds>,
): RowFacts {
  const now = parityLocals(ctx).coarseNow
  const table = (kind: 'issue' | 'session') =>
    new Map(
      feeds.rows.source
        .snapshot(kind)
        .filter((record) => record.value !== undefined)
        .map((record) => [record.id, record.value as unknown as Readonly<Record<string, unknown>>]),
    )
  const issues = table('issue')
  const sessions = table('session')
  const rule = tableColdContext(
    SCHEMA,
    (entity) => (entity === 'issue' ? issues : entity === 'session' ? sessions : undefined),
    now,
  )
  const cold = (entity: EntityName, rows: ReadonlyMap<string, object>) =>
    new Set([...rows].filter(([, row]) => coldByRule(SCHEMA, entity, row, rule)).map(([id]) => id))
  return {
    issues: new Set(issues.keys()),
    sessions: new Set(sessions.keys()),
    closedIssues: new Set(
      [...issues].filter(([, row]) => row['closedAt'] != null).map(([id]) => id),
    ),
    coldIssues: cold('issue', issues),
    coldSessions: cold('session', sessions),
    visibleRows: visibleIssueRows(
      legacyDerivationFromStore(ctx.engine.getSnapshot(), now),
      parityLocals(ctx),
    ).length,
  }
}

/** Wrap the pool's bootstrap method as the census's ingest phase (see the module note). */
function wrapPhases(census: HandCensus): () => void {
  const restores = [handPhaseMethod(census, HandPool.prototype, 'apply', 'ingest')]
  return () => {
    for (const restore of restores.reverse()) restore()
  }
}

/** The watchers a 20-row window of the list mounts, as subscriptions (see the module note). */
function paintWindow(pool: HandPool): () => void {
  const stops: (() => void)[] = []
  stops.push(pool.subscribeGroups(() => {}))
  const items: ({ kind: 'row'; id: string } | { kind: 'header'; key: string })[] = []
  const view = pool.groupsView()
  for (const id of view.pinnedIds) items.push({ kind: 'row', id })
  for (const key of view.keys) {
    const lanes = pool.groupLanes(key)
    items.push({ kind: 'header', key })
    for (const id of lanes.rowIds) items.push({ kind: 'row', id })
    for (const id of lanes.closedIds) items.push({ kind: 'row', id })
  }
  let rows = 0
  for (const item of items) {
    if (rows === WINDOW_ROWS) break
    if (item.kind === 'header') {
      stops.push(pool.subscribeGroup(item.key, () => {}))
      const lanes = pool.groupLanes(item.key)
      void lanes.label
      void lanes.rowIds.length
      void lanes.closedIds.length
      continue
    }
    rows += 1
    const { id } = item
    stops.push(pool.subscribe(id, () => {}))
    const seen = pool.view(id)
    if (seen === undefined) {
      void pool.resident('issue', id)
    } else {
      const fields = seen as unknown as Record<string, unknown>
      for (const field of ROW_DISPLAYED_FIELDS) void fields[field]
    }
  }
  expect(rows, 'the window is full').toBe(WINDOW_ROWS)
  return () => {
    for (const stop of stops) stop()
  }
}

/** The numbers of one checkpoint: gated counts and, apart, per-row ratios for reading. */
function checkpoint(
  snapshot: HandCensusSnapshot,
  pool: HandPool,
  facts: RowFacts,
): { counts: Record<string, number>; perVisibleRow: Record<string, number> } {
  const counts: Record<string, number> = { visibleRows: facts.visibleRows }
  const add = (key: string, by = 1) => {
    counts[key] = (counts[key] ?? 0) + by
  }
  for (const entry of snapshot.entries) {
    add('cells.total')
    if (entry.live) add('cells.live')
    add(`cells.${entry.part}`)
    if (entry.id === null) continue
    if (facts.closedIssues.has(entry.id)) add('closedIssues.cells')
    if (facts.coldIssues.has(entry.id)) add('coldIssues.cells')
    if (facts.coldSessions.has(entry.id)) add('coldSessions.cells')
  }
  // Subscriptions, read off the pool's public listener maps (see
  // `hand-census.ts`): nothing unsubscribed before a checkpoint, so taken
  // and live agree here; both are gated.
  const sum = (sets: ReadonlyMap<string, ReadonlySet<unknown>>): number => {
    let total = 0
    for (const set of sets.values()) total += set.size
    return total
  }
  const subs = {
    row: sum(pool.listeners),
    group: sum(pool.groupListeners),
    groups: pool.groupsListeners.size,
    order: pool.orderListeners.size,
    ids: pool.idsListeners.size,
  }
  let liveSubs = 0
  for (const [kind, taken] of Object.entries(subs)) {
    if (taken !== 0) counts[`subs.${kind}`] = taken
    liveSubs += taken
  }
  counts['subs.live'] = liveSubs
  const perRow = (key: string) => Math.round(((counts[key] ?? 0) / facts.visibleRows) * 100) / 100
  return {
    counts,
    perVisibleRow: {
      cells: perRow('cells.live'),
      subs: perRow('subs.live'),
      closedIssueCells: perRow('closedIssues.cells'),
      coldIssueCells: perRow('coldIssues.cells'),
    },
  }
}

/** Each phase's work, zeros left out (the gate reads a missing count as 0). */
function phaseCounts(snapshot: HandCensusSnapshot): Record<string, number> {
  const counts: Record<string, number> = {}
  const put = (key: string, value: number) => {
    if (value !== 0) counts[key] = value
  }
  for (const [phase, work] of Object.entries(snapshot.phases)) {
    put(`${phase}.cellsBuilt`, work.cellsBuilt)
    put(`${phase}.cellRuns`, work.cellRuns)
  }
  return counts
}

interface ScaleCounts {
  counts: Record<string, number>
  report: unknown
}

/** The arm measured: the bare pool, or the pool with its write layer (see the module note). */
type Variant = 'pool' | WriteVariant

/** A variant's key prefix: `1x`, `write-idle.1x`, `write-pending.1x`. */
const keyOf = (variant: Variant, scale: FixtureScale): string =>
  variant === 'pool' ? `${scale}x` : `write-${variant}.${scale}x`

/** The pool never auto-hydrates here: the load window never closes. */
const NEVER_LOAD = { schedule: () => () => {} } as const

async function measure(scale: FixtureScale, variant: Variant): Promise<ScaleCounts> {
  const ctx = await startScenarioEngine(scale)
  const feeds = openFenceFeeds(ctx, 'overlaid')
  const facts = rowFacts(ctx, feeds)
  const reads = createReadFence({ enabled: true })
  const census = startHandCensus()
  const unwrap = wrapPhases(census)
  // The pending variant's outbox, read off the feed before anything is counted.
  const pending =
    variant === 'pending'
      ? pendingTitleEditsOn(
          feeds.rows.source.snapshot('issue'),
          snapshotFromStore(ctx.engine.getSnapshot(), parityLocals(ctx)).order,
          () => false,
          WINDOW_ROWS,
          parityLocals(ctx).coarseNow,
        )
      : null
  const transport = silentTransport(pending?.queued ?? [])
  let handle: (HandPoolHandle | WritableHandPoolHandle) | null = null
  let stopPaint: (() => void) | null = null
  try {
    census.enter('create')
    const source = reads.wrapSource(feeds.rows.source)
    handle =
      variant === 'pool'
        ? handPoolArm.create(source, feeds.locals.source, reads, NEVER_LOAD)
        : (writableHandPoolArm(transport, NEVER_LOAD).create(
            source,
            feeds.locals.source,
            reads,
          ) as WritableHandPoolHandle)
    census.exit()
    if (pending !== null) {
      const { write } = handle as WritableHandPoolHandle
      const shown = [...pending.titles.keys()].filter(
        (id) => write.pendingDisplay('issue', id) !== undefined,
      )
      expect(shown, 'the queued edits are pending after create').toHaveLength(PENDING_TITLE_EDITS)
    }
    expect(transport.sent, 'the write layer re-applies the outbox without sending').toEqual([])
    // Not blind: the bootstrap builds cells, and the census sees them.
    expect(
      census.snapshot().entries.length,
      'the census traps the pool’s cells from outside',
    ).toBeGreaterThan(0)
    const startup = checkpoint(census.snapshot(), (handle as HandPoolHandle).pool, facts)
    census.enter('firstPaint')
    stopPaint = paintWindow((handle as HandPoolHandle).pool)
    census.exit()
    const final = census.snapshot()
    const paint = checkpoint(final, (handle as HandPoolHandle).pool, facts)
    const phases = phaseCounts(final)
    const counts: Record<string, number> = {}
    for (const [prefix, set] of [
      ['startup', startup.counts],
      ['firstPaint', paint.counts],
      ['phases', phases],
    ] as const) {
      for (const [key, value] of Object.entries(set))
        counts[`${keyOf(variant, scale)}.${prefix}.${key}`] = value
    }
    return {
      counts,
      report: {
        rows: {
          visible: facts.visibleRows,
          issues: facts.issues.size,
          closedIssues: facts.closedIssues.size,
          coldIssues: facts.coldIssues.size,
          sessions: facts.sessions.size,
          coldSessions: facts.coldSessions.size,
        },
        startup: startup,
        firstPaint: paint,
        phases,
        pendingLoadsAfterPaint: (handle as HandPoolHandle).pool.pendingLoads(),
        pendingEdits: pending === null ? [] : [...pending.titles.keys()],
      },
    }
  } finally {
    stopPaint?.()
    unwrap()
    census.stop()
    handle?.dispose()
    feeds.dispose()
    ctx.engine.destroy()
  }
}

/** The gate: every count equals the baseline's (see the module note). */
function compare(measured: Record<string, number>, baseline: Baseline, scale: string): string[] {
  const grew: string[] = []
  const shrank: string[] = []
  const keys = new Set(
    [...Object.keys(measured), ...Object.keys(baseline.counts)].filter((key) =>
      key.startsWith(`${scale}.`),
    ),
  )
  for (const key of [...keys].sort()) {
    const now = measured[key] ?? 0
    const then = baseline.counts[key] ?? 0
    if (now > then) grew.push(`${key}: ${then} -> ${now} (+${now - then})`)
    else if (now < then) shrank.push(`${key}: ${then} -> ${now} (${now - then})`)
  }
  const problems: string[] = []
  if (grew.length > 0) problems.push(`GREW over the baseline:\n  ${grew.join('\n  ')}`)
  if (shrank.length > 0) {
    problems.push(`SHRANK under the baseline (lower it with a reason):\n  ${shrank.join('\n  ')}`)
  }
  return problems
}

function readBaseline(): Baseline {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline
  expect(baseline.updatedBy, 'the baseline names the issue that moved it').toMatch(/^POD-\d+$/)
  expect(baseline.reason.trim().length, 'the baseline states why it moved').toBeGreaterThan(10)
  return baseline
}

const measured: Record<string, number> = {}
const reports: Record<string, unknown> = {}

describe('Hand pool tracking objects (POD-4934)', () => {
  for (const variant of ['pool', ...WRITE_VARIANTS] as const)
    for (const scale of [1, 4] as const) {
      const key = keyOf(variant, scale)
      const arm = variant === 'pool' ? '' : ` with the write layer (${variant})`
      it(`at ${scale}x${arm}: startup and first-paint counts equal the baseline`, async () => {
        const result = await measure(scale, variant)
        Object.assign(measured, result.counts)
        reports[key] = result.report
        writeResult(
          `hand-pool-tracking-counts-${variant === 'pool' ? '' : `write-${variant}-`}${scale}x`,
          result.report,
        )
        if (UPDATE !== undefined) return
        const problems = compare(result.counts, readBaseline(), key)
        expect(
          problems,
          `${problems.join('\n')}\n\nA change that moves these counts updates the baseline in the same commit:\n  POD_HAND_TRACKING_COUNTS_UPDATE="POD-<n>: <reason of 10+ chars>" bun run test:file -- <this file>`,
        ).toEqual([])
      }, 300_000)
    }

  it.runIf(UPDATE !== undefined)('writes the baseline (POD_HAND_TRACKING_COUNTS_UPDATE)', () => {
    const match = /^(POD-\d+):\s*(.{10,})$/.exec(UPDATE ?? '')
    if (match === null)
      throw new Error('POD_HAND_TRACKING_COUNTS_UPDATE="POD-<n>: <reason of 10+ chars>"')
    const [, updatedBy = '', reason = ''] = match
    const sorted = Object.fromEntries(
      Object.entries(measured).sort(([a], [b]) => a.localeCompare(b)),
    )
    const baseline: Baseline = { updatedBy, reason, counts: sorted }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`)
  })
})
