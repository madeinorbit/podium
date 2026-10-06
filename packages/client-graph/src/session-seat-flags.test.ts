import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { MobxPool } from './pool'
import { sessionSeats } from './session-seats'

it('publishes archived-state changes without depending on display fields or row residency', () => {
  const load = vi.fn(() => undefined)
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse('2026-10-01T12:00:00Z') }, undefined, { load })
  const issue = { id: 'owner', title: 'Owner', stage: 'done', archived: true, parentId: null, deps: [] }
  const row = { sessionId: 'seat', issueId: 'owner', archived: false, agentKind: 'codex', status: 'exited' }
  pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: 'owner', value: issue }, { kind: 'session', id: 'seat', value: row }] })
  const values: Array<boolean | undefined> = []
  const stop = autorun(() => { values.push(pool.queries.sessionArchived('seat')) })
  const stopSeat = autorun(() => { sessionSeats(pool).seat('seat') })
  const flag = vi.spyOn(pool.queries, 'sessionArchived')
  const update = (value: object | undefined) => pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'seat', value }] })
  try {
    expect(pool.tables.session.has('seat')).toBe(false)
    expect(values).toEqual([false])
    update({ ...row, title: 'Renamed', readAt: '2026-10-01T12:00:00Z', lastActiveAt: '2026-10-01T12:00:01Z' })
    expect(values).toEqual([false])
    expect(flag).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
    update({ ...row, archived: true })
    expect(values).toEqual([false, true])
    update(row)
    expect(values).toEqual([false, true, false])
    update(undefined)
    expect(values).toEqual([false, true, false, undefined])
    pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: 'owner', value: issue }, { kind: 'session', id: 'seat', value: { ...row, archived: true } }] })
    expect(values.at(-1)).toBe(true)
  } finally { flag.mockRestore(); stopSeat(); stop(); pool.dispose() }
})
