import type { SessionMeta, UnbrandIds } from '@podium/model'
import type { IssueViewModel } from '@podium/client-core/react'

type TestIssue = IssueViewModel & { sessions?: SessionMeta[] }

/**
 * Build a valid normalized IssueViewModel for unit tests, overriding any fields via `over`.
 * Shared by the issue-card and issue-page tests so all exercise the same
 * fully-populated render shape.
 */
export const makeIssue = (
  // UNBRANDED on the input side: the fixtures below are built from string
  // literals, and `UnbrandIds` is the alias model publishes for exactly that
  // construction site (`entities/wire-input.ts`) — a per-field `asIssueId` in
  // every test would be noise, and a plain `Partial<IssueViewModel>` would not
  // accept `id: 'i'` at all.
  over: Partial<UnbrandIds<IssueViewModel>> & { sessions?: SessionMeta[] } = {},
): TestIssue =>
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
    blockedByNotes: [],
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
  }) as TestIssue
