import type { SessionView } from '@podium/client-core/session-values'
import type { UnbrandIds } from '@podium/model/browser'
import { DEFAULT_HARNESS_AGENT } from '@podium/model/browser'
import type { IssueViewModel } from '@podium/client-core/react'

type TestIssue = IssueViewModel & { sessions?: SessionView[] }

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
  over: Partial<UnbrandIds<IssueViewModel>> & { sessions?: SessionView[]; draft?: boolean; origin?: 'human' | 'agent'; humanQuestion?: string; humanQuestionOptions?: string[]; humanQuestionAskedBy?: string; humanQuestionAskedAt?: string } = {},
): TestIssue => {
  const { draft, origin, humanQuestion, humanQuestionOptions, humanQuestionAskedBy, humanQuestionAskedAt, ...normalized } = over
  return ({
    id: 'i',
    repoPath: '/r',
    seq: 4,
    title: 'Fix login',
    description: '',
    stage: 'in_progress',
    worktreePath: '/r/wt',
    branch: 'issue/4-fix-login',
    parentBranch: 'main',
    defaultAgent: DEFAULT_HARNESS_AGENT,
    defaultModel: 'auto',
    defaultEffort: 'auto',
    blockedByNotes: [],
    createdAt: 't',
    updatedAt: 't',
    archived: false,
    readAt: null,
    tuckedAt: null,
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
    ...normalized,
    isDraftVessel: normalized.isDraftVessel ?? draft ?? false,
    intentOrigin: normalized.intentOrigin ?? origin ?? 'human',
    asked: normalized.asked ?? (humanQuestion ? { question: humanQuestion, options: humanQuestionOptions,
      by: humanQuestionAskedBy, at: humanQuestionAskedAt } : undefined),
  }) as TestIssue
}
