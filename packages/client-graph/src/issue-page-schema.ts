import type { FieldSpec } from './shared/schema'
import type { ReferentExit } from '@podium/client-core/viewmodels'

export interface IssuePageSourceRows { issueExit: { kind: ReferentExit | undefined } }
declare module './source-registry' { interface PoolSourceRows extends IssuePageSourceRows {} }
export const ISSUE_PAGE_SOURCE_SCHEMA = {
  issueExit: { key: 'issueId', source: 'replica:exitKind(issueProjection,issueId)', fields: ['kind'], residency: 'borrowed-summary' },
} as const

const field = (type: FieldSpec['type'], optional = true): FieldSpec => ({
  type, optional, source: { schema: 'IssueProjection', arrivesOn: 'replica:issueProjections' },
})

/** Durable page values retain the canonical projection spellings. Documents
 * stay on the full row; menus need only the explicitly declared small summary. */
export const ISSUE_PAGE_FIELDS = {
  type: field('string', false), labels: field('object', false),
  brief: field('string'), design: field('string'), acceptance: field('string'),
  notes: field('object'), dependencyNote: field('string'),
  suggestedStage: field('string'), suggestedReason: field('string'),
  estimateMin: field('number'), dueAt: field('isoDate'),
  parentBranch: field('string', false), color: field('string'),
  intentOrigin: field('string', false), asked: field('object'),
  supersededBy: field('id'), duplicateOf: field('id'),
  linearIdentifier: field('string'), linearUrl: field('string'),
  owner: field('id', false), createdBy: field('object', false),
  lastLifecycleActor: field('object'),
} as const

const seatField = (type: FieldSpec['type'], property?: string): FieldSpec => ({
  type, optional: true, source: { schema: 'SessionMeta', arrivesOn: 'replica:sessions', ...(property ? { property } : {}) },
})
export const ISSUE_PAGE_SESSION_FIELDS = {
  name: { ...seatField('string'), nullable: true }, title: seatField('string'),
  createdAt: seatField('isoDate'), stopReason: seatField('string'),
  handoffTarget: { ...seatField('string', 'handoffTargetMachineId'), note: 'The existing session-values join supplies the target machine name.' },
  createdBy: seatField('object'), machineId: seatField('id'),
  agentColor: seatField('string'),
  displayRef: { ...seatField('string', 'refSeq'), note: 'The existing session-values join formats the birth reference with its repo prefix.' },
  resumable: seatField('boolean'),
} as const

export const ISSUE_PAGE_SUMMARIES = {
  issue: ['seq', 'title', 'labels', 'assignee', 'repoId', 'repoPath', 'stage',
    'parentId', 'archived', 'deletedAt', 'closedReason', 'owner', 'createdBy', 'deps', 'worktreePath',
    'blocked', 'blockedByNotes', 'needsHuman', 'color', 'isDraftVessel', 'audience', 'updatedAt', 'deferUntil', 'supersededBy', 'duplicateOf'],
  session: ['sessionId', 'refIssueId', 'issueId', 'agentKind', 'headless', 'archived', 'status',
    'lastActiveAt', 'name', 'title', 'resume', 'agentState', 'offer', 'handoffTarget', 'stoppedAt'],
} as const
