import { asIssueId, asRepoId, asSessionId, asUserId, SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { draftIssueRow, draftSortKey, startingSessionRow } from './launch-rows'

describe('startingSessionRow', () => {
  const base = {
    sessionId: asSessionId('sess-1'),
    issueId: asIssueId('iss_1'),
    userId: asUserId('user-1'),
    agentKind: 'claude-code' as const,
    cwd: '/home/u/my-proj',
    nowIso: '2026-07-07T00:00:00.000Z',
  }

  it('is a schema-valid SessionMeta', () => {
    // The whole point of the builder: a fully-valid row the replica/derive code
    // can render, so a future required field fails loudly here, not at runtime.
    expect(() => SessionMeta.parse(startingSessionRow(base))).not.toThrow()
  })

  it('carries the caller ids and starting status', () => {
    const s = startingSessionRow(base)
    expect(s.sessionId).toBe('sess-1')
    expect(s.issueId).toBe('iss_1')
    expect(s.status).toBe('starting')
    expect(s.agentKind).toBe('claude-code')
    expect(s.cwd).toBe('/home/u/my-proj')
  })

  it('titles from the cwd basename (matching the server default)', () => {
    expect(startingSessionRow(base).title).toBe('my-proj')
  })

  it('stamps user provenance and spawn origin', () => {
    const s = startingSessionRow(base)
    expect(s.spawnedBy).toBe('user')
    expect(s.origin).toEqual({ kind: 'spawn' })
  })
})

describe('draftIssueRow', () => {
  const base = {
    issueId: asIssueId('iss_1'),
    userId: asUserId('user-1'),
    repoPath: '/home/u/my-proj',
    repoId: asRepoId('repo-1'),
    sortKey: 'c',
    agentKind: 'claude-code' as const,
    nowIso: '2026-07-07T00:00:00.000Z',
  }

  it('carries the canonical issue fields for optimistic rendering', () => {
    expect(draftIssueRow(base)).toMatchObject({
      intentOrigin: 'human',
      isDraftVessel: true,
      description: '',
      tuckedAt: null,
      memberSessionIds: [],
      childIds: [],
    })
  })

  it('is a draft vessel with no worktree, carrying the caller id and repo', () => {
    const i = draftIssueRow(base)
    expect(i.id).toBe('iss_1')
    expect(i.isDraftVessel).toBe(true)
    expect(i.worktreePath).toBeNull()
    expect(i.repoPath).toBe('/home/u/my-proj')
    expect(i.repoId).toBe('repo-1')
    expect(i.sortKey).toBe('c')
    expect(i.defaultAgent).toBe('claude-code')
    // A draft-agent sidebar row keys on these; it must not read as archived work.
    expect(i.archived).toBe(false)
  })

  it('mints the optimistic key above the existing project group', () => {
    const existing = [
      draftIssueRow({ ...base, issueId: asIssueId('iss_a'), sortKey: 'i' }),
      draftIssueRow({ ...base, issueId: asIssueId('iss_b'), sortKey: 'c' }),
      draftIssueRow({
        ...base,
        issueId: asIssueId('iss_other'),
        repoId: asRepoId('repo-2'),
        sortKey: '1',
      }),
    ]
    const key = draftSortKey(existing, base.repoPath, base.repoId)
    expect(key < 'c').toBe(true)
  })
})
