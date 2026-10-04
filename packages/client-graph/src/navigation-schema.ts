import { MISSION_SUMMARIES } from './mission-schema'

/** Navigation and pruning share addressed identity, membership and activity facts. */
export const NAVIGATION_SUMMARIES = {
  issue: [...MISSION_SUMMARIES.issue, 'id', 'updatedAt', 'worktreePath'],
  session: ['sessionId', 'cwd', 'issueId', 'displayRef', 'lastActiveAt'],
} as const
