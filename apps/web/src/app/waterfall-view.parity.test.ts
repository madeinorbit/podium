import { deckSessions, isCoordinatorSession } from '@podium/client-core/values'
import { runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import * as old from './flight-deck-waterfall.legacy.test.fixture'
import {
  waterfallBarGeometry,
  foldWaterfallSegments,
  followWaterfallSessionViewport,
} from './flight-deck-waterfall'
import { WaterfallView } from './waterfall-view'
import type { WaterfallSessionModel } from './waterfall-view'

import { NOW, waterfallFixture } from './waterfall-view.test.fixture'

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
        const finished = crew.filter(
          (session) =>
            old.waterfallSessionState(session) === 'finished' &&
            !isCoordinatorSession(row.issue, session.sessionId) &&
            session.sessionId !== active,
        )
        const expectedLanes =
          finished.length > 3
            ? Math.max(1, crew.length - finished.length + 1)
            : Math.max(1, crew.length)
        expect(f.view.row(row).laneCount).toBe(expectedLanes)
        expect(f.view.row(row).finishedIds).toEqual(finished.map((session) => session.sessionId))
        for (const session of f.view.row(row).sessions) {
          const fact = f.view.seat(session)
          runInAction(() => {
            fact.samples = samples
          })
          const start = old.waterfallSessionStart(session, NOW)
          const end = Math.max(start, old.waterfallSessionEnd(session, NOW))
          expect(fact.startMs).toBe(start)
          expect(fact.endMs).toBe(end)
          expect(waterfallBarGeometry(fact.startMs, fact.endMs, viewport)).toEqual(
            old.waterfallBarGeometry(start, end, viewport),
          )
          for (const msPerPx of [1000, 60000, 10 * 60000]) {
            expect(foldWaterfallSegments(fact.segments, msPerPx)).toEqual(
              old.foldWaterfallSegments(old.waterfallSegments(samples, start, end), msPerPx),
            )
          }
        }
      }
    }
  } finally {
    f.close()
  }
})

it('requests no offscreen activity and keeps retained history through pan and minute ticks', async () => {
  const f = await waterfallFixture(48)
  const query = vi.fn(async ({ sessionIds }: { sessionIds: string[] }) => ({
    sessions: Object.fromEntries(
      sessionIds.map((id) => [
        id,
        [{ at: new Date(NOW - 3600000).toISOString(), phase: 'working' }],
      ]),
    ),
  }))
  const view = new WaterfallView(f.screen, query)
  view.open(NOW)
  const releases: Array<() => void> = []
  try {
    for (const row of view.rows.slice(0, 2))
      for (const id of view.row(row).drawnSessionIds) {
        releases.push(view.seat(f.pool.sessionObject(id)).demand())
      }
    await Promise.resolve()
    expect(
      query.mock.calls
        .flatMap(([input]) => input.sessionIds)
        .every((id) => id.startsWith('s-0-') || id.startsWith('s-1-')),
    ).toBe(true)
    expect(query).toHaveBeenCalledTimes(4)
    const before = query.mock.calls.length
    const retained = view.seat(f.pool.sessionObject('s-0-3'))
    releases.push(retained.demand())
    await Promise.resolve()
    const samples = retained.samples
    retained.load()
    // The existing coarse clock is deliberately outside the waterfall view.
    f.pool.clock.advance(NOW + 60000)
    expect(retained.samples).toBe(samples)
    expect(query).toHaveBeenCalledTimes(before + 1)
  } finally {
    releases.forEach((release) => release())
    view.close()
    f.close()
  }
})

it('follows one session with the old singleton geometry across width and time changes', async () => {
  const f = await waterfallFixture()
  try {
    for (const id of ['s-0-0', 's-0-4'])
      for (const now of [NOW, NOW + 60000, NOW + 3600000]) {
        const session = f.pool.sessionObject(id) as WaterfallSessionModel
        for (const width of [60, 240, 480, 1000])
          for (const future of [true, false])
            expect(followWaterfallSessionViewport(session, now, width, { future })).toEqual(
              old.followWaterfallViewport([session], now, width, { future }),
            )
      }
  } finally {
    f.close()
  }
})

it('ignores history answers from a closed opening and superseded phase request', async () => {
  const f = await waterfallFixture()
  const answers: Array<
    (answer: { sessions: Record<string, Array<{ at: string; phase: string }>> }) => void
  > = []
  const query = vi.fn(
    () =>
      new Promise<{ sessions: Record<string, Array<{ at: string; phase: string }>> }>((resolve) =>
        answers.push(resolve),
      ),
  )
  const view = new WaterfallView(f.screen, query)
  view.open(NOW)
  const seat = view.seat(f.pool.sessionObject('s-0-0'))
  const release = seat.demand()
  try {
    const row = f.pool.row('session', 's-0-0') as Record<string, unknown>
    f.pool.apply({
      type: 'update',
      rows: [
        {
          kind: 'session',
          id: 's-0-0',
          value: { ...row, agentState: { ...(row.agentState as object), phase: 'needs_user' } },
        },
      ],
    })
    seat.load()
    answers[0]!({ sessions: { 's-0-0': [{ at: new Date(NOW).toISOString(), phase: 'working' }] } })
    await Promise.resolve()
    expect(seat.samples).toEqual([])
    view.close()
    answers[1]!({
      sessions: { 's-0-0': [{ at: new Date(NOW).toISOString(), phase: 'needs_user' }] },
    })
    await Promise.resolve()
    expect(seat.samples).toEqual([])
    expect(query).toHaveBeenCalledTimes(2)
  } finally {
    release()
    view.close()
    f.close()
  }
})
