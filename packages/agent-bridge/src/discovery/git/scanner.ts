import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { canonicalPath, expandHome, isDirectory } from '../paths.js'
import { inspectGitRepositoryPath, readRegisteredWorktrees } from './metadata.js'
import type {
  FindGitWorktreesResult,
  GitDiscoveryDiagnostic,
  GitRepositorySummary,
  ScanGitRepositoriesAtPathOptions,
  ScanGitRepositoriesResult,
} from './types.js'

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
  const root = await canonicalPath(expandHome(path, options.homeDir ?? homedir()))
  const diagnostics: GitDiscoveryDiagnostic[] = []

  if (!(await isDirectory(root))) {
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

export async function findGitWorktrees(): Promise<FindGitWorktreesResult> {
  throw new Error('findGitWorktrees is added in Task 4')
}

type ScanDirectoryContext = {
  diagnostics: GitDiscoveryDiagnostic[]
  ignoredDirectoryNames: ReadonlySet<string>
  maxDepth: number
  repositories: GitRepositorySummary[]
}

async function scanDirectory(
  item: ScanItem,
  context: ScanDirectoryContext,
): Promise<ScanItem[]> {
  const result = await inspectGitRepositoryPath(item.path)
  context.diagnostics.push(...result.diagnostics)

  if (result.repository !== undefined) {
    context.repositories.push(await withRegisteredWorktrees(result.repository, context.diagnostics))
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
): Promise<GitRepositorySummary> {
  if (repository.kind === 'worktree') return repository

  const result = await readRegisteredWorktrees(repository.commonGitDir)
  diagnostics.push(...result.diagnostics)

  if (result.worktrees.length === 0) return repository
  return { ...repository, worktrees: result.worktrees }
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
