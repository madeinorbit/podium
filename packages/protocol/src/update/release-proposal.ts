import { z } from 'zod'

/** One commit included in the collapsing development-release proposal. */
export const ReleaseProposalCommit = z
  .object({
    sha: z.string().min(1),
    summary: z.string(),
  })
  .passthrough()
export type ReleaseProposalCommit = z.infer<typeof ReleaseProposalCommit>

/** The authenticated admin whose click admitted the build and publication. */
export const ReleaseProposalApproval = z
  .object({
    approvedBy: z.string().min(1),
    approvedAt: z.number(),
  })
  .passthrough()
export type ReleaseProposalApproval = z.infer<typeof ReleaseProposalApproval>

/** A build failed before a release was handed to the ordinary update path. */
export const ReleaseProposalFailure = z
  .object({
    message: z.string().min(1),
    logs: z.string().min(1),
  })
  .passthrough()
export type ReleaseProposalFailure = z.infer<typeof ReleaseProposalFailure>

/**
 * The source publisher's one collapsing pre-release fact.
 *
 * It is deliberately not an UpdateTarget: approving it consents only to build
 * and publish. The ordinary feed-backed UpdateTarget appears afterwards and
 * receives the separate rollout consent used on every channel.
 */
export const ReleaseProposal = z
  .object({
    headSha: z.string().min(1),
    version: z.string().min(1),
    branch: z.string().min(1),
    /** Version captured from the server process that would build this proposal. */
    runningVersion: z.string().min(1).optional(),
    commits: z.array(ReleaseProposalCommit),
    addedMigrations: z.array(z.string()),
    state: z.enum(['pending', 'building', 'failed']),
    approval: ReleaseProposalApproval.optional(),
    failure: ReleaseProposalFailure.optional(),
  })
  .passthrough()
export type ReleaseProposal = z.infer<typeof ReleaseProposal>
