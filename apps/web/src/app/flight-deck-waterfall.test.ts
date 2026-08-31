import { buildFlightDeckRows, type IssueNavigationModel } from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  buildWaterfallTimeline,
  WATERFALL_MAX_WINDOW_MS,
  WATERFALL_NOW_PERCENT,
  waterfallInterval,
  waterfallSessionEnd,
  waterfallSessionStart,
} from './flight-deck-waterfall'

const NOW = Date.parse('2026-08-31T12:00:00.000Z')

function session(id: string, over: Record<string, unknown> = {}): SessionMeta {
  return {
    sessionId: id,
    title: id,
    agentKind: 'codex',
    cwd: '/repo',
    status: 'live',
    archived: false,
    createdAt: '2026-08-31T10:00:00.000Z',
    lastActiveAt: '2026-08-31T11:30:00.000Z',
    ...over,
  } as unknown as SessionMeta
}

describe('Flight Deck waterfall geometry', () => {
  it('keeps a complex epic in depth-first issue order with its coordinator first', () => {
    const issue = (id: string, seq: number, over: Record<string, unknown> = {}) =>
      ({
        id,
        seq,
        title: id,
        repoPath: '/repo',
        stage: 'in_progress',
        type: id === 'root' ? 'epic' : 'task',
        archived: false,
        deletedAt: null,
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-31T00:00:00.000Z',
        deps: [],
        dependents: [],
        blockedByNotes: [],
        comments: [],
        labels: [],
        childCount: 0,
        childDoneCount: 0,
        ...over,
      }) as unknown as IssueNavigationModel
    const coordinator = session('root-coordinator', {
      issueId: 'root',
      createdAt: '2026-08-31T11:00:00.000Z',
    })
    const reviewer = session('root-reviewer', {
      issueId: 'root',
      createdAt: '2026-08-31T10:00:00.000Z',
    })
    const rows = buildFlightDeckRows(
      [
        issue('root', 1, { coordinatorSessionId: 'root-coordinator' }),
        issue('later', 4, { parentId: 'root', sortKey: 'b' }),
        issue('first', 2, { parentId: 'root', sortKey: 'a' }),
        issue('nested', 3, { parentId: 'first' }),
        issue('future', 5, { parentId: 'root', stage: 'proposed' }),
      ],
      [reviewer, coordinator],
      'root',
    )
    expect(rows.map((row) => [row.issue.id, row.depth])).toEqual([
      ['root', 0],
      ['first', 1],
      ['nested', 2],
      ['later', 1],
      ['future', 1],
    ])
    expect(rows[0]?.sessions.map((item) => item.sessionId)).toEqual([
      'root-coordinator',
      'root-reviewer',
    ])
  })

  it('uses created time, then activity, then the supplied clock as truthful fallbacks', () => {
    expect(waterfallSessionStart(session('created'), NOW)).toBe(
      Date.parse('2026-08-31T10:00:00.000Z'),
    )
    expect(
      waterfallSessionStart(
        session('activity', { createdAt: 'invalid', lastActiveAt: '2026-08-31T11:00:00.000Z' }),
        NOW,
      ),
    ).toBe(Date.parse('2026-08-31T11:00:00.000Z'))
    expect(
      waterfallSessionStart(
        session('clock', { createdAt: 'invalid', lastActiveAt: 'invalid' }),
        NOW,
      ),
    ).toBe(NOW)
  })

  it('ends settled work at stoppedAt or last activity and keeps live work at Now', () => {
    const finished = session('finished', {
      status: 'exited',
      stoppedAt: '2026-08-31T11:00:00.000Z',
    })
    expect(waterfallSessionEnd(finished, NOW)).toBe(Date.parse('2026-08-31T11:00:00.000Z'))
    expect(waterfallSessionEnd(session('live'), NOW)).toBe(NOW)
  })

  it('keeps one fixed Now position and clips old history without inventing future duration', () => {
    const old = session('old', { createdAt: '2026-08-20T00:00:00.000Z', status: 'exited' })
    const live = session('live', { createdAt: '2026-08-31T11:00:00.000Z' })
    const timeline = buildWaterfallTimeline([old, live], NOW)
    expect(timeline.duration).toBe(WATERFALL_MAX_WINDOW_MS)
    expect(timeline.nowPercent).toBe(WATERFALL_NOW_PERCENT)
    expect(waterfallInterval(old, timeline).clippedStart).toBe(true)
    const active = waterfallInterval(live, timeline)
    expect(active.left + active.width).toBeCloseTo(WATERFALL_NOW_PERCENT)
  })

  it('distinguishes working, attention, live and finished spans', () => {
    const timeline = buildWaterfallTimeline([], NOW)
    expect(
      waterfallInterval(
        session('working', {
          agentState: {
            phase: 'working',
            since: '2026-08-31T11:30:00.000Z',
            nativeSubagentCount: 0,
          },
        }),
        timeline,
      ).state,
    ).toBe('working')
    expect(
      waterfallInterval(
        session('attention', {
          agentState: {
            phase: 'needs_user',
            since: '2026-08-31T11:30:00.000Z',
            nativeSubagentCount: 0,
            need: { kind: 'question', summary: 'HTTPS policy' },
          },
        }),
        timeline,
      ).state,
    ).toBe('attention')
    expect(waterfallInterval(session('live'), timeline).state).toBe('live')
    expect(waterfallInterval(session('done', { status: 'exited' }), timeline).state).toBe(
      'finished',
    )
  })
})
