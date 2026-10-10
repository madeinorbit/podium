// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { MobxPool } from './pool'
import { createColdIndex } from './shared/cold-index'
import { SCHEMA } from './shared/schema'
import * as sessionQuestions from './shared/session-questions'
import type { RowRecord, RowSourceEvent } from './shared/source'

const stamp = '2026-10-01T00:00:00Z'
const session = (id: string, group?: string, patch: object = {}): RowRecord => ({
  kind: 'session', id, value: {
    sessionId: id, cwd: '/repo/nested', issueId: 'one', agentKind: 'codex', status: 'hibernated',
    archived: false, headless: false, machineId: 'machine', createdAt: stamp, lastActiveAt: stamp,
    refRepoId: 'repo', refSeq: 1, refLetter: 'A',
    ...(group ? { resume: { kind: 'codex', value: group } } : {}), ...patch,
  },
} as RowRecord)
const seed = () => [
  { kind: 'repo', id: 'repo', value: { id: 'repo', prefix: 'POD', repoPath: '/repo' } } as RowRecord,
  session('a', 'primary', { status: 'exited' }), session('z', 'primary'), session('b'),
  session('0', 'other', { status: 'exited' }), session('y', 'other'),
]
const difference = (after: Readonly<Record<string, number>>, before: Readonly<Record<string, number>>) =>
  Object.fromEntries(Object.entries(after).map(([key, count]) => [key, count - before[key]!]))

it.each([false, true])('counts order-only incidence and family work before equality barriers (external: %s)', external => {
  let coldQuestions: sessionQuestions.SessionQuestions | undefined
  const create = sessionQuestions.createSessionQuestions
  const spy = vi.spyOn(sessionQuestions, 'createSessionQuestions').mockImplementation((...args) => {
    coldQuestions = create(...args)
    return coldQuestions
  })
  const source = external ? createColdIndex(SCHEMA) : undefined
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
    ...(source ? { cold: () => source } : {}), load: () => undefined, schedule: () => () => {},
  })
  const apply = (event: RowSourceEvent) => { source?.apply(event); pool.apply(event) }
  const incidence = { publications: 0, heartbeatPublications: 0, orderOnlyPublications: 0,
    orderOnlyAddresses: 0, visibilityFlips: 0 }
  try {
    apply({ type: 'replace', rows: seed() })
    const index = source ?? pool.coldIndex()
    expect(coldQuestions).toBeDefined()
    for (let turn = 0; turn < 4; turn++) {
      for (let heartbeat = 0; heartbeat < 32; heartbeat++) {
        const event: RowSourceEvent = { type: 'update', rows: [session('z', 'primary', {
          lastActiveAt: new Date(Date.parse(stamp) + (turn * 32 + heartbeat + 1) * 1000).toISOString(),
        })] }
        apply(event)
        const delta = index.changes(event)
        incidence.publications++; incidence.heartbeatPublications++
        expect(delta.orders).toEqual([]); expect(delta.flips).toEqual([])
      }
      // Moving a loser between two collapsed groups preserves every visibility
      // verdict but changes z's canonical order between a and z.
      const beforeCold = { ...coldQuestions!.updates }, beforeResident = pool.queries.residentUpdates
      const event: RowSourceEvent = { type: 'update', rows: [session('a', turn % 2 ? 'primary' : 'other', { status: 'exited' })] }
      apply(event)
      const delta = index.changes(event)
      incidence.publications++
      incidence.visibilityFlips += delta.flips.length
      expect(delta.flips).toEqual([])
      expect(delta.orders).toEqual([['session', 'z']])
      incidence.orderOnlyPublications++; incidence.orderOnlyAddresses += delta.orders.length
      const cold = difference(coldQuestions!.updates, beforeCold)
      const resident = difference(pool.queries.residentUpdates, beforeResident)
      console.info('[source order family work]', JSON.stringify({ external, turn, cold, resident }))
      const expected = { close: 1, setupCount: 1, setupAgent: 1, reference: 1,
        triage: 1, recent: 0, machine: 1, activity: 1 }
      expect(cold).toEqual(expected)
      expect(resident).toEqual({ sessionFacets: 0, ...expected })
    }
    console.info('[source order incidence: deterministic replay]', JSON.stringify({ external, ...incidence }))
    expect(incidence).toEqual({ publications: 132, heartbeatPublications: 128,
      orderOnlyPublications: 4, orderOnlyAddresses: 4, visibilityFlips: 0 })
  } finally { pool.dispose(); spy.mockRestore() }
})
