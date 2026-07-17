import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../../store'
import { type IssueDeps, IssueService } from './service'
import { issueTestPlumbing } from './service/test-plumbing'

function harness() {
  const store = new SessionStore(':memory:')
  const listSessions = vi.fn(() => [])
  const deps: IssueDeps = {
    store,
    listSessions,
    getSettings: () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: '',
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: vi.fn(() => ({ sessionId: 's1' })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    ...issueTestPlumbing(),
    setSessionArchived: vi.fn(),
    now: () => '2026-07-17T00:00:00.000Z',
  }
  return { listSessions, svc: new IssueService(deps) }
}

describe('POD-826 lightweight issue lookups', () => {
  it('returns raw metadata and checks existence without enumerating sessions', () => {
    const { listSessions, svc } = harness()
    const created = svc.create({ repoPath: '/repo', title: 'metadata', startNow: false })
    listSessions.mockClear()

    expect(svc.getMeta(String(created.seq))).toMatchObject({
      id: created.id,
      repoPath: '/repo',
      seq: created.seq,
      title: 'metadata',
      worktreePath: null,
      parentId: null,
    })
    expect(svc.getMeta(created.id)).not.toHaveProperty('sessions')
    expect(svc.has(`#${created.seq}`)).toBe(true)
    expect(svc.has('missing')).toBe(false)
    expect(listSessions).not.toHaveBeenCalled()
  })

  it('keeps get as the full wire-facing lookup', () => {
    const { listSessions, svc } = harness()
    const created = svc.create({ repoPath: '/repo', title: 'wire', startNow: false })
    listSessions.mockClear()

    expect(svc.get(created.id)).toMatchObject({ id: created.id, sessions: [] })
    expect(listSessions).toHaveBeenCalledOnce()
  })
})
