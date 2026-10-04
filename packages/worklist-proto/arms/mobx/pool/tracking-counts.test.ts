/**
 * POD-4748 — the tracking objects the MobX pool builds, counted from outside
 * and held to a committed baseline.
 *
 * WHAT IS COUNTED. The pool is created on the scenario feed as the arm
 * creates it (`harnessMobxPoolArm.create`, one `replace`), then a first paint of a
 * 20-row window is read. A MobX census (`harness/src/mobx-census.ts`) traps
 * MobX's own classes, so every computed, reaction, observable value, atom,
 * map, set, array and observable object built is seen as it is constructed;
 * nothing asks the pool what it built. Two checkpoints, per scale (1x, 4x):
 *
 * - `startup`: after `create` returns (bootstrap done, nothing drawn);
 * - `firstPaint`: after the window's observers first ran.
 *
 * At each: computeds (declared on an object by `makeObservable`, or
 * standalone) and reactions (built, still live), observables by kind, the
 * entries the built maps/sets/arrays hold, and, by OWNER (the object a
 * computed or property is declared on, by class; a reaction's owner is the
 * single owner of what it observes), how many owners hold how many
 * computeds, reactions and properties. Then what is attached to rows the
 * list does not need: owners whose id is a CLOSED issue (`closedAt` set),
 * an issue the schema's residency rule keeps COLD (`SCHEMA.issue.cold`: not
 * in memory by rule), or a cold session. Per visible row (the parity
 * oracle's visible rows, not the pool's) is recorded beside, for reading.
 *
 * THE PHASES of startup, as counts of work (never times): each phase is a
 * method of the pool, wrapped from outside (`phaseMethod`), and every object
 * built and every run is charged to the innermost:
 *
 * - `create`: `harnessMobxPoolArm.create` outside `apply` (the pool's constructor,
 *   its stores, groups and selection; the feed subscriptions);
 * - `ingest`: `MobxPool.apply` up to the end of its action (tables,
 *   residency, the relation engine's per-row upkeep);
 * - `relationUpkeep`: the relation view's notifications (`PoolRelations.publish`,
 *   `reset`) and the reader questions' (`ReaderQueries.publish`). POD-5407:
 *   the relations themselves are kept by the cold index, outside the pool;
 * - `nodeConstruction`: `VisibleCollection.track` (each issue's filing
 *   reaction, built as its row enters the table, not yet run: `apply` is
 *   one action);
 * - `firstReactiveRun`: the rest of `apply`, where the action's batch ends
 *   and the reactions built in it first run;
 * - `firstPaint`: the window's observers.
 * Per phase: objects built by kind, computed and reaction bodies run, changes
 * reported (observable writes), and rows read through the read fence (raw
 * accesses, and distinct rows per phase segment).
 *
 * THE FIRST PAINT, without React: happy-dom has no layout, so the real list
 * draws every row, not a window. The window's observers are made instead,
 * one reaction per `observer` the list would mount, reading what each reads:
 * the list (`PoolList`: the pinned ids, each lane's keys, row ids and closed
 * ids, unfolded), each header in the window (`PoolGroupHeader`), and per row
 * its slot (`PoolRowSlot`: the model, else its residence), its shell
 * (`PoolRowView`: `model.inMemory`) and its row (`PoolRow`, POD-4756: its id and every
 * field it draws, `ROW_DISPLAYED_FIELDS`, and the complete real-sidebar
 * payload (`IssueModel.sidebar`, POD-4953), read off the same issue. The window is the first 20 rows in list
 * order, with the headers among them. A cold row in it queues a load that
 * never lands here (the load window never closes): what is counted is the
 * paint before loads.
 *
 * THE GATE. Every count is compared with `tracking-counts.baseline.json`:
 * more than the baseline fails (growth), and so does less (a stale baseline
 * would let the next change grow back unseen). A change that moves a count
 * updates the baseline in the same commit, with its issue and a reason:
 *
 *   POD_TRACKING_COUNTS_UPDATE="POD-1234: why the counts moved" \
 *     bun run test:file -- packages/worklist-proto/arms/mobx/pool/tracking-counts.test.ts
 *
 * rewrites the file from the measured counts (and still checks nothing else).
 *
 * THE WRITE LAYER (POD-4825). The same census runs twice more on the arm that
 * owns optimism: `write-idle` (nothing pending) and `write-pending` (title
 * edits on the last rows of the paint window queued in the kernel outbox,
 * never answered: `harness/src/writable-arm.ts`). Their counts are keyed
 * `write-idle.<scale>x.*` and `write-pending.<scale>x.*` in the same
 * baseline; the bare pool keeps its `<scale>x.*` keys.
 *
 * POD-5432: that arm is now the product's own path, the pool on the `owned`
 * feed with the runtime's transaction log (it replaced the pool-side
 * `PendingOverlay` and its edit log). The log is built and rebuilds the queued
 * edits when the feeds open, before the census starts; `create` is the pool
 * and its attachment to the log, and the pending titles arrive as rows.
 *
 * PLANTS (proven red, restored with cp; POD-4748): one extra computed
 * declared on every issue object (then `IssueNode`, now `IssueModel`), and one
 * extra reaction per held issue in `VisibleCollection.add` (now `track`), each
 * fail the gate by growth.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
import { openFenceFeeds, parityLocals } from '../../../harness/src/fence-scenarios'
import {
  CENSUS_KINDS,
  type Census,
  type CensusSnapshot,
  type Owner,
  phaseMethod,
  startCensus,
} from '../../../harness/src/mobx-census'
import {
  legacyDerivationFromStore,
  snapshotFromStore,
  visibleIssueRows,
} from '../../../harness/src/oracle/index'
import { writeResult } from '../../../harness/src/results'
import {
  holdingServer,
  ownedEngineOptions,
  PENDING_TITLE_EDITS,
  pendingTitleEditsOn,
  queuePendingTitles,
  stillPending,
  WRITE_VARIANTS,
  type WriteVariant,
} from '../../../harness/src/writable-arm'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import { createReadFence } from '../../../shared/src/instrument/reads'
import { ROW_DISPLAYED_FIELDS } from '@podium/client-graph/shared/row-view'
import { type FixtureScale, startScenarioEngine } from '../../../shared/src/scenarios'
import { coldByRule, type EntityName, SCHEMA, tableColdContext } from '@podium/client-graph/shared/schema'
import {
  harnessMobxPoolArm,
  poolPendingLoads,
} from '../../../harness/src/adapters/mobx-pool'
import { installMobxWarnTrap } from '../../../harness/src/mobx-trap'
import { MobxPool } from '@podium/client-graph/pool'
import { PoolRelations } from '@podium/client-graph/relations'
import { VisibleCollection } from '@podium/client-graph/worklist/visible'

installMobxWarnTrap()

// happy-dom rewrites `import.meta.url` (the package's own `test` lane); resolve
// from the lane's cwd instead, as work-per-change.test.tsx does.
const PACKAGE_DIR = process.cwd().endsWith(join('packages', 'worklist-proto'))
  ? process.cwd()
  : join(process.cwd(), 'packages', 'worklist-proto')
const BASELINE_PATH = join(PACKAGE_DIR, 'harness', 'src', 'tracking-counts.baseline.json')
const UPDATE = process.env['POD_TRACKING_COUNTS_UPDATE']

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
      legacyDerivationFromStore(ctx.engine.access, now),
      parityLocals(ctx),
    ).length,
  }
}

/** Wrap the pool's bootstrap methods as the census's phases (see the module note). */
function wrapPhases(census: Census): () => void {
  const restores = [
    phaseMethod(census, MobxPool.prototype, 'apply', 'ingest'),
    // The relation view's notification (`publish` on an update, `reset` on an
    // attach) is where the engine's `flush` was: what follows it in `apply`
    // (roster, reader questions) and the reactions its batch end runs are
    // relabeled `firstReactiveRun`, as before (POD-4945; POD-5407 moved the
    // relations themselves to the cold index, outside the pool).
    phaseMethod(census, PoolRelations.prototype, 'publish', 'relationUpkeep', () => {
      if (census.phase === 'ingest') census.relabel('firstReactiveRun')
    }),
    phaseMethod(census, PoolRelations.prototype, 'reset', 'relationUpkeep', () => {
      if (census.phase === 'ingest') census.relabel('firstReactiveRun')
    }),
    phaseMethod(census, VisibleCollection.prototype, 'track', 'nodeConstruction'),
  ]
  return () => {
    for (const restore of restores.reverse()) restore()
  }
}

