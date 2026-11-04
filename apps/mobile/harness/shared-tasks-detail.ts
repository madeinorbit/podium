/**
 * Harness-only (POD-6297): the open task's shared half as the server answers
 * it for Bob on Alice's task. Stands in for `src/client/use-issue-shared-detail`.
 * Bob may reassign; Alice has two sessions on it, seen as D13 summaries.
 */
import type { IssueSharedDetail } from '@podium/client-graph/issue-shared-detail'

const DETAIL = {
  allowed: { reassign: true },
  collaboratorIds: ['mem_alice', 'mem_carol'],
  sessionSummaries: [
    { owner: 'mem_alice', title: 'Invite flow copy', state: 'live' },
    { owner: 'mem_alice', title: 'Copy review notes', state: 'idle' },
    { owner: 'mem_bob', title: 'Bob’s own session', state: 'live' },
  ],
} as unknown as IssueSharedDetail

export function useIssueSharedDetail(_issueId: string, active: boolean) {
  return active ? DETAIL : undefined
}
