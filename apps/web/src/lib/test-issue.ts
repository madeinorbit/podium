import type { IssueViewModel } from '@podium/client-core/react'

/**
 * Build a valid normalized IssueViewModel for unit tests, overriding any fields via `over`.
 * Shared by the issue-card and issue-page tests so all exercise the same
 * fully-populated render shape.
 */
export const makeIssue = (
  over: Partial<IssueViewModel> = {},
): IssueViewModel =>
  ({
    id: 'i',
    repoPath: '/r',
    seq: 4,
    title: 'Fix login',
    description: '',
    stage: 'in_progress',
    worktreePath: '/r/wt',
    branch: 'issue/4-fix-login',
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    blockedBy: [],
    createdAt: 't',
    updatedAt: 't',
    archived: false,
    origin: 'human',
    audience: 'human',
    priority: 2,
    type: 'task',
    pinned: false,
    needsHuman: false,
    labels: [],
    deps: [],
    dependents: [],
    ready: true,
    blocked: false,
    deferred: false,
    childCount: 0,
    childDoneCount: 0,
    memberSessionIds: [],
    sessionSummary: { total: 0, byPhase: {} },
    ...over,
  }) as IssueViewModel
