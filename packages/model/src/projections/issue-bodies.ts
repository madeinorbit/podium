import type { z } from 'zod'
import { IssueProjection } from './issue-projection'

/**
 * The issue record as the feed carries it: the projection without its body
 * fields, which arrive as `issueBodies` headers and are fetched by id. Command
 * results and the CLI still carry the whole {@link IssueProjection}.
 */
export const SlimIssueProjection = IssueProjection.omit({
  brief: true,
  panel: true,
  description: true,
  activityNotes: true,
  notesUpdatedAt: true,
})
export type SlimIssueProjection = z.infer<typeof SlimIssueProjection>
