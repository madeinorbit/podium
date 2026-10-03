import type { SessionView } from '@podium/client-core/session-values'
import { MobxPool } from './pool'
import { autorun, compareStructural, computed, type IComputedValue } from 'mobx'
import { expect, it, vi } from 'vitest'
import { createScanningHeaderSessions } from '../../../apps/web/harness/header-scan-control'

it('keeps the full-scan control above the 16-read bound with 17,000 cold sessions', () => {
  const now = Date.parse('2026-10-03T12:00:00Z')
  const stamp = new Date(now).toISOString()
  const resident = { sessionId: 'resident', status: 'live', agentKind: 'codex', cwd: '/synthetic',
    lastActiveAt: stamp, agentState: { phase: 'idle', since: stamp } } as SessionView
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined,
    { header: true, load: () => undefined, schedule: () => () => {} })
  pool.apply({ type: 'replace', rows: [
    { kind: 'session', id: resident.sessionId, value: resident as never },
    ...Array.from({ length: 17_000 }, (_, index) => {
      const id = `cold-${index}`
      return { kind: 'session' as const, id, value: { ...resident, sessionId: id, status: 'exited', stoppedAt: '2026-01-01T00:00:00Z' } as never }
    }),
  ] })
  const cache = new Map<string, IComputedValue<unknown>>()
  const control = createScanningHeaderSessions(pool, <T>(key: string, read: () => T): T => {
    let value = cache.get(key)
    if (!value) { value = computed(read, { equals: compareStructural }); cache.set(key, value) }
    return value.get() as T
  })
  let working: string[] = []
  const stop = autorun(() => { working = control.working().map(row => row.sessionId) })
  const reader = vi.spyOn(pool, 'row')
  try {
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: resident.sessionId,
      value: { ...resident, agentState: { phase: 'working', since: stamp } } as never }] })
    expect(working).toEqual(['resident'])
    const reads = reader.mock.calls.filter(([entity]) => entity === 'session').length
    expect(reads).toBeGreaterThanOrEqual(17_000)
    expect(() => expect(reads).toBeLessThanOrEqual(16)).toThrow()
  } finally { reader.mockRestore(); stop(); control.dispose(); cache.clear(); pool.dispose() }
})
