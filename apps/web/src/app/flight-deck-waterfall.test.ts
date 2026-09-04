import { buildFlightDeckRows, type IssueNavigationModel } from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  fitWaterfallViewport,
  foldWaterfallSegments,
  followWaterfallViewport,
  formatWaterfallDuration,
  panWaterfallViewport,
  summarizeWaterfallSegments,
  WATERFALL_MAX_WINDOW_MS,
  WATERFALL_MIN_SPAN_MS,
  WATERFALL_MIN_WINDOW_MS,
  waterfallBarGeometry,
  waterfallLabelPlacement,
  waterfallPercent,
  waterfallSegments,
  waterfallSessionEnd,
  waterfallSessionStart,
  waterfallTicks,
  waterfallTimelineStart,
  zoomWaterfallViewport,
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

describe('Flight Deck waterfall rows', () => {
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
})

describe('waterfall viewport', () => {
  it('fits the whole crew with Now inside the frame and headroom ahead', () => {
    const start = waterfallTimelineStart([session('s')])
    const viewport = fitWaterfallViewport(start, NOW, { future: true })
    expect(viewport.start).toBeLessThan(Date.parse('2026-08-31T10:00:00.000Z'))
    expect(viewport.end).toBeGreaterThan(NOW)
    const nowPct = waterfallPercent(viewport, NOW)
    expect(nowPct).toBeGreaterThan(80)
    expect(nowPct).toBeLessThan(100)
  })

  it('clamps the fitted window between the minimum and 48 hours', () => {
    const fresh = fitWaterfallViewport(NOW - 30_000, NOW)
    expect(fresh.end - fresh.start).toBeGreaterThanOrEqual(WATERFALL_MIN_WINDOW_MS)
    const ancient = fitWaterfallViewport(NOW - 14 * 24 * 60 * 60 * 1_000, NOW)
    expect(ancient.end - ancient.start).toBeLessThanOrEqual(WATERFALL_MAX_WINDOW_MS * 1.3)
  })

  it('follows current work without flattening it against old history', () => {
    const old = session('old', {
      status: 'stopped',
      createdAt: '2026-08-29T10:00:00.000Z',
      stoppedAt: '2026-08-29T10:10:00.000Z',
    })
    const current = session('current', {
      createdAt: '2026-08-31T11:55:00.000Z',
      lastActiveAt: '2026-08-31T11:59:00.000Z',
    })
    const viewport = followWaterfallViewport([old, current], NOW, 480)
    const bar = waterfallBarGeometry(waterfallSessionStart(current, NOW), NOW, viewport)

    expect(waterfallPercent(viewport, NOW)).toBeGreaterThan(85)
    expect(bar.widthPct * 4.8).toBeGreaterThanOrEqual(90)
    expect(waterfallBarGeometry(waterfallSessionStart(old, NOW), NOW, viewport).clippedStart).toBe(
      true,
    )
  })

  it('parks a completed crew on its latest work instead of an empty present-day gap', () => {
    const latestEnd = NOW - 6 * 60 * 60_000
    const finished = session('finished', {
      status: 'stopped',
      createdAt: new Date(latestEnd - 10 * 60_000).toISOString(),
      stoppedAt: new Date(latestEnd).toISOString(),
    })
    const viewport = followWaterfallViewport([finished], NOW, 480)

    expect(waterfallPercent(viewport, latestEnd)).toBeGreaterThan(85)
    expect(waterfallPercent(viewport, NOW)).toBeGreaterThan(100)
  })

  it('zooms around the anchor so the time under the cursor stays put', () => {
    const viewport = { start: NOW - 60 * 60_000, end: NOW }
    const anchorTime = viewport.start + (viewport.end - viewport.start) * 0.25
    const zoomed = zoomWaterfallViewport(viewport, 0.5, 0.25, NOW)
    expect(zoomed.end - zoomed.start).toBeCloseTo(30 * 60_000, -2)
    expect(waterfallPercent(zoomed, anchorTime)).toBeCloseTo(25, 5)
  })

  it('refuses to zoom below the two-minute floor or fly past Now', () => {
    const viewport = { start: NOW - 10 * 60_000, end: NOW }
    const floor = zoomWaterfallViewport(viewport, 0.0001, 0.5, NOW)
    expect(floor.end - floor.start).toBe(WATERFALL_MIN_SPAN_MS)
    const flung = panWaterfallViewport(viewport, 60 * 60_000, NOW)
    expect(flung.end).toBeLessThanOrEqual(NOW + (viewport.end - viewport.start) * 0.6)
  })

  it('projects bars through the viewport and reports clipping honestly', () => {
    const viewport = { start: NOW - 60 * 60_000, end: NOW }
    const inside = waterfallBarGeometry(NOW - 30 * 60_000, NOW - 15 * 60_000, viewport)
    expect(inside.leftPct).toBeCloseTo(50)
    expect(inside.widthPct).toBeCloseTo(25)
    expect(inside.visible).toBe(true)
    expect(inside.clippedStart).toBe(false)

    const clipped = waterfallBarGeometry(NOW - 3 * 60 * 60_000, NOW - 90 * 60_000, viewport)
    expect(clipped.visible).toBe(false)
    expect(clipped.clippedStart).toBe(true)

    const spanning = waterfallBarGeometry(NOW - 2 * 60 * 60_000, NOW, viewport)
    expect(spanning.leftPct).toBe(0)
    expect(spanning.clippedStart).toBe(true)
    expect(spanning.widthPct).toBeCloseTo(100)
  })

  it('re-ticks the ruler so labels keep at least the minimum spacing', () => {
    const hour = { start: NOW - 60 * 60_000, end: NOW }
    const wide = waterfallTicks(hour, 600)
    expect(wide.length).toBeGreaterThan(3)
    const narrow = waterfallTicks(hour, 180)
    expect(narrow.length).toBeLessThan(wide.length)
    for (let index = 1; index < wide.length; index += 1) {
      const gapPx = (((wide[index]?.pct ?? 0) - (wide[index - 1]?.pct ?? 0)) / 100) * 600
      expect(gapPx).toBeGreaterThanOrEqual(63)
    }
    // Wall-clock aligned: every tick lands on a whole minute.
    for (const tick of wide) expect(new Date(tick.at).getSeconds()).toBe(0)
  })
})

