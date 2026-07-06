import type { ConversationSummaryWire, GitRepositoryWire, SessionMeta } from '@podium/protocol'

export type PinKind = 'panel' | 'worktree' | 'repo'

export interface PinState {
  panels: string[]
  worktrees: string[]
  repos: string[]
}

/** A worktree as shown in the UI: the repo's own checkout plus each linked worktree. */
export interface WorktreeView {
  path: string
  branch?: string
  repoPath: string
  isMain: boolean
  /** Stable cross-machine repo identity (#74); undefined on older servers. */
  repoId?: string
  /** Which machine this worktree lives on (undefined = single-machine or unknown). */
  machineId?: string
}

export interface RepoView {
  path: string
  name: string
  worktrees: WorktreeView[]
  /** All machines that have this repo, with each machine's local repo path.
   *  Single-machine deployments will always have exactly one entry. */
  machines: { machineId: string; path: string }[]
  /** Normalized origin URL used as the cross-machine identity key.
   *  Undefined for repos without a git remote. */
  originUrl?: string
  /** Stable cross-machine repo identity (#74); undefined on older servers. */
  repoId?: string
}

export type { ConversationSummaryWire, GitRepositoryWire, SessionMeta }
