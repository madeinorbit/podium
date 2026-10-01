/**
 * POD-4942 — probes for the post-rework review of the MobX pool
 * (`docs/decisions/pod-4545-round-three-mobx-post-rework-review.md`).
 *
 * Counts only (no walls): they hold under box load. Each test prints one
 * `[probe]` JSON line that the review quotes.
 *
 * 1. GROWTH BY AXIS. The pool created as the harness creates it, on the
 *    two-axis cells (`h1a1`, `h10a1`, `h1a4`, POD-4747), with the load window
 *    never closing. What the pool holds after create and after a 20-row paint,
 *    counted from outside by the MobX census: reactions, computeds, container
 *    entries, plus the pool's own tables and model memo. The question is which
 *    structures grow with HISTORY (closed work) at constant active work.
 * 2. IDLE. After create, paint and every load settled: no timer is armed, and
 *    a clock advance that crosses no deadline runs no derivation.
 * 4. PEEK. Cold rows read synchronously by id (`MobxPool.row(..., 'peek')`,
 *    `Residency.read`) outside the batched load window, counted by phase.
 * 3. ONE CHANGE, TWO HISTORY SIZES. The same heartbeat and title rename at
 *    `h1a1` and `h10a1`: computed and reaction runs must be equal.
 */

import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
import { installMobxWarnTrap } from '../src/mobx-trap'
import type { MobxPool } from '@podium/client-graph/pool'
import { Residency, type Schedule } from '@podium/client-graph/residency'
import { ROW_DISPLAYED_FIELDS } from '@podium/client-graph/shared/row-view'
import { applyHeartbeat, applyTitleRename, startEngineOnCorpus } from '../../shared/src/scenarios'
import { awaitingMergeOf, coldByRule, keepDeadline, keptByKey, SCHEMA, tableColdContext } from '@podium/client-graph/shared/schema'
import { legacyDerivationFromStore, visibleIssueRows } from '../src/oracle/index'
import { harnessMobxPoolArm, settlePoolLoads, tracked, visibleOrderOf } from '../src/adapters/mobx-pool'
import { openFenceFeeds } from '../src/fence-scenarios'
import { buildCorpusCell, type CorpusCell } from '../src/fixture/corpus'
import { startCensus } from '../src/mobx-census'

installMobxWarnTrap()

const CELLS: Record<string, CorpusCell> = {
  h1a1: { history: 1, active: 1 },
  h10a1: { history: 10, active: 1 },
  h1a4: { history: 1, active: 4 },
}

const WINDOW_ROWS = 20

/** A schedule that records armed timers and never fires them. */
function recordingSchedule(): { schedule: Schedule; armed: () => number } {
  let armed = 0
  const schedule: Schedule = () => {
    armed += 1
    return () => {
      armed -= 1
    }
  }
  return { schedule, armed: () => armed }
}

/** The observers a 20-row window mounts (the census test's shape, simplified). */
function paintWindow(pool: MobxPool): () => void {
  const stops: (() => void)[] = []
  const ids: string[] = []
  stops.push(
    autorun(() => {
      ids.length = 0
      for (const id of pool.groups.pinnedIds) ids.push(id)
      for (const key of pool.groups.keys) {
        const group = pool.groups.group(key)
        void group.label
        for (const id of group.rowIds) ids.push(id)
        for (const id of group.closedIds) ids.push(id)
      }
    }),
  )
  for (const id of ids.slice(0, WINDOW_ROWS)) {
    stops.push(
      autorun(() => {
        const model = pool.issue(id)
        if (model === undefined) {
          void pool.resident('issue', id)
          return
        }
        if (!model.inMemory) return
        for (const field of ROW_DISPLAYED_FIELDS) void model[field]
      }),
    )
  }
  return () => {
    for (const stop of stops) stop()
  }
}

async function openCell(cell: CorpusCell, schedule?: Schedule) {
  const ctx = await startEngineOnCorpus(buildCorpusCell(cell))
  const feeds = openFenceFeeds(ctx, 'overlaid')
  const handle = harnessMobxPoolArm.create(
    feeds.rows.source,
    feeds.locals.source,
    undefined,
    schedule === undefined ? { schedule: () => () => {} } : { schedule },
  )
  return { ctx, feeds, handle }
}

