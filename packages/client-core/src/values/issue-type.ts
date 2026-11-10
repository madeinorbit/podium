import type {
  IssueBodyField,
  IssueBodyHeaders,
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


/** An issue as the pool shows it. Brief and description use body headers;
 * panel items and the state paragraph join their own shared records. */
export type IssueViewModel = Omit<SlimIssueProjection, 'worktreePath' | 'branch'> &
  Omit<IssueView, 'id'> &
  Partial<IssueSessionRollups> & {
    bodies?: IssueBodyHeaders
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
 * An issue's bodies as a row may carry them (POD-6767): never on a synced
 * record, only painted by the client itself: an optimistic create or edit the
 * log has not settled, a demo, a test fixture. `IssueModel` prefers a painted
 * value over the fetched body.
 */
export type IssueBodyValues = {
  brief?: string
  panel?: IssuePanel
  activityNotes?: string
  description?: string
}

/**
 * An issue's bodies as a screen reads them (POD-6767). `IssueModel` answers
 * them from the bodies it fetched by id; a painted row (a fixture, a demo)
 * carries them itself and is never loading. While a body is fetched the field
 * reads absent (or its previous text, when the body moved); a form that edits
 * one waits for `bodyLoading(field)` to clear, so it never starts from a stale
 * or empty text.
 */
export type IssueBodyFields = {
  readonly brief?: string | undefined
  readonly panel?: IssuePanel | undefined
  readonly activityNotes?: string | undefined
  readonly notesUpdatedAt?: string | undefined
  /** The human summary's text; empty while it first loads or when there is none. */
  readonly description: string
  /** Absent on a painted row, which holds its bodies. */
  bodyLoading?(field: IssueBodyField): boolean
}

/** An issue a screen shows with its bodies: `IssueModel` and `PageIssue` are one. */
export type IssueWithBodies = IssueViewModel & IssueBodyFields

/** Is this issue's `field` still on its way? A painted row never is. */
export function issueBodyLoading(issue: Pick<IssueBodyFields, 'bodyLoading'>, field: IssueBodyField): boolean {
  return issue.bodyLoading?.(field) ?? false
}
