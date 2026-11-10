/**
 * A SESSION'S LIVE READINGS ARE MODEL FACTS, NEVER ROW FIELDS (POD-6764, ADR 12
 * D1; frontend-data rules 1 and 3).
 *
 * Busy, the last input time, context use and the terminal's size left the
 * synced record: only the running process knows them. The session model answers
 * them from the LiveStore, the roll-ups read busy where they read the row, and
 * the stored row is the same object before and after.
 */

import '@podium/client-graph/synced-models'
import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
import { liveFixture } from './live-fixture'
import { MobxPool } from './pool'
import { verdictPartOf, withLiveBusy } from './worklist/visible'

const NOW = Date.parse('2026-11-10T00:00:00Z')
const at = new Date(NOW).toISOString()
const shell = (id: string, status = 'live') => ({
  sessionId: id,
  title: id,
  agentKind: 'shell',
  status,
  cwd: `/w/${id}`,
  machineId: 'm-a',
  createdAt: at,
  lastActiveAt: at,
})
const agent = (id: string) => ({
  ...shell(id),
  agentKind: 'codex',
  agentState: { phase: 'idle', since: at, nativeSubagentCount: 0, idle: { kind: 'done' } },
})

function fixture() {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW })
  pool.apply({
    type: 'replace',
    rows: [
      { kind: 'session', id: 'sh', value: shell('sh') as never },
      { kind: 'session', id: 'done', value: shell('done', 'exited') as never },
      { kind: 'session', id: 'ag', value: agent('ag') as never },
    ],
  })
  const live = liveFixture(pool, () => NOW)
  live.online('m-a', true)
  return { pool, live }
}

describe("a session's live readings", () => {
  it('are unknown until the first reading, then follow the LiveStore', () => {
    const { pool, live } = fixture()
    try {
      const model = pool.sessionObject('sh')
      const seen: unknown[] = []
      const stop = autorun(() => {
        seen.push([model.busy, model.lastInputAt, model.contextUsagePercent, model.geometry])
      })
      expect(seen.at(-1)).toEqual([undefined, undefined, undefined, undefined])

      live.sessionCondition('sh', {
        busy: true,
        requestsGated: 0,
        lastInputAt: '2026-11-10T00:00:05.000Z',
        contextUsagePercent: 41,
      })
      live.sessionTerminalState('sh', { controller: null, geometry: { cols: 132, rows: 43 } })
      expect(seen.at(-1)).toEqual([
        true,
        '2026-11-10T00:00:05.000Z',
        41,
        { cols: 132, rows: 43 },
      ])
      stop()
    } finally {
      pool.dispose()
    }
  })

  it('leave the stored row as it was: the same object, with no live field', () => {
    const { pool, live } = fixture()
    try {
      const before = pool.row('session', 'sh')
      live.sessionCondition('sh', { busy: true, requestsGated: 0 })
      const stop = autorun(() => void pool.sessionObject('sh').busy)
      expect(pool.sessionObject('sh').busy).toBe(true)
      expect(pool.row('session', 'sh')).toBe(before)
      for (const field of ['busy', 'lastInputAt', 'geometry', 'contextUsagePercent']) {
        expect(Object.hasOwn(before as object, field)).toBe(false)
      }
      stop()
    } finally {
      pool.dispose()
    }
  })

  it('a stopped session is not busy and holds no topic for it', () => {
    const { pool, live } = fixture()
    try {
      const stop = autorun(() => void pool.sessionObject('done').busy)
      expect(pool.sessionObject('done').busy).toBe(false)
      expect(live.live.watchedSessions('session.condition')).toEqual([])
      stop()
    } finally {
      pool.dispose()
    }
  })

  it('the roll-up reads a busy shell as working, and asks only sessions with no agent phase', () => {
    const { pool, live } = fixture()
    try {
      const verdicts: unknown[] = []
      const stop = autorun(() => {
        const shellVerdict = verdictPartOf(pool.visibleInputs, 'sh')
        verdictPartOf(pool.visibleInputs, 'ag')
        verdicts.push(typeof shellVerdict === 'object' ? shellVerdict?.working : null)
      })
      // Only the shell's condition is watched: the agent has a phase to go by.
      expect(live.live.watchedSessions('session.condition')).toEqual(['sh'])
      expect(verdicts.at(-1)).toBe(false)

      live.sessionCondition('sh', { busy: true, requestsGated: 0 })
      expect(verdicts.at(-1)).toBe(true)
      live.sessionCondition('sh', { busy: false, requestsGated: 0 })
      expect(verdicts.at(-1)).toBe(false)
      stop()

      // The stored row is read through a copy only while busy; never written.
      const row = pool.visibleInputs.loadedSession('sh')
      expect(typeof row === 'object' && row && withLiveBusy(pool.visibleInputs, 'sh', row)).toBe(row)
    } finally {
      pool.dispose()
    }
  })
})