/** The observers a 20-row window of the list mounts, as reactions (see the module note). */
function paintWindow(pool: MobxPool): () => void {
  const stops: (() => void)[] = []
  const items: ({ kind: 'row'; id: string } | { kind: 'header'; key: string })[] = []
  stops.push(
    autorun(
      () => {
        items.length = 0
        void pool.sidebar.sections()
        const groups = pool.groups
        for (const id of groups.pinnedIds) items.push({ kind: 'row', id })
        for (const key of groups.keys) {
          const group = groups.group(key)
          items.push({ kind: 'header', key })
          for (const id of group.rowIds) items.push({ kind: 'row', id })
          for (const id of group.closedIds) items.push({ kind: 'row', id })
        }
      },
      { name: 'paint.list' },
    ),
  )
  let rows = 0
  for (const item of items) {
    if (rows === WINDOW_ROWS) break
    if (item.kind === 'header') {
      stops.push(
        autorun(
          () => {
            const group = pool.groups.group(item.key)
            void group.label
            void group.rowIds.length
            void group.closedIds.length
          },
          { name: `paint.header.${item.key}` },
        ),
      )
      continue
    }
    rows += 1
    const { id } = item
    stops.push(
      autorun(
        () => {
          if (pool.issue(id) === undefined) void pool.resident('issue', id)
        },
        { name: `paint.slot.${id}` },
      ),
    )
    const model = pool.issue(id)
    if (model !== undefined) {
      stops.push(autorun(() => void model.inMemory, { name: `paint.shell.${id}` }))
      stops.push(
        autorun(
          () => {
            if (!model.inMemory) return
            void model.id
            for (const field of ROW_DISPLAYED_FIELDS) void model[field]
            void model.sidebar
          },
          { name: `paint.row.${id}` },
        ),
      )
    }
  }
  expect(rows, 'the window is full').toBe(WINDOW_ROWS)
  return () => {
    for (const stop of stops) stop()
  }
}

