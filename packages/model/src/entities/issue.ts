/** On-demand graph and diagnostic projections over issues. */
import { z } from 'zod'
import {
  IssueDerived,
  IssueIdentity,
  IssueLifecycle,
  IssueText,
  IssueTriage,
} from '../fields/issue'
import { IssueIdField, UserIdField } from '../ids'
import { IssueStage, IssueType } from './issue-vocabulary'

export * from './issue-vocabulary'

export const DuplicateCandidate = z.object({
  a: IssueIdentity.shape.id,
  b: IssueIdentity.shape.id,
  score: z.number(),
})
export type DuplicateCandidate = z.infer<typeof DuplicateCandidate>

const IssueRefHead = IssueIdentity.pick({ id: true, seq: true }).extend({
  title: IssueText.shape.title,
})

export const LintFinding = IssueRefHead.omit({ title: true }).extend({
  findings: z.array(z.string()),
})
export type LintFinding = z.infer<typeof LintFinding>

export const DoctorReport = z.object({
  /** Cycles and dangling edges are lists of ISSUE IDS; composed, not restated
   *  (POD-362). `type` stays a free string — it is a dep KIND, not an id. */
  cycles: z.array(z.array(IssueIdentity.shape.id)),
  danglingDeps: z.array(
    z.object({
      from: IssueIdentity.shape.id,
      to: IssueIdentity.shape.id,
      type: z.string(),
    }),
  ),
  lintCount: z.number().int(),
  staleCount: z.number().int(),
})
export type DoctorReport = z.infer<typeof DoctorReport>

export const IssueGraphNode = IssueRefHead.extend({
  stage: IssueLifecycle.shape.stage,
  priority: IssueTriage.shape.priority,
  type: IssueTriage.shape.type,
  ready: IssueDerived.shape.ready.unwrap(),
  blocked: IssueDerived.shape.blocked.unwrap(),
})
/** Endpoints are ISSUE IDS and compose the shared instance (POD-362). `type` is
 *  a dep kind, not an id, and stays a free string. */
export const IssueGraphEdge = z.object({
  from: IssueIdentity.shape.id,
  to: IssueIdentity.shape.id,
  type: z.string(),
})
export const IssueGraph = z.object({
  nodes: z.array(IssueGraphNode),
  edges: z.array(IssueGraphEdge),
})
export type IssueGraph = z.infer<typeof IssueGraph>

export const EpicStatus = IssueRefHead.pick({ id: true })
  .extend({
    childCount: IssueDerived.shape.childCount.unwrap(),
    childDoneCount: IssueDerived.shape.childDoneCount.unwrap(),
  })
  .extend({ complete: z.boolean() })
export type EpicStatus = z.infer<typeof EpicStatus>

export const IssueCount = z.object({
  byStage: z.record(z.number()),
  byPriority: z.record(z.number()),
  byType: z.record(z.number()),
  byAssignee: z.record(z.number()),
})
export type IssueCount = z.infer<typeof IssueCount>
export const IssueStats = z.object({
  total: z.number().int(),
  open: z.number().int(),
  closed: z.number().int(),
  ready: z.number().int(),
  blocked: z.number().int(),
  deferred: z.number().int(),
})
export type IssueStats = z.infer<typeof IssueStats>
export const OrphanIssue = IssueRefHead.extend({
  ref: z.string(),
})
export type OrphanIssue = z.infer<typeof OrphanIssue>
export const IssueSearchFilter = z.object({
  repoPath: z.string().optional(),
  text: z.string().optional(),
  status: z.enum(['open', 'closed', 'ready', 'blocked', 'deferred']).optional(),
  stage: IssueStage.optional(),
  priority: z.number().int().optional(),
  type: IssueType.optional(),
  assignee: UserIdField.optional(),
  label: z.string().optional(),
  parentId: IssueIdField.optional(),
})
export type IssueSearchFilter = z.infer<typeof IssueSearchFilter>
