import type { ConversationSummaryWire, GitRepositoryWire, SessionMeta } from '@podium/protocol'

/** A worktree as shown in the UI: the repo's own checkout plus each linked worktree. */
export interface WorktreeView {
  path: string
  branch?: string
  repoPath: string
  isMain: boolean
}

export interface RepoView {
  path: string
  name: string
  worktrees: WorktreeView[]
}

export type { ConversationSummaryWire, GitRepositoryWire, SessionMeta }
