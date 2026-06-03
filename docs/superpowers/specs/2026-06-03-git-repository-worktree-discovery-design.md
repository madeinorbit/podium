# Git Repository And Worktree Discovery Design

## Context

Podium will later show users local repositories and Git worktrees they may want
to work on. Discovery runs in the local daemon and belongs in
`@podium/agent-bridge`, alongside the existing conversation and project discovery
code.

The first implementation should be efficient enough for automatic discovery on a
developer machine without requiring a full filesystem crawl. The default broad
scan should start from the user's home directory and prune directories that are
usually expensive, noisy, or irrelevant.

## Goals

- Discover Git repositories and linked worktrees under a scan root.
- Provide a default automatic scan over the user's home directory.
- Provide a path-scoped scan for callers that already know where to search.
- Provide a direct repo-scoped API that returns all worktrees registered for one
  concrete repository.
- Avoid requiring the `git` CLI for the normal discovery path.
- Return diagnostics for unreadable paths or malformed Git metadata instead of
  failing the whole scan.

## Non-Goals

- No UI changes in this phase.
- No persisted repository index in this phase.
- No cloud or remote repository discovery.
- No exhaustive root-volume crawl by default.
- No repository health checks beyond metadata needed for discovery.

## Public API

The library will be added under `packages/agent-bridge/src/discovery/git/` and
re-exported through the existing `@podium/agent-bridge` discovery exports.

```ts
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

export type ScanGitRepositoriesResult = {
  repositories: GitRepositorySummary[]
  diagnostics: GitDiscoveryDiagnostic[]
}

export function scanGitRepositories(options?: {
  roots?: readonly string[]
  homeDir?: string
  includeHome?: boolean
  maxDepth?: number
  concurrency?: number
  ignoredDirectoryNames?: readonly string[]
}): Promise<ScanGitRepositoriesResult>

export function scanGitRepositoriesAtPath(
  path: string,
  options?: {
    homeDir?: string
    maxDepth?: number
    concurrency?: number
    ignoredDirectoryNames?: readonly string[]
  },
): Promise<ScanGitRepositoriesResult>

export function findGitWorktrees(repoPath: string): Promise<{
  repository: GitRepositorySummary
  worktrees: GitWorktreeSummary[]
  diagnostics: GitDiscoveryDiagnostic[]
}>
```

## Discovery Behavior

`scanGitRepositories()` defaults to `includeHome: true` and uses
`homeDir ?? process.env.HOME ?? process.cwd()` as the automatic root. Callers may
pass additional `roots`; duplicate physical roots are canonicalized and scanned
once.

`scanGitRepositoriesAtPath(path)` scans exactly the supplied path as a root. It is
the reusable building block for directed scans, import flows, and tests.

The filesystem scanner walks directories in deterministic order with bounded
concurrency. It prunes known-expensive directories before descent:

- `.git`
- `.hg`
- `.svn`
- `node_modules`
- `.cache`
- `.npm`
- `.pnpm-store`
- `.yarn`
- `dist`
- `build`
- `target`
- `vendor`
- `Library`
- `Applications`
- `Pictures`
- `Music`
- `Movies`

Callers can override or extend the ignored directory names through options. The
scanner also stops descending into a working tree after it has identified that
directory as a Git repository or linked worktree, because nested directories are
usually project contents rather than independent roots. Explicit nested scans are
still possible by passing that nested path directly.

## Git Metadata Parsing

The scanner detects three common forms:

- Normal repository: `.git` is a directory inside the working tree.
- Linked worktree: `.git` is a file with a `gitdir: <path>` pointer.
- Bare repository: the scanned directory itself contains Git admin files such as
  `HEAD`, `objects`, and `refs`.

For each candidate, direct metadata parsing resolves:

- `gitDir`
- `commonGitDir`
- `HEAD` branch or detached SHA
- `config` remote `origin.url` when present
- registered worktrees under `<commonGitDir>/worktrees`

Relative paths in Git pointer files are resolved relative to the file that
contains them. Malformed pointer files, missing admin directories, unreadable
metadata, and missing linked worktrees produce diagnostics and do not abort the
entire scan.

## Worktree Lookup

`findGitWorktrees(repoPath)` starts from one concrete repository path. It resolves
that path's Git admin directory and common Git directory, then reads
`<commonGitDir>/worktrees/*` metadata to return all linked worktrees registered
for the repository. This function does not recursively scan the disk.

The main worktree is included as `repository`. Linked worktrees are returned in
`worktrees`, sorted by path. If the supplied path is itself a linked worktree, the
function still resolves the shared common Git directory and returns siblings from
that shared repository.

## Result Ordering And Dedupe

Repository summaries are sorted by path for deterministic output. Candidates are
deduped by canonical `commonGitDir` plus working-tree path, so the same physical
path found through symlinked scan roots is returned once while separate
worktrees for the same repository remain visible.

When a repository and its registered worktrees are all visible during a scan, the
top-level repository summary may include a `worktrees` list, but each discovered
worktree remains represented as its own summary. This keeps the broad scan useful
for a picker while preserving grouping metadata for later UI.

## Error Handling

The broad scan is best-effort. Permission errors, disappearing files, malformed
Git files, and unreadable repository metadata become diagnostics. The API only
throws for programming errors outside normal filesystem variability.

Diagnostics include the relevant path and a short message. The raw cause is kept
for daemon logs but callers should not rely on its shape.

## Testing

Vitest tests will create temporary synthetic repositories and linked worktrees
with Git metadata files directly. Tests will cover:

- normal repository detection,
- linked worktree detection through `.git` pointer files,
- direct `findGitWorktrees()` lookup from both main and linked worktree paths,
- scan-root dedupe through symlinks,
- ignored directory pruning,
- deterministic result ordering,
- diagnostics for malformed or unreadable Git metadata,
- default home-directory scan behavior.

The tests should avoid depending on the local `git` binary so CI behavior stays
stable.
