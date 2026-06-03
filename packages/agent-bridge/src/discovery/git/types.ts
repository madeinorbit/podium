export type GitRepositoryKind = 'repository' | 'worktree' | 'bare'

export type GitRepositorySummary = {
  path: string
  kind: GitRepositoryKind
  gitDir: string
  commonGitDir: string
  mainWorktreePath?: string
  branch?: string
  headSha?: string
  originUrl?: string
  worktrees?: GitWorktreeSummary[]
}

export type GitWorktreeSummary = {
  path: string
  gitDir: string
  commonGitDir: string
  branch?: string
  headSha?: string
  locked?: boolean
  prunable?: boolean
}

export type GitDiscoveryDiagnostic = {
  severity: 'warning' | 'error'
  path: string
  message: string
  cause?: unknown
}

export type ScanGitRepositoriesOptions = {
  roots?: readonly string[]
  homeDir?: string
  includeHome?: boolean
  maxDepth?: number
  concurrency?: number
  ignoredDirectoryNames?: readonly string[]
}

export type ScanGitRepositoriesAtPathOptions = {
  homeDir?: string
  maxDepth?: number
  concurrency?: number
  ignoredDirectoryNames?: readonly string[]
}

export type ScanGitRepositoriesResult = {
  repositories: GitRepositorySummary[]
  diagnostics: GitDiscoveryDiagnostic[]
}

export type FindGitWorktreesResult = {
  repository: GitRepositorySummary
  worktrees: GitWorktreeSummary[]
  diagnostics: GitDiscoveryDiagnostic[]
}
