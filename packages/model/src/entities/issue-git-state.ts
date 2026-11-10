import { z } from 'zod'
import { IssueIdField } from '../ids'
import { IssueGitState } from './issue-vocabulary'

/** R4 server-maintained git observation (ADR 4 D7.4), stored across restart.
 * A completed event-driven probe replaces it only when its facts change. */
export const IssueGitStateProjection = z.object({
  id: IssueIdField,
  ...IssueGitState.shape,
})
export type IssueGitStateProjection = z.infer<typeof IssueGitStateProjection>
