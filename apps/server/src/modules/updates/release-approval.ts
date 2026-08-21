import type { ReleaseProposal } from '@podium/protocol'

export class ReleaseApprovalRefusal extends Error {}

export function createReleaseApprovalFlow(deps: {
  proposal: () => Promise<ReleaseProposal | undefined>
  release: (proposal: ReleaseProposal) => Promise<void>
  failureLogs: (error: unknown) => string
  now?: () => number
}): {
  read(): Promise<ReleaseProposal | undefined>
  approve(approvedBy: string): Promise<ReleaseProposal | undefined>
} {
  let inFlight = false
  let proposalHead: string | undefined
  let approval: ReleaseProposal['approval'] | undefined
  let failure: ReleaseProposal['failure'] | undefined
  const now = deps.now ?? Date.now

  const read = async (): Promise<ReleaseProposal | undefined> => {
    const base = await deps.proposal()
    if (!base) return undefined
    if (proposalHead !== base.headSha) {
      proposalHead = base.headSha
      approval = undefined
      failure = undefined
    }
    return {
      ...base,
      state: failure ? 'failed' : inFlight && approval ? 'building' : 'pending',
      ...(approval ? { approval } : {}),
      ...(failure ? { failure } : {}),
    }
  }

  return {
    read,
    async approve(approvedBy) {
      // Set before the first await: two tabs arriving in one turn cannot both
      // pass admission while proposal/git reads are still outstanding.
      if (inFlight) {
        throw new ReleaseApprovalRefusal(
          'A development release is already building. Wait for it to finish before approving again.',
        )
      }
      inFlight = true
      try {
        const base = await deps.proposal()
        if (!base) {
          throw new ReleaseApprovalRefusal('There is no development release proposal to approve.')
        }
        proposalHead = base.headSha
        approval = { approvedBy, approvedAt: now() }
        failure = undefined
        await deps.release(base)
        return read()
      } catch (error) {
        if (error instanceof ReleaseApprovalRefusal) throw error
        failure = {
          message:
            'Building and publishing this development release failed. Nothing was granted, so there is nothing to roll back.',
          logs: deps.failureLogs(error),
        }
        return read()
      } finally {
        inFlight = false
      }
    },
  }
}
