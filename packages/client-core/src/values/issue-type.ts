import type {
  IssueGitState,
  IssueId,
  IssuePanel,
  SessionId,
  SlimIssueProjection,
} from '@podium/model'
export interface IssueView {
  id: string

  memberSessionIds: SessionId[]

  displayRef: string

  childIds: IssueId[]
  childCount: number
  childDoneCount: number

  blocked: boolean

  ready: boolean

  deferred: boolean

  dependents: Array<{ id: IssueId; type: string }>
}


export interface IssueSessionRollups {
  unread: boolean
  sessionSummary: { total: number; byPhase: Record<string, number> }
}


/** An issue as the pool shows it. Brief, description, panel items and the
 * state paragraph join their own synced records (POD-6921). */
export type IssueViewModel = Omit<SlimIssueProjection, 'worktreePath' | 'branch'> &
  Omit<IssueView, 'id'> &
  Partial<IssueSessionRollups> & {
    panel?: IssuePanel
    activityNotes?: string
    notesUpdatedAt?: string
    worktreePath: string | null
    branch: string | null
    readAt: string | null
    tuckedAt: string | null
    pinned: boolean
    gitState?: IssueGitState
    repoPath: string
    /** The repo's server-decided name (`repo.name`, POD-6246). Read it through `issueRepoName`. */
    repoName?: string
    prefix?: string
    deps: Array<{ id: IssueId; type: string }>
  }

/**
 * An issue's bodies as a row may carry them: never on a synced record, only
 * painted by the client itself (an optimistic create or edit the log has not
 * settled, a demo, a test fixture). `IssueModel` prefers a painted value over
 * the synced `issueBrief` / `issueDescription` records.
 */
export type IssueBodyValues = {
  brief?: string
  panel?: IssuePanel
  activityNotes?: string
  description?: string
}

/**
 * An issue's bodies as a screen reads them (POD-6921). `IssueModel` answers
 * them from the issue's synced body and panel records, which load at start
 * with everything else; a painted row (a fixture, a demo) carries them itself.
 */
export type IssueBodyFields = {
  readonly brief?: string | undefined
  readonly panel?: IssuePanel | undefined
  readonly activityNotes?: string | undefined
  readonly notesUpdatedAt?: string | undefined
  /** The human summary's text; empty when there is none. */
  readonly description: string
}

/** An issue a screen shows with its bodies: `IssueModel` and `PageIssue` are one. */
export type IssueWithBodies = IssueViewModel & IssueBodyFields
