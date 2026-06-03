import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { canonicalPath, expandHome, isDirectory } from '../paths.js'
import { inspectGitRepositoryPath, readRegisteredWorktrees } from './metadata.js'
import type {
  FindGitWorktreesResult,
  GitDiscoveryDiagnostic,
  GitRepositorySummary,
  GitWorktreeSummary,
  ScanGitRepositoriesAtPathOptions,
  ScanGitRepositoriesOptions,
  ScanGitRepositoriesResult,
} from './types.js'

export async function scanGitRepositories(
  options: ScanGitRepositoriesOptions = {},
): Promise<ScanGitRepositoriesResult> {
  const homeDir = options.homeDir ?? homedir()
  const roots = await dedupeScanRoots(
    [...(options.roots ?? []), ...(options.includeHome === false ? [] : [homeDir])],
    homeDir,
  )

  if (roots.length === 0) return { repositories: [], diagnostics: [] }

  const repositories: GitRepositorySummary[] = []
  const diagnostics: GitDiscoveryDiagnostic[] = []
  for (const root of roots) {
    const result = await scanGitRepositoriesAtPath(root, {
      homeDir,
      maxDepth: options.maxDepth,
      concurrency: options.concurrency,
      ignoredDirectoryNames: options.ignoredDirectoryNames,
    })
    repositories.push(...result.repositories)
    diagnostics.push(...result.diagnostics)
  }

  return {
    repositories: dedupeRepositories(repositories).sort(compareRepositories),
    diagnostics: diagnostics.sort(compareDiagnostics),
  }
}

export const defaultGitIgnoredDirectoryNames = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.cache',
  '.npm',
  '.pnpm-store',
  '.yarn',
  'dist',
  'build',
  'target',
  'vendor',
  'Library',
  'Applications',
  'Pictures',
  'Music',
  'Movies',
] as const

type ScanItem = {
  path: string
  depth: number
}

export async function scanGitRepositoriesAtPath(
  path: string,
  options: ScanGitRepositoriesAtPathOptions = {},
): Promise<ScanGitRepositoriesResult> {
  const expanded = expandHome(path, options.homeDir ?? homedir())
  const diagnostics: GitDiscoveryDiagnostic[] = []
  let root: string

  try {
    root = await canonicalPath(expanded)
  } catch (error) {
    return {
      repositories: [],
      diagnostics: [
        {
          severity: 'warning',
          path: expanded,
          message: 'Could not resolve Git scan root',
          cause: error,
        },
      ],
    }
  }

  let rootIsDirectory: boolean
  try {
    rootIsDirectory = await isDirectory(root)
  } catch (error) {
    return {
      repositories: [],
      diagnostics: [
        {
          severity: 'warning',
          path: root,
          message: 'Could not read Git scan root',
          cause: error,
        },
      ],
    }
  }

  if (!rootIsDirectory) {
    return {
      repositories: [],
      diagnostics: [
        {
          severity: 'warning',
          path: root,
          message: 'Git scan root is not a directory',
        },
      ],
    }
  }

  const maxDepth = normalizeMaxDepth(options.maxDepth)
  const concurrency = normalizeConcurrency(options.concurrency)
  const ignoredDirectoryNames = new Set(
    options.ignoredDirectoryNames ?? defaultGitIgnoredDirectoryNames,
  )
  const repositories: GitRepositorySummary[] = []
  let items: ScanItem[] = [{ path: root, depth: 0 }]

  while (items.length > 0) {
    const nextItems: ScanItem[] = []
    await runBounded(items, concurrency, async (item) => {
      const children = await scanDirectory(item, {
        diagnostics,
        ignoredDirectoryNames,
        maxDepth,
        repositories,
      })
      nextItems.push(...children)
    })
    items = nextItems.sort(compareScanItems)
  }

  return {
    repositories: dedupeRepositories(repositories).sort(compareRepositories),
    diagnostics: diagnostics.sort(compareDiagnostics),
  }
}

export async function findGitWorktrees(repoPath: string): Promise<FindGitWorktreesResult> {
  const diagnostics: GitDiscoveryDiagnostic[] = []
  const inspected = await inspectGitRepositoryPath(repoPath)
  diagnostics.push(...inspected.diagnostics)

  if (inspected.repository === undefined) {
    throw new Error(`Path is not a Git repository, worktree, or bare repository: ${repoPath}`)
  }

  const worktreesResult = await readRegisteredWorktrees(inspected.repository.commonGitDir)
  diagnostics.push(...worktreesResult.diagnostics)

  const repository = await resolveFindRepository(inspected.repository, diagnostics)
  const repositoryWithWorktrees = attachWorktrees(repository, worktreesResult.worktrees)

  return {
    repository: repositoryWithWorktrees,
    worktrees: worktreesResult.worktrees,
    diagnostics: diagnostics.sort(compareDiagnostics),
  }
}

type ScanDirectoryContext = {
  diagnostics: GitDiscoveryDiagnostic[]
  ignoredDirectoryNames: ReadonlySet<string>
  maxDepth: number
  repositories: GitRepositorySummary[]
}

async function dedupeScanRoots(roots: readonly string[], homeDir: string): Promise<string[]> {
  const deduped: string[] = []
  const seen = new Set<string>()

  for (const root of roots) {
    const expanded = expandHome(root, homeDir)
    let key: string
    try {
      key = await canonicalPath(expanded)
    } catch {
      key = expanded
    }

    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(root)
  }

  return deduped
}

