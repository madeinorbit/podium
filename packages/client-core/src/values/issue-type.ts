import type { IssueId, IssueProjection, IssueGitState, SessionId } from '@podium/model'
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


export type IssueViewModel = Omit<
  IssueProjection,
  'description' | 'notes' | 'worktreePath' | 'branch'
> &
  Omit<IssueView, 'id'> &
  Partial<IssueSessionRollups> & {
    description: string
    notes?: string
    worktreePath: string | null
    branch: string | null
    readAt: string | null
    tuckedAt: string | null
    pinned: boolean
    gitState?: IssueGitState
    repoPath: string
    prefix?: string
    deps: Array<{ id: IssueId; type: string }>
  }
