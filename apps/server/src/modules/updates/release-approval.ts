import type { ReleaseProposal } from '@podium/protocol'
import { BuildTimeoutError, createBuildAttempt } from './build-attempt'

export class ReleaseApprovalRefusal extends Error {}

export type ReleaseApprovalTarget = Pick<ReleaseProposal, 'headSha' | 'version'>

export function createReleaseApprovalFlow(deps: {
  proposal: () => Promise<ReleaseProposal | undefined>
  release: (proposal: ReleaseProposal) => Promise<void>
  failureLogs: (error: unknown) => string
  now?: () => number
  buildTimeoutMs?: number
}): {
  read(): Promise<ReleaseProposal | undefined>
  approve(approvedBy: string, expected: ReleaseApprovalTarget): Promise<ReleaseProposal | undefined>
} {
  let inFlight = false
  let activeProposal: ReleaseProposal | undefined
  let proposalHead: string | undefined
  let approval: ReleaseProposal['approval'] | undefined
  let failedProposal: ReleaseProposal | undefined
  const now = deps.now ?? Date.now

  const read = async (): Promise<ReleaseProposal | undefined> => {
    // A refreshed client must see the build actually holding admission, even
    // when HEAD has advanced to another proposal while it was compiling.
    if (inFlight && activeProposal) return activeProposal
    const base = await deps.proposal()
    if (inFlight && activeProposal) return activeProposal
    if (!base) return failedProposal
    if (proposalHead !== base.headSha) {
      proposalHead = base.headSha
      approval = undefined
      failedProposal = undefined
    }
    const failure = failedProposal?.failure
    return {
      ...base,
      state: failure ? 'failed' : 'pending',
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
      const attempt = createBuildAttempt(deps.buildTimeoutMs)
      try {
        const base = await attempt.run(async () => (await deps.proposal()) ?? failedProposal)
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
        failedProposal = undefined
        activeProposal = { ...base, state: 'building', approval }
        // Admission is the HTTP mutation's result. A compile must not keep a
        // request (and the client's local pending flag) open for minutes; the
        // existing proposal query owns progress and the eventual failure.
        const release = async (): Promise<void> => {
          try {
            await attempt.run(() => deps.release(base))
          } catch (error) {
            const logs = deps.failureLogs(error)
            // A later HEAD is a different proposal, never this build's failure.
            if (proposalHead === base.headSha) {
              failedProposal = {
                ...base,
                state: 'failed',
                approval,
                failure: {
                  message:
                    error instanceof BuildTimeoutError
                      ? 'The build exceeded its overall time limit. You can try building again.'
                      : 'Building and publishing this development release failed. Nothing was granted, so there is nothing to roll back.',
                  logs,
                },
              }
            }
          } finally {
            attempt.dispose()
            activeProposal = undefined
            inFlight = false
          }
        }
        void release().catch((error: unknown) => {
          // Keep even a failure in the diagnostic formatter off the process's
          // unhandled-rejection path. Admission was released in finally.
          if (proposalHead === base.headSha) {
            failedProposal = {
              ...base,
              state: 'failed',
              approval,
              failure: { message: 'The development release failed.', logs: String(error) },
            }
          }
        })
        return activeProposal
      } catch (error) {
        attempt.dispose()
        activeProposal = undefined
        inFlight = false
        throw error
      }
    },
  }
}
