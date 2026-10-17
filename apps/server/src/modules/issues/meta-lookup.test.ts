import { asSessionId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { openTestStore } from '../../test-support/open-test-store'
import { type IssueDeps, IssueService } from './service'
import { issueTestPlumbing } from './service/test-plumbing'

async function harness() {
  const store = await openTestStore(':memory:')
  // An issue's repo resolves only through a machine that reported it (2b803efb5),
  // so the fixture repo is reported by the host machine.
  await store.repos.addRepo('/repo', store.hostMachineId)
  // POD-826's assertion, restated for POD-3857: the cheap lookups must not
  // enumerate the fleet AT ALL — not even the in-memory facts read that
  // replaced the reader-scoped projection here.
  const sessionFacts = vi.fn(() => [])
  const deps: IssueDeps = {
    store,
    sessionFacts,
    // Every fleet read goes through the one spy, so "not called" covers them all.
    runningSessionFacts: sessionFacts,
    readSessionFacts: async () => sessionFacts(),
    readSessionFactsById: async () => undefined,
    readSessionFactsByIssue: async () => [],
    sessionById: async () => undefined,
    listSessionsForIssue: async () => [],
    sessionsById: async () => [],
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
  return { deps, store, sessionFacts, svc: await IssueService.create(deps) }
}

describe('POD-826 lightweight issue lookups', () => {
  it('returns raw metadata and checks existence without enumerating sessions', async () => {
    const { sessionFacts, svc } = await harness()
    const created = await svc.crud.create({ repoPath: '/repo', title: 'metadata', startNow: false })
    sessionFacts.mockClear()

    expect(await svc.reports.getMeta(String(created.seq))).toMatchObject({
      id: created.id,
      repoPath: '/repo',
      seq: created.seq,
      title: 'metadata',
      worktreePath: null,
      parentId: null,
    })
    expect(await svc.reports.getMeta(created.id)).not.toHaveProperty('sessions')
    expect(await svc.reports.has(`#${created.seq}`)).toBe(true)
    expect(await svc.reports.has('missing')).toBe(false)
    expect(sessionFacts).not.toHaveBeenCalled()
  })

  it('answers the folder owner from the table, inside and outside a write span', async () => {
    const { deps, svc } = await harness()
    const created = await svc.crud.create({ repoPath: '/repo', title: 'indexed', startNow: false })
    const row = (await deps.store.issues.getIssue(created.id))!
    const scan = vi.spyOn(deps.store.issues, 'listIssueRows')
    await deps.store.issues.upsertIssue({ ...row, worktreePath: '/wt' })
    // One indexed query per answer (POD-6155); every issue is never read.
    for (let i = 0; i < 20; i++) expect(await svc.reports.issueForCwd('/wt/src')).toBe(created.id)
    expect(scan).not.toHaveBeenCalled()
    // Inside a write span the same query sees the span's own write.
    await deps.store.transact(async () => {
      await deps.store.issues.upsertIssue({ ...row, worktreePath: '/moved' })
      expect(await svc.reports.issueForCwd('/moved/src')).toBe(created.id)
      expect(await svc.reports.issueForCwd('/wt/src')).toBeNull()
    })
    expect(scan).not.toHaveBeenCalled()
  })

  it('keeps get as a session-free wire lookup', async () => {
    const { sessionFacts, svc } = await harness()
    const created = await svc.crud.create({ repoPath: '/repo', title: 'wire', startNow: false })
    sessionFacts.mockClear()

    expect(await svc.reports.get(created.id)).toMatchObject({ id: created.id })
    expect(await svc.reports.get(created.id)).not.toHaveProperty('sessions')
    expect(sessionFacts).not.toHaveBeenCalled()
  })
})
