// Cross-harness child grouping (#237) [spec:SP-34d7 web]: sessions spawned by
// another session nest under their spawner in the sidebar; consumed (exited)
// children auto-tuck behind a disclosure. M6 also expands for native counts.
import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  groupSessionsByParent,
  isConsumedChild,
  nativeSubagentLabel,
  sessionIssueLinkage,
  sessionsNeedChildRows,
} from './derive'

function sess(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: id,
    cwd: '/repo',
    createdAt: '2026-07-13T00:00:00.000Z',
    lastActiveAt: '2026-07-13T01:00:00.000Z',
    agentKind: 'claude-code',
    status: 'live',
    busy: false,
    archived: false,
    title: id,
    ...over,
  } as unknown as SessionMeta
}

describe('groupSessionsByParent', () => {
  it('nests spawned children under their listed parent, preserving order', () => {
    const parent = sess('p')
    const c1 = sess('c1', { spawnedBy: 'session:p' })
    const c2 = sess('c2', { spawnedBy: 'session:p' })
    const other = sess('o')
    const groups = groupSessionsByParent([parent, c1, other, c2])
    expect(groups.map((g) => g.session.sessionId)).toEqual(['p', 'o'])
    expect(groups[0]!.children.map((s) => s.sessionId)).toEqual(['c1', 'c2'])
  })

  it('nests a single remote-spawned child under its parent (count=1 still nests)', () => {
    const groups = groupSessionsByParent([
      sess('p'),
      sess('c1', { spawnedBy: 'session:p', issueId: 'iss_child', displayRef: 'POD-9-B' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.children).toHaveLength(1)
    expect(groups[0]!.children[0]!.sessionId).toBe('c1')
  })

  it('a child whose spawner is NOT listed stays top-level', () => {
    const groups = groupSessionsByParent([sess('a', { spawnedBy: 'session:gone' })])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.children).toHaveLength(0)
  })

  it('issue-spawned sessions are top-level (only session: parents nest)', () => {
    const groups = groupSessionsByParent([sess('a', { spawnedBy: 'issue:iss_1' }), sess('b')])
    expect(groups.map((g) => g.session.sessionId)).toEqual(['a', 'b'])
  })

  it('grandchildren fold into the topmost listed ancestor', () => {
    const groups = groupSessionsByParent([
      sess('p'),
      sess('c', { spawnedBy: 'session:p' }),
      sess('gc', { spawnedBy: 'session:c' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.children.map((s) => s.sessionId)).toEqual(['c', 'gc'])
  })

  it('consumed (exited) children split out for the auto-tuck disclosure', () => {
    const done = sess('c1', { spawnedBy: 'session:p', status: 'exited' })
    const live = sess('c2', { spawnedBy: 'session:p' })
    expect(isConsumedChild(done)).toBe(true)
    expect(isConsumedChild(live)).toBe(false)
    const groups = groupSessionsByParent([sess('p'), done, live])
    expect(groups[0]!.children.map((s) => s.sessionId)).toEqual(['c2'])
    expect(groups[0]!.consumed.map((s) => s.sessionId)).toEqual(['c1'])
  })

  it('a spawnedBy cycle does not hang and keeps both sessions', () => {
    const a = sess('a', { spawnedBy: 'session:b' })
    const b = sess('b', { spawnedBy: 'session:a' })
    const groups = groupSessionsByParent([a, b])
    const ids = groups.flatMap((g) => [g.session.sessionId, ...g.children.map((s) => s.sessionId)])
    expect(ids.sort()).toEqual(['a', 'b'])
  })
})

describe('sessionsNeedChildRows', () => {
  it('expands parent + single remote child', () => {
    expect(
      sessionsNeedChildRows([sess('p'), sess('c', { spawnedBy: 'session:p' })]),
    ).toBe(true)
  })

  it('expands a lone parent with native subagents', () => {
    expect(
      sessionsNeedChildRows([
        sess('p', { agentState: { phase: 'working', since: 't', nativeSubagentCount: 1 } }),
      ]),
    ).toBe(true)
  })

  it('does not expand a lone session with no native subagents', () => {
    expect(sessionsNeedChildRows([sess('p')])).toBe(false)
  })
})

describe('nativeSubagentLabel / sessionIssueLinkage', () => {
  it('labels native counts and surfaces issue linkage from SessionMeta', () => {
    expect(nativeSubagentLabel(2)).toBe('2 subagents')
    expect(sessionIssueLinkage(sess('c', { displayRef: 'POD-9-B', issueId: 'iss_x' }))).toBe(
      'POD-9-B',
    )
    expect(sessionIssueLinkage(sess('c', { issueId: 'iss_x' }))).toBe('iss_x')
  })
})
