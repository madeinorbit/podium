/**
 * RECONNECTING IS A MODEL FACT, NEVER A ROW FIELD (POD-6646, ADR 12 D1;
 * frontend-data rules 1 and 3).
 *
 * A session reads as reconnecting from its machine's LiveStore condition. The
 * stored row is the same object before and after, and never carries the field;
 * the session model and the roll-ups' row reader derive it where they read, and
 * a machine's link change redraws only the sessions on that machine.
 */

import '@podium/client-graph/synced-models'
import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
import { liveFixture } from './live-fixture'
import { MobxPool } from './pool'
import { verdictPartOf } from './worklist/visible'

const NOW = Date.parse('2026-11-09T00:00:00Z')
const at = new Date(NOW).toISOString()
const session = (id: string, machineId: string) => ({
  sessionId: id,
  title: id,
  agentKind: 'codex',
  status: 'live',
  cwd: `/w/${id}`,
  machineId,
  lastActiveAt: at,
  agentState: { phase: 'idle', since: at, nativeSubagentCount: 0, idle: { kind: 'done' } },
})

function fixture() {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW })
  pool.apply({
    type: 'replace',
    rows: [
      { kind: 'session', id: 'a', value: session('a', 'm-a') as never },
      { kind: 'session', id: 'b', value: session('b', 'm-b') as never },
    ],
  })
  const live = liveFixture(pool, () => NOW)
  live.online('m-a', true)
  live.online('m-b', true)
  return { pool, live }
}

describe('a reconnecting session', () => {
  it('leaves its stored row as it was: the same object, with no reconnecting field', () => {
    const { pool, live } = fixture()
    try {
      const before = pool.row('session', 'a')
      const loaded = pool.visibleInputs.loadedSession('a')
      live.online('m-a', false)
      expect(pool.sessionObject('a').reconnecting).toBe(true)
      expect(pool.visibleInputs.sessionReconnecting?.('a')).toBe(true)
      for (const row of [pool.row('session', 'a'), pool.visibleInputs.loadedSession('a')]) {
        expect(row).toBeTypeOf('object')
        expect(Object.hasOwn(row as object, 'reconnecting')).toBe(false)
      }
      expect(pool.row('session', 'a')).toBe(before)
      expect(pool.visibleInputs.loadedSession('a')).toBe(loaded)
      // The roll-up reads it where it reads: a reconnecting seat is working.
      const verdict = verdictPartOf(pool.visibleInputs, 'a')
      expect(typeof verdict === 'object' && verdict?.roles.delegate.working).toBe(true)
    } finally {
      pool.dispose()
    }
  })

  it('redraws only its own entry when its machine link changes', () => {
    const { pool, live } = fixture()
    const runs = { a: 0, b: 0 }
    const stops = (['a', 'b'] as const).map((id) =>
      autorun(() => {
        pool.sessionObject(id).workingFact
        pool.visibleInputs.sessionReconnecting?.(id)
        runs[id]++
      }),
    )
    try {
      expect(runs).toEqual({ a: 1, b: 1 })
      live.online('m-a', false)
      expect(pool.sessionObject('a').workingFact).toBe(true)
      expect(runs).toEqual({ a: 2, b: 1 })
      live.online('m-a', true)
      expect(runs).toEqual({ a: 3, b: 1 })
      // Unknown is not offline: no change for a session on that machine.
      live.online('m-b', undefined)
      expect(pool.sessionObject('b').reconnecting).toBe(false)
      expect(runs.a).toBe(3)
    } finally {
      for (const stop of stops) stop()
      pool.dispose()
    }
  })
})
