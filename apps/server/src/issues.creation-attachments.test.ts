import { asArtifactId, asSessionId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type IssueDeps, IssueService } from './modules/issues/service'
import { issueTestPlumbing } from './modules/issues/service/test-plumbing'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'
import { sessionReadPorts } from './test-support/session-facts'

describe('creation attachments at review', () => {
  let store: SessionStore

  afterEach(async () => {
    await store?.close()
  })

  async function harness() {
    store = await openTestStore(':memory:')
    await store.repos.addRepo('/r', store.hostMachineId)
    let nextArtifact = 0
    const upload = vi.fn(async ({ filename }: { filename: string }) => ({
      artifactId: asArtifactId(`creation-${++nextArtifact}`),
      entry: filename,
      files: [{ path: filename, size: 3 }],
    }))
    const remove = vi.fn(async () => {})
    const deps: IssueDeps = {
      store,
      ...sessionReadPorts(() => []),
      ...issueTestPlumbing(),
      getSettings: async () => normalizeSettings({}),
      spawnSession: async () => ({ sessionId: asSessionId('unused'), machine: 'unused' }),
      repoOp: async () => ({ ok: true, output: '' }),
      artifacts: {
        upload,
        remove,
        snapshot: vi.fn(),
        read: async () => null,
        removeIssue: async () => {},
      },
    }
    const svc = await IssueService.create(deps)
    const issue = await svc.crud.create({ repoPath: '/r', title: 'Coordinator', startNow: false })
    return { svc, issue, upload, remove }
  }

  it('marks creation uploads and allows review with no worktree', async () => {
    const { svc, issue, upload } = await harness()
    for (let n = 0; n < 6; n++) {
      await svc.crud.panelArtifactUpload(issue.id, {
        id: `att-${n}`,
        filename: 'image.png',
        dataBase64: 'aW1n',
      })
    }
    const reviewed = await svc.crud.update(issue.id, { stage: 'review' })
    expect(reviewed.stage).toBe('review')
    expect(reviewed.worktreePath).toBeUndefined()
    const artifacts = reviewed.panel?.artifacts ?? []
    expect(artifacts).toHaveLength(6)
    for (const artifact of artifacts) {
      expect(artifact).toMatchObject({ sourceKind: 'creation-attachment', entry: 'image.png' })
    }
    expect(upload).toHaveBeenCalledTimes(6)
  })

  it('keeps creation provenance when an upload replaces the same attachment', async () => {
    const { svc, issue, remove } = await harness()
    const input = { id: 'att-1', filename: 'image.png', dataBase64: 'aW1n' }
    await svc.crud.panelArtifactUpload(issue.id, input)
    const updated = await svc.crud.panelArtifactUpload(issue.id, input)
    expect(updated.panel?.artifacts).toEqual([
      expect.objectContaining({
        path: 'attachments/att-1/image.png',
        sourceKind: 'creation-attachment',
        artifactId: 'creation-2',
      }),
    ])
    expect(remove).toHaveBeenCalledWith(issue.id, 'creation-1')
  })

  it('still blocks unsnapshotted agent evidence mixed with creation attachments', async () => {
    const { svc, issue } = await harness()
    await svc.crud.panelArtifactUpload(issue.id, {
      id: 'att-1',
      filename: 'image.png',
      dataBase64: 'aW1n',
    })
    await svc.crud.panelApply(issue.id, { op: 'artifact-add', path: '/tmp/review.png' })
    await expect(svc.crud.update(issue.id, { stage: 'review' })).rejects.toThrow(
      /no owning worktree/,
    )
    await svc.crud.update(issue.id, { worktreePath: '/wt/issue-1' })
    await expect(svc.crud.update(issue.id, { stage: 'review' })).rejects.toThrow(
      /outside the owning issue worktree/,
    )
  })
})
