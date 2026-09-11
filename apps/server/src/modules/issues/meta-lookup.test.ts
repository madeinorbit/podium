import { WorldIndex } from '../world-index'
import { asSessionId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { openTestStore } from '../../test-support/open-test-store'
import { type IssueDeps, IssueService } from './service'
import { issueTestPlumbing } from './service/test-plumbing'

async function harness() {
  const store = await openTestStore(':memory:')
  // POD-826's assertion, restated for POD-3857: the cheap lookups must not
  // enumerate the fleet AT ALL — not even the in-memory facts read that
  // replaced the reader-scoped projection here.
  const sessionFacts = vi.fn(() => [])
  const deps: IssueDeps = {
    store,
    worldIndex: (await WorldIndex.load(store)).reader,
    sessionFacts,
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
    const created = await svc.create({ repoPath: '/repo', title: 'metadata', startNow: false })
    sessionFacts.mockClear()

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
    expect(sessionFacts).not.toHaveBeenCalled()
  })

  it('uses the committed index without enumerating rows and retains staged reads', async () => {
    const { deps, svc } = await harness()
    const created = await svc.create({ repoPath: '/repo', title: 'indexed', startNow: false })
    const row = (await svc.getMeta(created.id))!
    const rows = (svc as unknown as { rows: Map<string, typeof row> }).rows
    const scan = vi.spyOn(rows, 'values')
    const indexed = vi.fn(deps.worldIndex!.issueForWorktree)
    deps.worldIndex = { ...deps.worldIndex!, issueForWorktree: indexed }
    // The row map deliberately differs to model a staged worktree installation.
    rows.set(created.id, { ...row, worktreePath: '/staged' })
    for (let i = 0; i < 200; i++) expect(svc.issueForCwd('/staged/src')).toBeNull()
    expect(indexed).toHaveBeenCalledTimes(200)
    expect(scan).not.toHaveBeenCalled()
    deps.applyCommit = { spanOpen: () => true, onCommit: () => ({ live: () => true }) }
    expect(svc.issueForCwd('/staged/src')).toBe(created.id)
    expect(indexed).toHaveBeenCalledTimes(200)
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('keeps get as a session-free wire lookup', async () => {
    const { sessionFacts, svc } = await harness()
    const created = await svc.create({ repoPath: '/repo', title: 'wire', startNow: false })
    sessionFacts.mockClear()

    expect(await svc.get(created.id)).toMatchObject({ id: created.id })
    expect(await svc.get(created.id)).not.toHaveProperty('sessions')
    expect(sessionFacts).not.toHaveBeenCalled()
  })
})