/** The numbers of one checkpoint: gated counts and, apart, per-row ratios for reading. */
function checkpoint(
  snapshot: CensusSnapshot,
  facts: RowFacts,
): {
  counts: Record<string, number>
  perVisibleRow: Record<string, number>
  collections: Record<string, { built: number; entries: number }>
} {
  const counts: Record<string, number> = { visibleRows: facts.visibleRows }
  // Names and sizes come from MobX's containers, independently of the
  // pool. Retain them as report evidence when declared relations move a
  // baseline; they do not add a second set of gated counters.
  const collections: Record<string, { built: number; entries: number }> = {}
  const add = (key: string, by = 1) => {
    counts[key] = (counts[key] ?? 0) + by
  }
  // Owners by identity: the census describes each owner object once.
  const owners = new Map<string, Set<Owner>>()
  const own = (group: string, owner: Owner, what: string) => {
    add(`${group}.${what}`)
    let seen = owners.get(group)
    if (seen === undefined) {
      seen = new Set()
      owners.set(group, seen)
    }
    if (!seen.has(owner)) {
      seen.add(owner)
      add(`${group}.owners`)
    }
  }
  for (const entry of snapshot.entries) {
    if (entry.size !== undefined) {
      const name = entry.name?.startsWith('pool.') ? entry.name : 'unnamed'
      const key = `${entry.kind}.${name}`
      const collection = collections[key] ??= { built: 0, entries: 0 }
      collection.built += 1
      collection.entries += entry.size
    }
    if (entry.kind === 'computed') add(`computeds.${entry.sub}`)
    else if (entry.kind === 'reaction') {
      add('reactions.built')
      if (entry.sub === 'live') add('reactions.live')
    } else if (entry.kind === 'observableValue') add(`observables.value.${entry.sub}`)
    else add(`observables.${entry.kind}`)
    const what =
      entry.kind === 'computed'
        ? 'computeds'
        : entry.kind === 'reaction'
          ? 'reactions'
          : entry.kind === 'observableValue' && entry.sub === 'property'
            ? 'properties'
            : null
    const owner = entry.owner
    if (what === null || owner === null) continue
    own(`byOwner.${owner.cls}`, owner, what)
    if (owner.id === null) continue
    if (facts.closedIssues.has(owner.id)) own('closedIssues', owner, what)
    if (facts.coldIssues.has(owner.id)) own('coldIssues', owner, what)
    if (facts.coldSessions.has(owner.id)) own('coldSessions', owner, what)
  }
  counts['computeds.total'] =
    (counts['computeds.declared'] ?? 0) + (counts['computeds.standalone'] ?? 0)
  counts['held.mapEntries'] = snapshot.held.mapEntries
  counts['held.setMembers'] = snapshot.held.setMembers
  counts['held.arrayElements'] = snapshot.held.arrayElements
  const perRow = (key: string) => Math.round(((counts[key] ?? 0) / facts.visibleRows) * 100) / 100
  return {
    counts,
    collections,
    perVisibleRow: {
      computeds: perRow('computeds.total'),
      reactions: perRow('reactions.live'),
      closedIssueComputeds: perRow('closedIssues.computeds'),
      closedIssueReactions: perRow('closedIssues.reactions'),
    },
  }
}

