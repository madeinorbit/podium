// @vitest-environment happy-dom
/**
 * POD-5593 (review gap C3) — the active-work rule covers the first screen.
 *
 * The question: can the first screen be drawn from active work alone? For
 * each declared first-screen question (the worklist, desktop and phone; the
 * header; the issue named in the URL)
 * the answers of a pool whose replica holds ONLY active rows (`activeWork`
 * in `@podium/model`: every other issue and session evicted before the pool
 * attaches, as a client stands before history arrives) must equal the
 * answers of a pool holding everything, on the worklist fixtures at 1x and
 * 4x. Comparing answers, not reads, covers every way a question reaches a
 * row: a load, a cold summary, a fact the cold index answers, a relation
 * walk. A read of a history row that cannot change the answer (an old
 * decayed session a retention check visits) is no gap.
 *
 * The instrument is shown armed in every run: the residency rule alone (the
 * gap: no ancestors, no owners) draws a different worklist, and dropping the
 * opened issue's parent draws a different page.
 */

import { issuePages } from '@podium/client-graph/issue-page'
import { ISSUE_PAGE_SUMMARIES } from '@podium/client-graph/issue-page-schema'
import { attachIssuePageSource } from '@podium/client-graph/issue-page-source'
import { MISSION_VIEW_SUMMARIES } from '@podium/client-graph/mission-view-schema'
import type { MobxPool } from '@podium/client-graph/pool'
import { createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { coldByRule, type EntityName, SCHEMA, tableColdContext } from '@podium/client-graph/shared/schema'
import { mergePoolSummaries } from '@podium/client-graph/source-registry'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { type ActiveWork, activeWork, asIssueId, type HostMetricsWire, type MachineId } from '@podium/model/browser'
import { runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { poolHeaderSnapshot } from '../../diagnostics/header-check'
import { referenceState } from '../../diagnostics/reference-state'
import { compareSidebarSnapshots, poolSidebarSnapshot, type SidebarDifference, type SidebarSnapshot } from '../../diagnostics/sidebar-check'
import { evict, startScenarioEngine } from '../../shared/src/scenarios'
import { openFenceFeeds, parityLocals } from './fence-scenarios'
import { poolMobileSnapshot } from './oracle/mobile-snapshot'

type Row = Readonly<Record<string, unknown>>
type Scale = 1 | 4
type Kind = 'issue' | 'session' | 'worktree' | 'repo'

/** The fixture's rows, the clock, and the residency answer per row. */
interface Fixture {
  readonly now: number
  readonly issues: ReadonlyMap<string, Row>
  readonly sessions: ReadonlyMap<string, Row>
  readonly cold: (entity: 'issue' | 'session', id: string) => boolean
}

async function fixture(scale: Scale): Promise<Fixture> {
  const ctx = await startScenarioEngine(scale)
  const feeds = openFenceFeeds(ctx, 'pooled')
  try {
    const table = (kind: Kind) =>
      new Map(
        feeds.rows.source
          .snapshot(kind)
          .filter((record) => record.value !== undefined)
          .map((record) => [record.id, record.value as unknown as Row]),
      )
    const tables: Record<Kind, ReadonlyMap<string, Row>> & Partial<Record<EntityName, ReadonlyMap<string, Row>>> = {
      issue: table('issue'), session: table('session'), worktree: table('worktree'), repo: table('repo'),
    }
    const now = parityLocals(ctx).coarseNow
    const rule = tableColdContext(SCHEMA, (entity: EntityName) => tables[entity], now)
    return {
      now,
      issues: tables.issue,
      sessions: tables.session,
      cold: (entity, id) => coldByRule(SCHEMA, entity, tables[entity].get(id)!, rule),
    }
  } finally {
    feeds.dispose()
    ctx.dispose()
  }
}

/** The first screen's answers, settled: every load the questions ask for has landed. */
interface Answers {
  readonly desktop: unknown
  readonly phone: unknown
  readonly header: unknown
  readonly page: unknown
}

function settle<T extends { readonly pending: number }>(pool: MobxPool, read: () => T): T {
  for (let round = 0; round < 64; round++) {
    const value = runInAction(read)
    if (pool.hydrate() === 0 && value.pending === 0) return value
  }
  throw new Error('first-screen answers did not settle')
}

/** What the issue page shows of `id`: the page's own readers (`pool-screen-work.ts` detail). */
function pageOf(pool: MobxPool, id: string): { readonly pending: number; readonly value: unknown } {
  const page = issuePages(pool)
  const issue = page.issue(id)
  if (issue === LOADING) return { pending: 1, value: LOADING }
  if (!issue) return { pending: 0, value: null }
  const row = page.row(issue.id)
  const children = row.children
  const crew = row.activeSessions
  if (children === LOADING || crew === LOADING) return { pending: 1, value: LOADING }
  const parent = issue.parentId ? pool.issueObject(issue.parentId) : undefined
  return {
    pending: 0,
    value: {
      id: issue.id,
      title: row.title,
      ref: issue.displayRef,
      stage: issue.stage,
      ready: issue.ready,
      parent: parent?.authoredTitle ?? null,
      childCount: issue.childCount,
      childDoneCount: issue.childDoneCount,
      children: children?.map((child) => [child.id, child.authoredTitle, child.displayRef, child.stage]),
      crew: crew?.map((session) => [session.sessionId, session.title, session.asking, session.motion]),
      memberCount: issue.memberCount,
    },
  }
}

/**
 * The answers of a pool over the fixture with `opened` selected; when
 * `keep` is given, every issue and session it does not hold is evicted
 * from the replica before the pool attaches.
 */
async function answersOf(scale: Scale, opened: string | null, keep?: ActiveWork): Promise<Answers> {
  const ctx = await startScenarioEngine(scale)
  try {
    if (keep !== undefined) {
      const issues = ctx.corpus.issueProjections.map((row) => row.id as string).filter((id) => !keep.issues.has(id))
      const sessions = ctx.corpus.sessions.map((row) => row.sessionId as string).filter((id) => !keep.sessions.has(id))
      ctx.replica.batch(() => {
        for (const id of issues) evict(ctx, 'issueProjection', id)
        for (const id of sessions) evict(ctx, 'session', id)
      })
    }
    // The header's machine facts, as its own test gives them
    // (`header-pool.test.ts`): every machine reports, so every per-machine
    // aggregate (which counts history sessions too) is compared.
    const health = { status: 'ok', rttMs: 12, since: 0 }
    Object.assign(ctx.engine.hub, { connectionHealth: () => health, onConnectionHealth: () => () => {} })
    ctx.hub.emit('hostMetrics', ctx.corpus.machines.map((host) => metric(host.id)))
    referenceState(ctx.engine).setSelectedIssueId(opened === null ? null : asIssueId(opened))
    const handle = createRuntimeWorklistPool(ctx.engine, {
      header: true,
      summaries: mergePoolSummaries(ISSUE_PAGE_SUMMARIES, MISSION_VIEW_SUMMARIES),
    })
    const stopPage = attachIssuePageSource(handle.pool, ctx.engine)
    try {
      const pool = handle.pool
      return {
        desktop: settle(pool, () => poolSidebarSnapshot(pool)),
        phone: settle(pool, () => poolMobileSnapshot(pool)),
        header: settle(pool, () => poolHeaderSnapshot(pool)),
        page: opened === null ? null : settle(pool, () => pageOf(pool, opened)).value,
      }
    } finally {
      stopPage()
      handle.dispose()
    }
  } finally {
    ctx.dispose()
  }
}

/** The first differences of two snapshots, with both values, for the failure message. */
function differences(expected: unknown, actual: unknown): string {
  const out: string[] = []
  const a = expected as SidebarSnapshot, b = actual as SidebarSnapshot
  const fieldOf = (snapshot: SidebarSnapshot, d: SidebarDifference, id: string | null) => {
    const section = snapshot.sections[d.sectionIndex]
    if (d.rowIndex === null) return section?.fields[d.field]
    const row = section?.rows.find((r) => r.id === id) ?? section?.rows[d.rowIndex]
    return d.field === 'id' ? row?.id : row?.fields[d.field]
  }
  compareSidebarSnapshots(a, b, (d) => {
    if (out.length < 12) out.push(`${d.section}#${d.rowIndex} ${d.expectedId ?? '-'}/${d.actualId ?? '-'} ${d.field}: ${JSON.stringify(fieldOf(a, d, d.expectedId))?.slice(0, 300)} -> ${JSON.stringify(fieldOf(b, d, d.actualId))?.slice(0, 300)}`)
  })
  return out.join('\n')
}

function metric(machineId: MachineId): HostMetricsWire {
  return {
    machineId,
    hostname: 'synthetic',
    sampledAt: 'fixed',
    memory: { totalBytes: 100, availableBytes: 60, swapTotalBytes: 0, swapFreeBytes: 0 },
  }
}

/**
 * The header without its folded bar for the opened issue's mission: progress
 * and crew over every descendant of the mission root, a question over a whole
 * subtree that reads history (closed descendants, their seats). It answers
 * only once history is complete (POD-5592's completeness markers), so it is
 * no first-screen question here. With nothing opened the bar is empty and
 * the whole header is compared.
 */
function withoutMissionBar(header: unknown): unknown {
  const snapshot = header as SidebarSnapshot
  return { ...snapshot, sections: snapshot.sections.filter((section) => section.key !== 'folded') }
}

function without(active: ActiveWork, entity: 'issues' | 'sessions', id: string): ActiveWork {
  const set = new Set(active[entity])
  set.delete(id)
  return { ...active, [entity]: set }
}

/** The URL cases: an open child issue with a history child, and a history child issue with children. */
function urlCases(f: Fixture): { readonly open: string; readonly history: string } {
  const children = new Map<string, string[]>()
  for (const [id, row] of f.issues) {
    const parent = row['parentId']
    if (typeof parent === 'string') children.set(parent, [...(children.get(parent) ?? []), id])
  }
  const ids = [...f.issues.keys()].sort()
  const open = ids.find((id) => !f.cold('issue', id) && f.issues.get(id)!['parentId'] &&
    (children.get(id) ?? []).some((child) => f.cold('issue', child)))
  const history = ids.find((id) => f.cold('issue', id) && f.issues.get(id)!['parentId'] && (children.get(id) ?? []).length > 0)
  if (open === undefined || history === undefined) throw new Error('fixture has no URL cases')
  return { open, history }
}

describe('the active-work rule covers the first screen (POD-5593, C3)', () => {
  it.each([1, 4] as const)('at %ix', async (scale) => {
    const f = await fixture(scale)
    const active = (opened: string | null) => activeWork({ ...f, opened })
    const base = active(null)
    const residency = {
      issues: new Set([...f.issues.keys()].filter((id) => !f.cold('issue', id))),
      sessions: new Set([...f.sessions.keys()].filter((id) => !f.cold('session', id))),
    }
    const counts = {
      issues: f.issues.size,
      sessions: f.sessions.size,
      activeIssues: base.issues.size,
      activeSessions: base.sessions.size,
      residentIssues: residency.issues.size,
      residentSessions: residency.sessions.size,
    }
    console.info(`[active-work-coverage] ${scale}x ${JSON.stringify(counts)}`)
    // Active work is a small part of the corpus: history is what stays out.
    expect(base.issues.size).toBeLessThan(f.issues.size)
    expect(base.sessions.size).toBeLessThan(f.sessions.size)

    // The worklist and the header.
    const full = await answersOf(scale, null)
    const first = await answersOf(scale, null, base)
    expect.soft(first.desktop, `worklist (desktop)\n${differences(full.desktop, first.desktop)}`).toEqual(full.desktop)
    expect.soft(first.phone, `worklist (phone)\n${differences(full.phone, first.phone)}`).toEqual(full.phone)
    expect.soft(first.header, `header\n${differences(full.header, first.header)}`).toEqual(full.header)

    // Armed: the residency rule alone (the gap) draws a different worklist.
    const gap = await answersOf(scale, null, residency)
    expect([gap.desktop, gap.phone]).not.toEqual([full.desktop, full.phone])

    // The issue named in the URL: open, and history.
    const url = urlCases(f)
    const everything = new Map<string, Answers>()
    for (const opened of [url.open, url.history]) {
      const all = await answersOf(scale, opened)
      everything.set(opened, all)
      const only = await answersOf(scale, opened, active(opened))
      expect.soft(only.page, `issue page ${opened}`).toEqual(all.page)
      expect.soft(withoutMissionBar(only.header), `header for ${opened}\n${differences(all.header, only.header)}`).toEqual(withoutMissionBar(all.header))
      expect.soft(only.desktop, `worklist (desktop) for ${opened}\n${differences(all.desktop, only.desktop)}`).toEqual(all.desktop)
      expect.soft(only.phone, `worklist (phone) for ${opened}\n${differences(all.phone, only.phone)}`).toEqual(all.phone)
    }
    // Armed: the opened issue's parent is part of the page.
    const parent = f.issues.get(url.history)!['parentId'] as string
    const noParent = await answersOf(scale, url.history, without(active(url.history), 'issues', parent))
    expect(noParent.page).not.toEqual(everything.get(url.history)!.page)
  }, 1_800_000)
})
