import type { EdgeSpec, FieldSpec, RelationSpec } from './shared/schema'

/** The pane's declarations extend the core graph, never maintain an ownership
 * index. Display summaries are registered before ingest by the pane screen. */
export const MISSION_VIEW_DEPS = [
  ['discovered-from', 'viewOrigins', 'viewDiscoveries'],
  ['blocks', 'viewPrerequisites', 'viewWaitingIssues'],
  ['related', 'viewRelated', 'viewRelatedFrom'],
  ['tracks', 'viewTracks', 'viewTrackedBy'],
  ['supersedes', 'viewSupersedes', 'viewSupersededFrom'],
  ['caused-by', 'viewCauses', 'viewCausedIssues'],
  ['validates', 'viewValidates', 'viewValidatedBy'],
  ['parent-child', 'viewHierarchyDeps', 'viewHierarchyDependents'],
] as const

export const MISSION_VIEW_RELATIONS: Readonly<Record<string, RelationSpec>> = {
  viewMemberSessions: { kind: 'hasMany', to: 'session', inverse: 'viewMemberIssue', lazy: true,
    why: 'Replica issue payloads retain raw non-shell resume twins; the drawn roster uses missionSessions.' },
  viewSupersededBy: { kind: 'belongsTo', to: 'issue', foreignKey: 'supersededBy', targetKey: 'id', inverse: 'viewReplaces', lazy: true, why: 'FlightDeck continuation targets (mission.ts issueContinuation).' },
  viewReplaces: { kind: 'hasMany', to: 'issue', inverse: 'viewSupersededBy', lazy: true, why: 'Inverse continuation edge.' },
  viewDuplicateOf: { kind: 'belongsTo', to: 'issue', foreignKey: 'duplicateOf', targetKey: 'id', inverse: 'viewDuplicates', lazy: true, why: 'FlightDeck duplicate continuation targets.' },
  viewDuplicates: { kind: 'hasMany', to: 'issue', inverse: 'viewDuplicateOf', lazy: true, why: 'Inverse duplicate edge.' },
  ...Object.fromEntries(MISSION_VIEW_DEPS.flatMap(([type, out, incoming]) => {
    const edge = (direction: 'out' | 'in', inverse: string): EdgeSpec => ({
      kind: 'edge', to: 'issue', edgeField: 'deps', edgeIdKey: 'id', edgeTypeKey: 'type',
      edgeType: type, many: true, direction, inverse, lazy: true,
      why: 'Addressed mission notes, handoff prerequisites and dependent counts; inverse maintained by the core relation engine.',
    })
    return [[out, edge('out', incoming)], [incoming, edge('in', out)]]
  })),
}

export const MISSION_VIEW_SESSION_RELATIONS: Readonly<Record<string, RelationSpec>> = {
  viewMemberIssue: { kind: 'belongsTo', to: 'issue', foreignKey: 'issueId', targetKey: 'id',
    inverse: 'viewMemberSessions', lazy: true, uncollapsed: true,
    where: { fields: ['agentKind'], test: row => row['agentKind'] !== 'shell', why: 'Replica issue membership excludes shells only.' },
    why: 'Raw issue membership and unread rollups include headless, archived and resume-twin rows.' },
}

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
  issue: ['id', 'parentId', 'archived', 'deletedAt', 'stage', 'closedReason', 'updatedAt'],
  session: ['sessionId', 'issueId', 'archived', 'headless', 'agentKind', 'lastActiveAt'],
} as const
