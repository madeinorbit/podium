import type { ReleaseProposal } from '@podium/protocol'

export class ReleaseApprovalRefusal extends Error {}

export type ReleaseApprovalTarget = Pick<ReleaseProposal, 'headSha' | 'version'>

export function createReleaseApprovalFlow(deps: {
  proposal: () => Promise<ReleaseProposal | undefined>
  release: (proposal: ReleaseProposal) => Promise<void>
  failureLogs: (error: unknown) => string
  now?: () => number
}): {
  read(): Promise<ReleaseProposal | undefined>
  approve(approvedBy: string, expected: ReleaseApprovalTarget): Promise<ReleaseProposal | undefined>
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
    async approve(approvedBy, expected) {
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
        if (base.headSha !== expected.headSha || base.version !== expected.version) {
          throw new ReleaseApprovalRefusal(
            `The development release proposal moved from ${expected.version} (${expected.headSha}) ` +
              `to ${base.version} (${base.headSha}). Review and approve the new proposal.`,
          )
        }
        proposalHead = base.headSha
        approval = { approvedBy, approvedAt: now() }
        failure = undefined
        // Admission is the HTTP mutation's result. A compile must not keep a
        // request (and the client's local pending flag) open for minutes; the
        // existing proposal query owns progress and the eventual failure.
        const release = async (): Promise<void> => {
          try {
            await deps.release(base)
          } catch (error) {
            const logs = deps.failureLogs(error)
            // A later HEAD is a different proposal, never this build's failure.
            if (proposalHead === base.headSha) {
              failure = {
                message:
                  'Building and publishing this development release failed. Nothing was granted, so there is nothing to roll back.',
                logs,
              }
            }
          } finally {
            inFlight = false
          }
        }
        void release().catch((error: unknown) => {
          // Keep even a failure in the diagnostic formatter off the process's
          // unhandled-rejection path. Admission was released in finally.
          if (proposalHead === base.headSha) {
            failure = { message: 'The development release failed.', logs: String(error) }
          }
        })
        return { ...base, state: 'building', approval }
      } catch (error) {
        inFlight = false
        throw error
      }
    },
  }
}
