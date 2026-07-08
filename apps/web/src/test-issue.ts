import type { IssueWire } from '@podium/protocol'

/**
 * Build a valid `IssueWire` for unit tests, overriding any fields via `over`.
 * Shared by the issue-card and issue-page tests so all exercise the same
 * fully-populated wire shape.
 */
export const makeIssue = (over: Partial<IssueWire> = {}): IssueWire =>
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
    priority: 2,
    type: 'task',
    pinned: false,
    needsHuman: false,
    labels: [],
    deps: [],
    dependents: [],
    commentCount: 0, // #175: bodies left the wire
    ready: true,
    blocked: false,
    deferred: false,
    childCount: 0,
    childDoneCount: 0,
    sessions: [],
    sessionSummary: { total: 2, byPhase: { working: 1, idle: 1 } },
    ...over,
  }) as IssueWire