describe('waterfall segments', () => {
  const T0 = NOW - 60 * 60_000

  it('folds phase samples into working / idle / attention stretches', () => {
    const segments = waterfallSegments(
      [
        { at: T0, phase: 'working' },
        { at: T0 + 20 * 60_000, phase: 'needs_user' },
        { at: T0 + 30 * 60_000, phase: 'working' },
        { at: T0 + 50 * 60_000, phase: 'idle' },
      ],
      T0,
      NOW,
    )
    expect(segments).toEqual([
      { start: T0, end: T0 + 20 * 60_000, kind: 'working' },
      { start: T0 + 20 * 60_000, end: T0 + 30 * 60_000, kind: 'attention' },
      { start: T0 + 30 * 60_000, end: T0 + 50 * 60_000, kind: 'working' },
      { start: T0 + 50 * 60_000, end: NOW, kind: 'idle' },
    ])
  })

  it('carries a pre-window sample in and stops drawing after ended', () => {
    const segments = waterfallSegments(
      [
        { at: T0 - 10 * 60_000, phase: 'working' },
        { at: T0 + 10 * 60_000, phase: 'ended' },
      ],
      T0,
      NOW,
    )
    expect(segments).toEqual([{ start: T0, end: T0 + 10 * 60_000, kind: 'working' }])
  })

  it('returns nothing without samples so the caller renders the honest solid bar', () => {
    expect(waterfallSegments([], T0, NOW)).toEqual([])
  })

  it('merges sub-pixel segments without losing a real burst to a wait', () => {
    const segments = [
      { start: T0, end: T0 + 30 * 60_000, kind: 'idle' as const },
      { start: T0 + 30 * 60_000, end: T0 + 30 * 60_000 + 5_000, kind: 'working' as const },
      { start: T0 + 30 * 60_000 + 5_000, end: NOW, kind: 'idle' as const },
    ]
    // 1 px = 10 minutes: the five-second burst folds away, idle wins the span.
    const coarse = foldWaterfallSegments(segments, 10 * 60_000)
    expect(coarse).toEqual([{ start: T0, end: NOW, kind: 'idle' }])
    // 1 px = 1 second: everything is visible, nothing folds.
    const fine = foldWaterfallSegments(segments, 1_000)
    expect(fine).toHaveLength(3)
  })

  it('summarizes stretches for the hover card', () => {
    const summary = summarizeWaterfallSegments([
      { start: 0, end: 10, kind: 'working' },
      { start: 10, end: 15, kind: 'idle' },
      { start: 15, end: 30, kind: 'working' },
      { start: 30, end: 32, kind: 'attention' },
    ])
    expect(summary).toEqual({
      workingMs: 25,
      idleMs: 5,
      attentionMs: 2,
      workingStretches: 2,
    })
  })
})

describe('waterfall labels and formats', () => {
  it('walks the label ladder as the bar narrows', () => {
    expect(waterfallLabelPlacement(10, 120, 400)).toBe('inside')
    expect(waterfallLabelPlacement(10, 40, 400)).toBe('after')
    expect(waterfallLabelPlacement(300, 60, 400)).toBe('before')
    expect(waterfallLabelPlacement(40, 30, 160)).toBe('none')
  })

  it('formats durations from seconds to hours', () => {
    expect(formatWaterfallDuration(4_000)).toBe('4s')
    expect(formatWaterfallDuration(90_000)).toBe('2m')
    expect(formatWaterfallDuration(60 * 60_000)).toBe('1h')
    expect(formatWaterfallDuration(95 * 60_000)).toBe('1h 35m')
  })
})
