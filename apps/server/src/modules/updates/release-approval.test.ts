import type { ReleaseProposal } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createReleaseApprovalFlow } from './release-approval'

const BASE: ReleaseProposal = {
  headSha: 'aaaaaaa',
  version: '0.1.2-dev.1+aaaaaaa',
  branch: 'main',
  commits: [{ sha: 'aaaaaaa', summary: 'Release me' }],
  addedMigrations: [],
  state: 'pending',
}

describe('release approval flow', () => {
  it('refuses a double approval without canceling or duplicating the in-flight build', async () => {
    let current: ReleaseProposal | undefined = BASE
    let finish!: () => void
    const building = new Promise<void>((resolve) => {
      finish = resolve
    })
    const release = vi.fn(async (_proposal: ReleaseProposal) => {
      await building
      current = undefined
    })
    const flow = createReleaseApprovalFlow({
      proposal: async () => current,
      release,
      failureLogs: String,
      now: () => 123,
    })

    const first = flow.approve('user:admin')
    await vi.waitFor(async () => {
      expect(await flow.read()).toMatchObject({
        state: 'building',
        approval: { approvedBy: 'user:admin', approvedAt: 123 },
      })
    })
    await expect(flow.approve('user:other-admin')).rejects.toThrow(/already building/)
    expect(release).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ headSha: 'aaaaaaa' }))

    finish()
    await expect(first).resolves.toBeUndefined()
    expect(release).toHaveBeenCalledOnce()
  })

  it('keeps build logs, approval identity, and the no-rollback explanation on failure', async () => {
    const flow = createReleaseApprovalFlow({
      proposal: async () => BASE,
      release: async (_proposal) => {
        throw new Error('compile exited 1')
      },
      failureLogs: (error) => (error instanceof Error ? error.message : String(error)),
      now: () => 456,
    })

    await expect(flow.approve('user:admin')).resolves.toMatchObject({
      state: 'failed',
      approval: { approvedBy: 'user:admin', approvedAt: 456 },
      failure: {
        message: expect.stringMatching(/nothing was granted.*nothing to roll back/i),
        logs: 'compile exited 1',
      },
    })
  })

  it('shows a newly landed HEAD as the next pending proposal while the old release builds', async () => {
    let current = BASE
    let finish!: () => void
    const building = new Promise<void>((resolve) => {
      finish = resolve
    })
    const flow = createReleaseApprovalFlow({
      proposal: async () => current,
      release: (_proposal) => building,
      failureLogs: String,
    })

    const first = flow.approve('user:admin')
    await vi.waitFor(() => expect(flow.read()).resolves.toMatchObject({ state: 'building' }))
    current = { ...BASE, headSha: 'bbbbbbb', version: '0.1.2-dev.2+bbbbbbb' }
    expect(await flow.read()).toMatchObject({ headSha: 'bbbbbbb', state: 'pending' })
    await expect(flow.approve('user:other-admin')).rejects.toThrow(/already building/)
    finish()
    await first
  })
})
