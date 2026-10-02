/** Mission topology is independent of sidebar visibility and draft occupancy.
 * The core relation engine maintains every edge, including its cold summary.
 * No mission owns a second relation index or copies issue/session rows. */
export const MISSION_SCHEMA = {
  root: {
    parent: 'treeParent',
    summary: ['parentId', 'archived', 'deletedAt', 'stage'],
    source: 'missionRootFor: stop before an archived, deleted or absent ancestor',
  },
  members: {
    children: 'children',
    sessions: 'missionSessions',
    started: 'missionStartedIssues',
    source: 'missionIssueIds: formal closure, then provenance closure without grafted descendants',
  },
} as const

/** Only scalar root facts are needed outside declared relationship summaries.
 * Register before ingest. Missing cold facts use the ordinary load window. */
export const MISSION_SUMMARIES = { issue: MISSION_SCHEMA.root.summary } as const
