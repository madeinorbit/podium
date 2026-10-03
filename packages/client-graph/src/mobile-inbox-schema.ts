import { ISSUE_PAGE_SUMMARIES } from './issue-page-schema'

/** Phone inbox, screening and address readers reuse the core issue/session
 * relations and header window/health source. No second row or mutation owner. */
export interface MobileInboxRows {
  mobileInboxState: { hasCursor: boolean }
  mobileReferencePrefixes: { prefixes: readonly string[] }
}
declare module './source-registry' { interface PoolSourceRows extends MobileInboxRows {} }
export const MOBILE_INBOX_SOURCE_KEY = 'mobile-inbox'
export const MOBILE_INBOX_VIEW_KEY = 'mobile-inbox-views'
export const MOBILE_INBOX_ENTITIES = ['mobileInboxState', 'mobileReferencePrefixes'] as const
export const MOBILE_INBOX_SCHEMA = {
  mobileInboxState: { key: 'state', source: 'replica:cursor', fields: ['hasCursor'], residency: 'on-demand' },
  mobileReferencePrefixes: { key: 'prefixes', source: 'pool:repo.issues', fields: ['prefixes'], residency: 'summary' },
  session: { source: 'pool:session', relations: ['pageIssue', 'bornIssue'],
    summary: [...ISSUE_PAGE_SUMMARIES.session, 'createdAt', 'draftUpdatedAt', 'snoozedUntil', 'cwd',
      'busy', 'agentColor', 'queuedMessageCount', 'refRepoId', 'refSeq', 'refLetter', 'refDraft', 'displayRef'] },
  issue: { source: 'pool:issue', relations: ['repo', 'treeParent', 'treeChildren', 'pageSessions'],
    summary: [...ISSUE_PAGE_SUMMARIES.issue, 'priority'] },
  window: { source: 'pool:window', fields: ['outboxSize'] },
  health: { source: 'pool:header', entities: ['machine', 'hostMetric'] },
} as const
export const MOBILE_INBOX_SUMMARIES = {
  issue: MOBILE_INBOX_SCHEMA.issue.summary,
  session: MOBILE_INBOX_SCHEMA.session.summary,
}
