/** Navigation value types shared with the product. Legacy list construction lives in tests/worklist/legacy-values. */
import type { SessionView } from '../../../session-values'
import type { RepoId, MachineId } from '@podium/model'
import type { SessionOwnershipIndex } from '../../session-ownership'
import type { PinState, WorktreeView } from '../../types'
import type { IssueNavigationModel } from '../issues'

export interface WorktreeNavView extends WorktreeView {
  repoName: string
  sessions: SessionView[]
  /** Non-archived issues whose worktree this is. When non-empty, the sidebar
   *  renders the issue block(s) instead of the bare worktree row. */
  issues: IssueNavigationModel[]
}

export interface RepoNavView {
  path: string
  name: string
  worktrees: WorktreeNavView[]
  machines?: { machineId: MachineId; path: string }[]
  originUrl?: string
  repoId?: RepoId
}

export interface SidebarSections {
  /** Shared ownership work for this exact repo/session/issue snapshot. */
  sessionOwnership?: SessionOwnershipIndex
  pinnedWorktrees: WorktreeNavView[]
  pinnedRepos: RepoNavView[]
  repos: RepoNavView[]
}

export const EMPTY_PINS: PinState = { panels: [], worktrees: [], repos: [] }