function countEntries(snapshot: ReturnType<ReturnType<typeof startCensus>['snapshot']>) {
  const out: Record<string, number> = {}
  for (const entry of snapshot.entries) {
    const key =
      entry.kind === 'reaction'
        ? `reaction.${entry.sub}`
        : entry.kind === 'computed'
          ? 'computed'
          : entry.kind
    out[key] = (out[key] ?? 0) + 1
  }
  return { ...out, ...snapshot.held }
}

function containers(snapshot: ReturnType<ReturnType<typeof startCensus>['snapshot']>) {
  const counts: Record<string, number> = {}
  for (const entry of snapshot.entries) {
    if (entry.kind !== 'map' && entry.kind !== 'set') continue
    const key = `${entry.kind}:${entry.name}`
    counts[key] = (counts[key] ?? 0) + (entry.size ?? 0)
  }
  for (const [kind, held] of [['map', snapshot.held.mapEntries], ['set', snapshot.held.setMembers]] as const) {
    expect.soft(Object.entries(counts).filter(([name]) => name.startsWith(`${kind}:`))
      .reduce((n, [, size]) => n + size, 0)).toBe(held)
  }
  return counts
}

/** Distinct model objects of one class the census sees (owners by identity). */
function modelOwners(census: ReturnType<typeof startCensus>, cls: string): number {
  const owners = new Set<object>()
  for (const entry of census.snapshot().entries) {
    if (entry.owner !== null && entry.owner.cls === cls) owners.add(entry.owner)
  }
  return owners.size
}

