// Cross-harness child grouping + native-subagent expand rules (M6 / POD-900).
import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  groupSessionsByParent,
  isConsumedChild,
  nativeSubagentCountOf,
  nativeSubagentLabel,
  sessionHasNativeSubagents,
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
  it('nests a single remote-spawned child under its listed parent', () => {
    const parent = sess('p')
    const child = sess('c1', { spawnedBy: 'session:p' })
    const groups = groupSessionsByParent([parent, child])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.session.sessionId).toBe('p')
    expect(groups[0]!.children.map((s) => s.sessionId)).toEqual(['c1'])
  })

  it('nests spawned children under their listed parent, preserving order', () => {
    const parent = sess('p')
    const c1 = sess('c1', { spawnedBy: 'session:p' })
    const c2 = sess('c2', { spawnedBy: 'session:p' })
    const other = sess('o')
    const groups = groupSessionsByParent([parent, c1, other, c2])
    expect(groups.map((g) => g.session.sessionId)).toEqual(['p', 'o'])
    expect(groups[0]!.children.map((s) => s.sessionId)).toEqual(['c1', 'c2'])
  })

  it('a child whose spawner is NOT listed stays top-level', () => {
    const groups = groupSessionsByParent([sess('a', { spawnedBy: 'session:gone' })])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.children).toHaveLength(0)
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
})

describe('sessionsNeedChildRows', () => {
  it('is false for an empty list or a lone session with no native subagents', () => {
    expect(sessionsNeedChildRows([])).toBe(false)
    expect(sessionsNeedChildRows([sess('p')])).toBe(false)
  })

  it('is true for a lone parent with nativeSubagentCount > 0', () => {
    const parent = sess('p', {
      agentState: { phase: 'working', since: 't', nativeSubagentCount: 2 },
    })
    expect(sessionsNeedChildRows([parent])).toBe(true)
  })

  it('is true for parent + a single remote-spawned child (do not hide genuine child)', () => {
    const parent = sess('p')
    const child = sess('c1', { spawnedBy: 'session:p' })
    expect(sessionsNeedChildRows([parent, child])).toBe(true)
  })

  it('is true for two unrelated sessions (multi-agent row)', () => {
    expect(sessionsNeedChildRows([sess('a'), sess('b')])).toBe(true)
  })
})

describe('nativeSubagent helpers', () => {
  it('reads nativeSubagentCount from agentState (0 when absent)', () => {
    expect(nativeSubagentCountOf(sess('a'))).toBe(0)
    expect(
      nativeSubagentCountOf(
        sess('b', { agentState: { phase: 'working', since: 't', nativeSubagentCount: 3 } }),
      ),
    ).toBe(3)
    expect(
      sessionHasNativeSubagents(
        sess('c', { agentState: { phase: 'working', since: 't', nativeSubagentCount: 1 } }),
      ),
    ).toBe(true)
    expect(sessionHasNativeSubagents(sess('d'))).toBe(false)
  })

  it('formats the nested indicator label', () => {
    expect(nativeSubagentLabel(0)).toBe('')
    expect(nativeSubagentLabel(1)).toBe('1 subagent')
    expect(nativeSubagentLabel(3)).toBe('3 subagents')
  })
})

describe('sessionIssueLinkage', () => {
  it('prefers displayRef over issueId; null when neither is set', () => {
    expect(sessionIssueLinkage(sess('a'))).toBeNull()
    expect(sessionIssueLinkage(sess('b', { issueId: 'iss_1' }))).toBe('iss_1')
    expect(
      sessionIssueLinkage(sess('c', { issueId: 'iss_1', displayRef: 'POD-42-B' })),
    ).toBe('POD-42-B')
    expect(sessionIssueLinkage(sess('d', { displayRef: '  ' }))).toBeNull()
  })
})