async function scanDirectory(
  item: ScanItem,
  context: ScanDirectoryContext,
): Promise<ScanItem[]> {
  let result: Awaited<ReturnType<typeof inspectGitRepositoryPath>>
  try {
    result = await inspectGitRepositoryPath(item.path)
  } catch (error) {
    context.diagnostics.push({
      severity: 'warning',
      path: item.path,
      message: 'Could not inspect Git scan directory',
      cause: error,
    })
    return []
  }

  context.diagnostics.push(...result.diagnostics)

  if (result.repository !== undefined) {
    const repositories = await withRegisteredWorktrees(result.repository, context.diagnostics)
    context.repositories.push(...repositories)
    return []
  }

  if (item.depth >= context.maxDepth) return []

  let entries
  try {
    entries = await readdir(item.path, { withFileTypes: true })
  } catch (error) {
    context.diagnostics.push({
      severity: 'warning',
      path: item.path,
      message: 'Could not read Git scan directory',
      cause: error,
    })
    return []
  }

  return entries
    .sort(compareDirentNames)
    .filter((entry) => entry.isDirectory() && !context.ignoredDirectoryNames.has(entry.name))
    .map((entry) => ({ path: join(item.path, entry.name), depth: item.depth + 1 }))
}

async function withRegisteredWorktrees(
  repository: GitRepositorySummary,
  diagnostics: GitDiscoveryDiagnostic[],
): Promise<GitRepositorySummary[]> {
  if (repository.kind === 'worktree') return [repository]

  const result = await readRegisteredWorktrees(repository.commonGitDir)
  diagnostics.push(...result.diagnostics)

  const repositoryWithWorktrees = attachWorktrees(repository, result.worktrees)
  return [
    repositoryWithWorktrees,
    ...result.worktrees.map((worktree) => toWorktreeRepository(worktree, repository)),
  ]
}

async function resolveFindRepository(
  repository: GitRepositorySummary,
  diagnostics: GitDiscoveryDiagnostic[],
): Promise<GitRepositorySummary> {
  if (repository.kind !== 'worktree') return repository

  if (repository.mainWorktreePath !== undefined) {
    const mainResult = await inspectGitRepositoryPath(repository.mainWorktreePath)
    diagnostics.push(...mainResult.diagnostics)
    if (
      mainResult.repository !== undefined &&
      mainResult.repository.kind !== 'worktree' &&
      mainResult.repository.commonGitDir === repository.commonGitDir
    ) {
      return mainResult.repository
    }
  }

  const commonResult = await inspectGitRepositoryPath(repository.commonGitDir)
  diagnostics.push(...commonResult.diagnostics)
  if (commonResult.repository !== undefined && commonResult.repository.kind !== 'worktree') {
    return commonResult.repository
  }

  return repository
}

function attachWorktrees(
  repository: GitRepositorySummary,
  worktrees: readonly GitWorktreeSummary[],
): GitRepositorySummary {
  if (repository.kind === 'worktree' || worktrees.length === 0) return repository
  return { ...repository, worktrees: [...worktrees] }
}

function toWorktreeRepository(
  worktree: GitWorktreeSummary,
  mainRepository: GitRepositorySummary,
): GitRepositorySummary {
  return {
    path: worktree.path,
    kind: 'worktree',
    gitDir: worktree.gitDir,
    commonGitDir: worktree.commonGitDir,
    ...(mainRepository.mainWorktreePath === undefined
      ? {}
      : { mainWorktreePath: mainRepository.mainWorktreePath }),
    ...(worktree.branch === undefined ? {} : { branch: worktree.branch }),
    ...(worktree.headSha === undefined ? {} : { headSha: worktree.headSha }),
    ...(mainRepository.originUrl === undefined ? {} : { originUrl: mainRepository.originUrl }),
  }
}

async function runBounded<T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return

      const item = items[index]
      if (item === undefined) return
      await run(item)
    }
  }

  const workerCount = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: workerCount }, worker))
}

function dedupeRepositories(repositories: readonly GitRepositorySummary[]): GitRepositorySummary[] {
  const deduped: GitRepositorySummary[] = []
  const seen = new Set<string>()

  for (const repository of [...repositories].sort(compareRepositories)) {
    const key = `${repository.commonGitDir}\0${repository.path}`
    if (seen.has(key)) continue

    seen.add(key)
    deduped.push(repository)
  }

  return deduped
}

function normalizeConcurrency(concurrency: number | undefined): number {
  if (concurrency === undefined || !Number.isFinite(concurrency)) return 8
  return Math.max(1, Math.floor(concurrency))
}

function normalizeMaxDepth(maxDepth: number | undefined): number {
  if (maxDepth === undefined || !Number.isFinite(maxDepth)) return Number.POSITIVE_INFINITY
  return Math.max(0, Math.floor(maxDepth))
}

function compareDirentNames(left: { name: string }, right: { name: string }): number {
  if (left.name < right.name) return -1
  if (left.name > right.name) return 1
  return 0
}

function compareScanItems(left: ScanItem, right: ScanItem): number {
  return compareStrings(left.path, right.path)
}

function compareRepositories(
  left: GitRepositorySummary,
  right: GitRepositorySummary,
): number {
  const pathComparison = compareStrings(left.path, right.path)
  if (pathComparison !== 0) return pathComparison
  return compareStrings(left.commonGitDir, right.commonGitDir)
}

function compareDiagnostics(
  left: GitDiscoveryDiagnostic,
  right: GitDiscoveryDiagnostic,
): number {
  const pathComparison = compareStrings(left.path, right.path)
  if (pathComparison !== 0) return pathComparison

  const severityComparison = compareStrings(left.severity, right.severity)
  if (severityComparison !== 0) return severityComparison

  return compareStrings(left.message, right.message)
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