describe('POD-4942 post-rework probes', () => {
  it('1. what the pool holds, by growth axis', async () => {
    const report: Record<string, unknown> = {}
    for (const [label, cell] of Object.entries(CELLS)) {
      const census = startCensus()
      const { feeds, handle, ctx } = await openCell(cell)
      try {
        const startup = countEntries(census.snapshot())
        const startupContainers = containers(census.snapshot())
        const stop = paintWindow(handle.pool)
        const paint = countEntries(census.snapshot())
        stop()
        const pool = handle.pool
        const issues = feeds.rows.source.snapshot('issue').filter((r) => r.value !== undefined)
        const sessions = feeds.rows.source.snapshot('session').filter((r) => r.value !== undefined)
        const issueRows = new Map(
          issues.map((r) => [r.id, r.value as unknown as Record<string, unknown>]),
        )
        const sessionRows = sessions.map((r) => r.value as unknown as Record<string, unknown>)
        const oracleRows = visibleIssueRows(
          legacyDerivationFromStore(ctx.engine.getSnapshot(), feeds.locals.source.get().coarseNow),
          feeds.locals.source.get(),
        )
        const shownIssues = new Set<string>(oracleRows.map((row) => row.issue.id))
        const shownSessions = new Set<string>(oracleRows.flatMap((row) => row.sessions.map((s) => s.sessionId)))
        const residentBy = tracked(() => {
          const by: Record<string, number> = {}
          for (const id of pool.tables.issue.keys()) {
            const row = issueRows.get(id) ?? {}
            const why =
              row['closedAt'] != null
                ? 'closed'
                : row['deletedAt'] != null
                  ? 'deleted'
                  : row['archived'] === true
                    ? 'archivedOpen'
                    : 'open'
            by[why] = (by[why] ?? 0) + 1
          }
          let unbound = 0
          let unboundResident = 0
          for (const row of sessionRows) {
            if (row['issueId'] != null) continue
            unbound += 1
            if (pool.tables.session.has(row['sessionId'] as string)) unboundResident += 1
          }
          // Why a CLOSED issue is resident (the rule's keep sources, approximated from the rows).
          const sessionsOf = new Map<string, Record<string, unknown>[]>()
          for (const row of sessionRows) {
            const owner = row['issueId'] as string | null | undefined
            if (owner == null) continue
            const list = sessionsOf.get(owner) ?? []
            list.push(row)
            sessionsOf.set(owner, list)
          }
          const closedWhy: Record<string, number> = {}
          for (const id of pool.tables.issue.keys()) {
            const row = issueRows.get(id) ?? {}
            if (row['closedAt'] == null) continue
            const human = row['audience'] === 'human'
            const stage = row['stage']
            const reasons: string[] = []
            if (human && (stage === 'planning' || stage === 'in_progress' || stage === 'review'))
              reasons.push('humanOpenStage')
            if (!row['parentId'] && human && row['closedReason'] != null)
              reasons.push('humanRootWithReason')
            const unfinishedRun = (sessionsOf.get(id) ?? []).some((session) => {
              if (session['archived'] === true || session['agentKind'] === 'shell') return false
              const state = session['agentState'] as { phase?: unknown } | undefined
              return (
                session['stoppedAt'] == null && state?.phase !== 'ended' && state?.phase !== 'idle'
              )
            })
            if (unfinishedRun) reasons.push('memberRunNeverStopped')
            const key = reasons.length === 0 ? 'other' : reasons.join('+')
            closedWhy[key] = (closedWhy[key] ?? 0) + 1
          }
          // The shared rule itself, over the feed's rows at the pool's clock.
          const issueTable = new Map(issueRows)
          const sessionTable = new Map(
            sessionRows.map((row) => [row['sessionId'] as string, row] as const),
          )
          const rule = tableColdContext(
            SCHEMA,
            (entity) =>
              entity === 'issue' ? issueTable : entity === 'session' ? sessionTable :
                entity === 'worktree' ? new Map(feeds.rows.source.snapshot(entity).map((r) => [r.id, r.value])) : undefined,
            feeds.locals.source.get().coarseNow,
          )
          // Attribute to the executable declaration, not a second approximation.
          // Multiple clauses are named together when either would keep a row.
          const spec = SCHEMA.issue.cold
          if (spec.kind !== 'unlessShown') throw new Error('issue cold rule must have keepers')
          const issueClauses = (row: Record<string, unknown>): string => {
            if (!spec.predicate(row)) {
              return `not-cold-by-predicate:${row['deletedAt'] != null ? 'deleted' : row['archived'] === true ? 'archived' : 'open'}`
            }
            const reasons: string[] = []
            if (rule.now <= spec.shownUntil(row)) {
              reasons.push(`issueShownUntil:${awaitingMergeOf(row) ? 'awaitingMerge' :
                row['audience'] === 'human' && ['planning', 'in_progress', 'review'].includes(row['stage'] as string) ? 'activeHuman' :
                  !row['parentId'] ? 'humanRootFold' : 'humanChildDecay'}`)
            }
            for (const source of spec.keptBy) {
              const key = keptByKey(SCHEMA, 'issue', row, source)
              if (key !== null && [...rule.keeps('issue', source, key)].some(
                (keep) => rule.now <= keepDeadline(keep, spec.finishOf(row)),
              )) reasons.push(`${source.kind}:${source.relation}`)
            }
            return reasons.sort().join('+') || 'unattributed'
          }
          const hiddenIssues: Record<string, number> = {}
          const hiddenSessions: Record<string, number> = {}
          const memberKeptHidden: Record<string, number> = {}
          const hasHumanAncestor = (row: Record<string, unknown>): boolean => {
            const seen = new Set<string>()
            let parent = row['parentId']
            while (typeof parent === 'string' && !seen.has(parent)) {
              seen.add(parent)
              const ancestor = issueRows.get(parent)
              if (ancestor === undefined) return true // unknown stays conservative
              if (ancestor['audience'] !== 'agent' && ancestor['archived'] !== true &&
                ancestor['deletedAt'] == null && ancestor['stage'] !== 'proposed' && ancestor['stage'] !== 'shipping') return true
              parent = ancestor['parentId']
            }
            return false
          }
          const bump = (table: Record<string, number>, why: string) => { table[why] = (table[why] ?? 0) + 1 }
          for (const id of pool.tables.issue.keys()) {
            if (shownIssues.has(id)) continue
            const row = issueRows.get(id)!
            const clauses = issueClauses(row)
            bump(hiddenIssues, clauses)
            if (clauses.includes('members:')) bump(memberKeptHidden,
              row['archived'] === true ? 'archived' : row['deletedAt'] != null ? 'deleted' :
                row['stage'] === 'proposed' || row['stage'] === 'shipping' ? `excluded-stage:${row['stage']}` :
                  row['audience'] === 'agent' && row['parentId'] && !hasHumanAncestor(row) ? 'agent-without-human-ancestor' : 'other')
          }
          for (const id of pool.tables.session.keys()) {
            if (shownSessions.has(id)) continue
            const row = sessionTable.get(id)!
            const owner = typeof row['issueId'] === 'string' ? issueRows.get(row['issueId']) : undefined
            bump(hiddenSessions, owner === undefined ? 'not-cold-by-predicate:unbound-or-unknown-owner' :
              `via-issue:${issueClauses(owner)}`)
          }
          expect.soft(hiddenIssues['unattributed'] ?? 0).toBe(0)
          expect.soft(hiddenSessions['via-issue:unattributed'] ?? 0).toBe(0)
          expect.soft(Object.values(hiddenIssues).reduce((a, b) => a + b, 0)).toBe(
            [...pool.tables.issue.keys()].filter((id) => !shownIssues.has(id)).length,
          )
          expect.soft(Object.values(hiddenSessions).reduce((a, b) => a + b, 0)).toBe(
            [...pool.tables.session.keys()].filter((id) => !shownSessions.has(id)).length,
          )
          let closedColdByRule = 0
          let sessionsColdByRuleResident = 0
          for (const id of pool.tables.issue.keys()) {
            const row = issueRows.get(id) ?? {}
            if (row['closedAt'] == null) continue
            if (coldByRule(SCHEMA, 'issue', row, rule)) closedColdByRule += 1
          }
          for (const id of pool.tables.session.keys()) {
            const row = sessionTable.get(id)
            if (row !== undefined && coldByRule(SCHEMA, 'session', row, rule))
              sessionsColdByRuleResident += 1
          }
          return {
            ...by,
            closedWhy,
            hiddenIssues,
            hiddenSessions,
            memberKeptHidden,
            closedColdByRule,
            sessionsColdByRuleResident,
            unboundSessions: unbound,
            unboundSessionsResident: unboundResident,
          }
        })
        report[label] = tracked(() => ({
          residentBy,
          knownIssues: issues.length,
          knownSessions: sessions.length,
          residentIssues: pool.tables.issue.size,
          residentSessions: pool.tables.session.size,
          readStates: pool.readStates.size,
          // Count actual filings: archived/deleted residents have none; stages can change optimistically.
          // Model objects remain measured from the census owners outside the product.
          issueObjects: modelOwners(census, 'IssueModel'),
          sessionObjects: modelOwners(census, 'SessionModel'),
          filingReactions: [...pool.tables.issue.keys()].filter((id) => pool.worklist.tracks(id)).length,
          visible: visibleOrderOf(pool).length,
          startup,
          startupContainers,
          paint,
        }))
        void ctx
      } finally {
        handle.dispose()
        feeds.dispose()
        census.stop()
      }
    }
    console.log(`[probe] growth ${JSON.stringify(report)}`)
    expect(Object.keys(report)).toHaveLength(3)
    const cells = report as Record<string, { residentIssues: number; residentSessions: number; filingReactions: number }>
    for (const key of ['residentIssues', 'residentSessions', 'filingReactions'] as const) {
      expect.soft(cells['h10a1']![key], `${key}: history x10 stays within 10%`).toBeLessThanOrEqual(cells['h1a1']![key] * 1.1)
    }
  }, 900_000)

  it('2. idle: no timer armed, a quiet clock advance runs nothing', async () => {
    const timers = recordingSchedule()
    const { feeds, handle } = await openCell(CELLS['h1a1'] as CorpusCell, timers.schedule)
    try {
      const stop = paintWindow(handle.pool)
      const rounds = settlePoolLoads(handle.pool)
      const armedAfterSettle = timers.armed()
      const census = startCensus()
      try {
        census.enter('quietTick')
        // One millisecond: no deadline is that close (retention and grace are minutes and days).
        const locals = feeds.locals.source.get()
        handle.pool.applyLocals(
          { ...locals, coarseNow: locals.coarseNow + 1 },
          new Set(['coarseNow'] as const),
        )
        census.exit()
        const work = census.snapshot().phases['quietTick']
        console.log(
          `[probe] idle ${JSON.stringify({ loadRounds: rounds, armedAfterSettle, quietTick: work })}`,
        )
        // Control: the same census sees a day's advance (grace crossings).
        census.enter('dayTick')
        const later = feeds.locals.source.get()
        handle.pool.applyLocals(
          { ...later, coarseNow: later.coarseNow + 24 * 60 * 60 * 1000 },
          new Set(['coarseNow'] as const),
        )
        census.exit()
        const day = census.snapshot().phases['dayTick']
        console.log(`[probe] idle-control ${JSON.stringify({ dayTick: day })}`)
        expect(day?.computedRuns ?? 0).toBeGreaterThan(0)
        expect(armedAfterSettle).toBe(0)
        expect(work?.computedRuns ?? 0).toBe(0)
        expect(work?.reactionRuns ?? 0).toBe(0)
      } finally {
        census.stop()
        stop()
      }
    } finally {
      handle.dispose()
      feeds.dispose()
    }
  }, 600_000)

  it('3. the same change costs the same at history x1 and x10', async () => {
    const report: Record<string, unknown> = {}
    for (const label of ['h1a1', 'h10a1'] as const) {
      const { ctx, feeds, handle } = await openCell(CELLS[label] as CorpusCell)
      try {
        const stop = paintWindow(handle.pool)
        settlePoolLoads(handle.pool)
        const census = startCensus()
        const steps: Record<string, unknown> = {}
        try {
          for (const [name, run] of [
            ['heartbeat', () => applyHeartbeat(ctx)],
            ['rename', () => applyTitleRename(ctx)],
          ] as const) {
            census.enter(name)
            run()
            feeds.flush()
            census.exit()
            const work = census.snapshot().phases[name]
            steps[name] = {
              computedRuns: work?.computedRuns,
              reactionRuns: work?.reactionRuns,
              changes: work?.changes,
            }
          }
        } finally {
          census.stop()
          stop()
        }
        report[label] = {
          heartbeatSessionId: ctx.targets.heartbeatSessionId,
          visibleRootId: ctx.targets.visibleRootId,
          steps,
        }
      } finally {
        handle.dispose()
        feeds.dispose()
      }
    }
    console.log(`[probe] history-step ${JSON.stringify(report)}`)
    expect(Object.keys(report)).toHaveLength(2)
  }, 900_000)

  it('4. synchronous cold reads by id (peek) outside the load window', async () => {
    const original = Residency.prototype.read
    let peeks = 0
    Residency.prototype.read = function (this: Residency, entity, id) {
      const value = original.call(this, entity, id)
      if (value !== undefined) peeks += 1
      return value
    }
    try {
      const report: Record<string, unknown> = {}
      for (const label of ['h1a1', 'h10a1'] as const) {
        peeks = 0
        const { feeds, handle } = await openCell(CELLS[label] as CorpusCell)
        try {
          const afterCreate = peeks
          const stop = paintWindow(handle.pool)
          const afterPaint = peeks
          const rounds = settlePoolLoads(handle.pool)
          const afterSettle = peeks
          stop()
          report[label] = {
            afterCreate,
            afterPaint,
            afterSettle,
            loadRounds: rounds,
            feedRowReads: feeds.rowReads(),
          }
        } finally {
          handle.dispose()
          feeds.dispose()
        }
      }
      console.log(`[probe] peek ${JSON.stringify(report)}`)
      expect(Object.keys(report)).toHaveLength(2)
    } finally {
      Residency.prototype.read = original
    }
  }, 900_000)
})
