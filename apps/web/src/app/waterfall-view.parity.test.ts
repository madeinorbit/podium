import { MissionScreen } from '@podium/client-graph/mission-screen'
import { MobxPool } from '@podium/client-graph/pool'
import { attachMissionTestPreferences } from '@podium/client-graph/mission-screen.test.fixture'
import { deckSessions, isCoordinatorSession } from '@podium/client-core/values'
import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import * as old from './flight-deck-waterfall.legacy.fixture'
import { waterfallBarGeometry, foldWaterfallSegments } from './flight-deck-waterfall'
import { WaterfallView } from './waterfall-view'

export const NOW = Date.parse('2026-10-07T12:00:00Z')
export async function waterfallFixture(count = 12) {
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: NOW })
  attachMissionTestPreferences(pool)
  const rows = []
  for (let i = 0; i < count; i++) {
    const id = i === 0 ? 'root' : `row-${i}`
    rows.push({ kind: 'issue' as const, id, value: {
      id, seq: i + 1, title: `Task ${id}`, stage: 'in_progress', audience: 'human',
      parentId: i === 0 ? null : 'root', sortKey: String(i).padStart(5, '0'),
      deps: [], repoPath: '/synthetic', createdAt: new Date(NOW - 3600000).toISOString(),
      updatedAt: new Date(NOW).toISOString(), coordinatorSessionId: `s-${i}-0`,
    } })
    for (let seat = 0; seat < 7; seat++) rows.push({ kind: 'session' as const, id: `s-${i}-${seat}`, value: {
      sessionId: `s-${i}-${seat}`, issueId: id, cwd: '/synthetic', agentKind: 'codex',
      title: `Agent ${seat}`, status: seat < 2 ? 'running' : 'exited', archived: false,
      createdAt: new Date(NOW - (60 + seat) * 60000).toISOString(),
      lastActiveAt: new Date(NOW - (seat < 2 ? 0 : 10) * 60000).toISOString(),
      stoppedAt: seat < 2 ? null : new Date(NOW - 10 * 60000).toISOString(),
      agentState: { phase: seat < 2 ? 'working' : 'ended', since: new Date(NOW - 60000).toISOString() },
    } })
  }
  pool.apply({ type: 'replace', rows })
  const screen = new MissionScreen(pool, 'root', { development: true })
  screen.open()
  const view = new WaterfallView(screen)
  view.open(NOW)
  const stop = autorun(() => void screen.ready)
  for (let turn = 0; turn < 6; turn++) await new Promise<void>(resolve => setTimeout(resolve, 0))
  return { pool, screen, view, close: () => { stop(); view.close(); screen.close(); pool.dispose() } }
}

it('matches the old visible-row lane metrics, geometry and segments on the same fixtures', async () => {
  const f = await waterfallFixture()
  const viewport = { start: NOW - 30 * 60000, end: NOW + 5 * 60000 }
  const samples = [
    { at: NOW - 90 * 60000, phase: 'working' },
    { at: NOW - 45 * 60000, phase: 'needs_user' },
    { at: NOW - 40 * 60000, phase: 'idle' },
    { at: NOW - 20 * 60000, phase: 'working' },
    { at: NOW - 10 * 60000, phase: 'ended' },
  ]
  try {
    for (const active of [null, 's-1-4']) {
      f.view.focus(active)
      for (const row of f.view.rows.slice(0, 3)) {
        const crew = deckSessions(row, f.screen.mode)
        const finished = crew.filter(session => old.waterfallSessionState(session) === 'finished' &&
          !isCoordinatorSession(row.issue, session.sessionId) && session.sessionId !== active)
        const expectedLanes = finished.length > 3 ? Math.max(1, crew.length - finished.length + 1) : Math.max(1, crew.length)
        expect(f.view.row(row).laneCount).toBe(expectedLanes)
        expect(f.view.row(row).finishedIds).toEqual(finished.map(session => session.sessionId))
        for (const session of f.view.row(row).sessions) {
          const fact = f.view.seat(session)
          runInAction(() => { fact.samples = samples })
          const start = old.waterfallSessionStart(session, NOW)
          const end = Math.max(start, old.waterfallSessionEnd(session, NOW))
          expect(fact.startMs).toBe(start)
          expect(fact.endMs).toBe(end)
          expect(waterfallBarGeometry(fact.startMs, fact.endMs, viewport)).toEqual(old.waterfallBarGeometry(start, end, viewport))
          for (const msPerPx of [1000, 60000, 10 * 60000]) {
            expect(foldWaterfallSegments(fact.segments, msPerPx)).toEqual(
              old.foldWaterfallSegments(old.waterfallSegments(samples, start, end), msPerPx))
          }
        }
      }
    }
  } finally { f.close() }
})

it('requests no offscreen activity and keeps retained history through pan and minute ticks', async () => {
  const f = await waterfallFixture(48)
  const query = vi.fn(async ({ sessionIds }: { sessionIds: string[] }) => ({ sessions: Object.fromEntries(sessionIds.map(id =>
    [id, [{ at: new Date(NOW - 3600000).toISOString(), phase: 'working' }]])) }))
  const view = new WaterfallView(f.screen, query)
  view.open(NOW)
  const releases: Array<() => void> = []
  try {
    for (const row of view.rows.slice(0, 2)) for (const id of view.row(row).drawnSessionIds) {
      releases.push(view.seat(f.pool.sessionObject(id)).demand())
    }
    await Promise.resolve()
    expect(query.mock.calls.flatMap(([input]) => input.sessionIds).every(id => id.startsWith('s-0-') || id.startsWith('s-1-'))).toBe(true)
    expect(query).toHaveBeenCalledTimes(4)
    const before = query.mock.calls.length
    const retained = view.seat(f.pool.sessionObject('s-0-3'))
    releases.push(retained.demand())
    await Promise.resolve()
    const samples = retained.samples
    retained.load()
    // The existing coarse clock is deliberately outside the waterfall view.
    f.pool.applyLocals({ selectedIssueId: 'root', coarseNow: NOW + 60000 }, new Set(['coarseNow']))
    expect(retained.samples).toBe(samples)
    expect(query).toHaveBeenCalledTimes(before + 1)
  } finally { releases.forEach(release => release()); view.close(); f.close() }
})
