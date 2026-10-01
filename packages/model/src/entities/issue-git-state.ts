import { z } from 'zod'
import { IssueIdField } from '../ids'
import { IssueGitState } from './issue-vocabulary'

/** R4 server-maintained git observation (ADR 4 D7.4). Ephemeral: boot removes
 * stale observations and the next completed probe readmits the issue's row. */
export const IssueGitStateProjection = z.object({
  id: IssueIdField,
  ...IssueGitState.shape,
})
export type IssueGitStateProjection = z.infer<typeof IssueGitStateProjection>