/** Each phase's work, zeros left out (the gate reads a missing count as 0). */
function phaseCounts(snapshot: CensusSnapshot): Record<string, number> {
  const counts: Record<string, number> = {}
  const put = (key: string, value: number) => {
    if (value !== 0) counts[key] = value
  }
  for (const [phase, work] of Object.entries(snapshot.phases)) {
    for (const kind of CENSUS_KINDS) put(`${phase}.built.${kind}`, work.built[kind])
    put(`${phase}.computedRuns`, work.computedRuns)
    put(`${phase}.reactionRuns`, work.reactionRuns)
    put(`${phase}.changes`, work.changes)
    for (const [key, value] of Object.entries(work.sampled)) put(`${phase}.${key}`, value)
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
  const held = variant === 'pool' ? null : holdingServer()
  const ctx = await startScenarioEngine(scale, held === null ? {} : ownedEngineOptions(held.server))
  // The pending variant's outbox, read off a probe feed and queued before the
  // feeds open: the log rebuilds it there, as a reload does.
  let titles: ReadonlyMap<string, string> = new Map()
  if (variant === 'pending' && held !== null) {
    const probe = createRowSource(ctx.engine, ctx.replica, { mode: 'overlaid' })
    try {
      titles = pendingTitleEditsOn(
        probe.source.snapshot('issue'),
        snapshotFromStore(ctx.engine.access, parityLocals(ctx)).order,
        () => false,
        WINDOW_ROWS,
        parityLocals(ctx).coarseNow,
      ).titles
    } finally {
      probe.dispose()
    }
    held.hold(titles.keys())
    await queuePendingTitles(ctx.engine, titles)
  }
  const feeds = openFenceFeeds(ctx, variant === 'pool' ? 'overlaid' : 'owned')
  const facts = rowFacts(ctx, feeds)
  const reads = createReadFence({ enabled: true })
  const census = startCensus({
    sample: () => {
      const stats = reads.stats()
      reads.reset()
      let accesses = 0
      for (const count of Object.values(stats.accesses)) accesses += count
      return { rowReads: accesses, distinctRows: stats.rows }
    },
  })
  const unwrap = wrapPhases(census)
  let handle: { pool: MobxPool; dispose(): void } | null = null
  let stopPaint: (() => void) | null = null
  try {
    census.enter('create')
    const source = reads.wrapSource(feeds.rows.source)
    handle = harnessMobxPoolArm.create(source, feeds.locals.source, reads, NEVER_LOAD)
    if (variant !== 'pool') feeds.attachPool(handle.pool)
    census.exit()
    if (variant === 'pending') {
      expect(stillPending(feeds, titles), 'the queued edits are pending after create').toHaveLength(
        PENDING_TITLE_EDITS,
      )
    }
    const startup = checkpoint(census.snapshot(), facts)
    census.enter('firstPaint')
    stopPaint = paintWindow(handle.pool)
    census.exit()
    const final = census.snapshot()
    const paint = checkpoint(final, facts)
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
        pendingLoadsAfterPaint: poolPendingLoads(handle.pool),
        pendingEdits: [...titles.keys()],
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

describe('MobX pool tracking objects (POD-4748)', () => {
  for (const variant of ['pool', ...WRITE_VARIANTS] as const)
    for (const scale of [1, 4] as const) {
      const key = keyOf(variant, scale)
      const arm = variant === 'pool' ? '' : ` with the write layer (${variant})`
      it(`at ${scale}x${arm}: startup and first-paint counts equal the baseline`, async () => {
        const result = await measure(scale, variant)
        Object.assign(measured, result.counts)
        reports[key] = result.report
        writeResult(
          `mobx-pool-tracking-counts-${variant === 'pool' ? '' : `write-${variant}-`}${scale}x`,
          result.report,
        )
        if (UPDATE !== undefined) return
        const problems = compare(result.counts, readBaseline(), key)
        expect(
          problems,
          `${problems.join('\n')}\n\nA change that moves these counts updates the baseline in the same commit:\n  POD_TRACKING_COUNTS_UPDATE="POD-<n>: <why>" bun run test:file -- <this file>`,
        ).toEqual([])
      }, 300_000)
    }

  it.runIf(UPDATE !== undefined)('writes the baseline (POD_TRACKING_COUNTS_UPDATE)', () => {
    const match = /^(POD-\d+):\s*(.{10,})$/.exec(UPDATE ?? '')
    if (match === null)
      throw new Error('POD_TRACKING_COUNTS_UPDATE="POD-<n>: <reason of 10+ chars>"')
    const [, updatedBy = '', reason = ''] = match
    const sorted = Object.fromEntries(
      Object.entries(measured).sort(([a], [b]) => a.localeCompare(b)),
    )
    const baseline: Baseline = { updatedBy, reason, counts: sorted }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`)
  })
})
