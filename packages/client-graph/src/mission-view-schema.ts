import type { FieldSpec } from './shared/schema'

/** Relations are declared once in shared/schema.ts: missionSessions for the
 * drawn roster, pageSessions for raw non-shell membership, pageDependencies /
 * pageDependents for every edge, supersedingIssue and canonicalIssue for
 * continuation. Display summaries are registered before ingest by the pane. */

const projection = (optional = false): FieldSpec => ({ type: 'id', optional, nullable: true, source: { schema: 'IssueProjection', arrivesOn: 'replica:issueProjections' } })
export const MISSION_VIEW_ISSUE_FIELDS: Readonly<Record<string, FieldSpec>> = {
  supersededBy: projection(true), duplicateOf: projection(true),
  asked: { type: 'object', optional: true, nullable: true, source: { schema: 'IssueProjection', arrivesOn: 'replica:issueProjections' } },
}
export const MISSION_VIEW_SESSION_FIELDS: Readonly<Record<string, FieldSpec>> = Object.fromEntries([
  ['createdAt', 'isoDate', false], ['name', 'string', true], ['title', 'string', false],
  ['model', 'string', true], ['effort', 'string', true], ['refRepoId', 'id', true],
  ['refIssueId', 'id', true], ['refSeq', 'number', true], ['refLetter', 'string', true],
  ['resumable', 'boolean', true], ['spawnedBy', 'string', true], ['machineId', 'id', true],
].map(([name, type, optional]) => [name, { type, optional, source: { schema: 'SessionMeta', arrivesOn: 'replica:sessions' } }])) as Readonly<Record<string, FieldSpec>>

/** Cold issue rows need only topology/stage facts. Visible prose/detail loads
 * normally; attachment counts use scalar summaries; session display detail loads normally. */
export const MISSION_VIEW_SUMMARIES = {
  issue: ['id', 'parentId', 'archived', 'deletedAt', 'stage', 'closedReason', 'updatedAt',
    // Open menus show these authored fields, never a full history projection.
    'seq', 'title', 'repoId', 'repoPath', 'deps', 'labels', 'priority', 'color', 'pinned',
    'worktreePath', 'deferUntil', 'duplicateOf', 'defaultAgent', 'needsHuman', 'blocked', 'isDraftVessel', 'audience'],
  session: ['sessionId', 'issueId', 'archived', 'headless', 'agentKind', 'lastActiveAt'],
} as const
