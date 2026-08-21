import { asUserId } from '@podium/model'
import type { ReleaseProposal } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from '../../command-principal'
import type { Context } from '../../trpc'
import { ReleaseApprovalRefusal } from './release-approval'
import { approveReleaseProposal, releaseProposalFor } from './trpc'

const PROPOSAL: ReleaseProposal = {
  headSha: 'abcdef1',
  version: '0.1.2-dev.7+abcdef1',
  branch: 'main',
  commits: [{ sha: 'abcdef1', summary: 'Release proposal' }],
  addedMigrations: [],
  state: 'pending',
}
const TARGET = { headSha: PROPOSAL.headSha, version: PROPOSAL.version }

function context(
  role: 'admin' | 'member',
  extra: Pick<Context, 'releaseProposal' | 'approveReleaseProposal'> = {},
): Context {
  const principal = userCommandPrincipal(asUserId(`user:${role}`), role)
  return { principal, capability: principal.capability, ...extra } as Context
}

describe('development release proposal authorization', () => {
  it('hides the proposal from a non-admin without touching the publisher', async () => {
    const read = vi.fn(async () => PROPOSAL)
    expect(await releaseProposalFor(context('member', { releaseProposal: read }))).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses non-admin approval before the publisher can build', async () => {
    const approve = vi.fn(async () => undefined)
    await expect(
      approveReleaseProposal(context('member', { approveReleaseProposal: approve }), TARGET),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(approve).not.toHaveBeenCalled()
  })

  it('records the authenticated admin actor on approval', async () => {
    const approve = vi.fn(async () => undefined)
    await approveReleaseProposal(context('admin', { approveReleaseProposal: approve }), TARGET)
    expect(approve).toHaveBeenCalledWith('user:admin', TARGET)
  })

  it('returns proposal movement as a clean precondition refusal', async () => {
    const approve = vi.fn(async () => {
      throw new ReleaseApprovalRefusal('The development release proposal moved. Review it again.')
    })
    await expect(
      approveReleaseProposal(context('admin', { approveReleaseProposal: approve }), TARGET),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/proposal moved/i),
    })
  })
})
