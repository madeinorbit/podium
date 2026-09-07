import { asSessionId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { openTestStore } from '../../test-support/open-test-store'
import { type IssueDeps, IssueService } from './service'
import { issueTestPlumbing } from './service/test-plumbing'

async function harness() {
  const store = await openTestStore(':memory:')
  const listSessions = vi.fn(async () => [])
  const deps: IssueDeps = {
    store,
    listSessions,
    getSettings: async () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: '',
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: vi.fn(async () => ({ sessionId: asSessionId('s1'), machine: 'machine-under-test' })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    ...issueTestPlumbing(),
    setSessionArchived: vi.fn(),
    now: () => '2026-07-17T00:00:00.000Z',
  }
  return { listSessions, svc: await IssueService.create(deps) }
}

describe('POD-826 lightweight issue lookups', () => {
  it('returns raw metadata and checks existence without enumerating sessions', async () => {
    const { listSessions, svc } = await harness()
    const created = await svc.create({ repoPath: '/repo', title: 'metadata', startNow: false })
    listSessions.mockClear()

    expect(await svc.getMeta(String(created.seq))).toMatchObject({
      id: created.id,
      repoPath: '/repo',
      seq: created.seq,
      title: 'metadata',
      worktreePath: null,
      parentId: null,
    })
    expect(await svc.getMeta(created.id)).not.toHaveProperty('sessions')
    expect(await svc.has(`#${created.seq}`)).toBe(true)
    expect(await svc.has('missing')).toBe(false)
    expect(listSessions).not.toHaveBeenCalled()
  })

  it('keeps get as a session-free wire lookup', async () => {
    const { listSessions, svc } = await harness()
    const created = await svc.create({ repoPath: '/repo', title: 'wire', startNow: false })
    listSessions.mockClear()

    expect(await svc.get(created.id)).toMatchObject({ id: created.id })
    expect(await svc.get(created.id)).not.toHaveProperty('sessions')
    expect(listSessions).not.toHaveBeenCalled()
  })
})
