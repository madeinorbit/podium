import { IssueWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  mergeOptimistic,
  optimisticDraftIssue,
  optimisticStartingSession,
} from './optimistic-spawn'

describe('optimisticStartingSession', () => {
  const base = {
    sessionId: 'sess-1',
    issueId: 'iss_1',
    agentKind: 'claude-code' as const,
    cwd: '/home/u/my-proj',
    nowIso: '2026-07-07T00:00:00.000Z',
  }

  it('is a schema-valid SessionMeta', () => {
    // The whole point of the builder: a fully-valid row the replica/derive code
    // can render, so a future required field fails loudly here, not at runtime.
    expect(() => SessionMeta.parse(optimisticStartingSession(base))).not.toThrow()
  })

  it('carries the caller ids and starting status', () => {
    const s = optimisticStartingSession(base)
    expect(s.sessionId).toBe('sess-1')
    expect(s.issueId).toBe('iss_1')
    expect(s.status).toBe('starting')
    expect(s.agentKind).toBe('claude-code')
    expect(s.cwd).toBe('/home/u/my-proj')
  })

  it('titles from the cwd basename (matching the server default)', () => {
    expect(optimisticStartingSession(base).title).toBe('my-proj')
  })

  it('stamps user provenance and spawn origin', () => {
    const s = optimisticStartingSession(base)
    expect(s.spawnedBy).toBe('user')
    expect(s.origin).toEqual({ kind: 'spawn' })
  })
})

describe('optimisticDraftIssue', () => {
  const base = {
    issueId: 'iss_1',
    repoPath: '/home/u/my-proj',
    agentKind: 'claude-code' as const,
    nowIso: '2026-07-07T00:00:00.000Z',
  }

  it('is a schema-valid IssueWire', () => {
    expect(() => IssueWire.parse(optimisticDraftIssue(base))).not.toThrow()
  })

  it('is a draft vessel with no worktree, carrying the caller id and repo', () => {
    const i = optimisticDraftIssue(base)
    expect(i.id).toBe('iss_1')
    expect(i.draft).toBe(true)
    expect(i.worktreePath).toBeNull()
    expect(i.repoPath).toBe('/home/u/my-proj')
    expect(i.defaultAgent).toBe('claude-code')
    // A draft-agent sidebar row keys on these; it must not read as archived work.
    expect(i.archived).toBe(false)
  })
})

describe('mergeOptimistic', () => {
  const key = (r: { id: string }) => r.id

  it('returns the SAME base array when the overlay is empty (no re-render churn)', () => {
    const base = [{ id: 'a' }]
    expect(mergeOptimistic(base, [], key)).toBe(base)
  })

  it('appends overlay rows whose id is not in the base', () => {
    const base = [{ id: 'a' }]
    expect(mergeOptimistic(base, [{ id: 'b' }], key)).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  it('lets the base win (no duplicate) once the real row lands, and keeps base identity', () => {
    // The reconcile case: server truth for id 'a' has arrived; the optimistic 'a'
    // must not double the row.
    const base = [{ id: 'a', real: true }]
    const merged = mergeOptimistic(base, [{ id: 'a', real: false }], key)
    expect(merged).toBe(base)
  })
})
