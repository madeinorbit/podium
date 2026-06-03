import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { canonicalPath, isMissingPathError } from '../paths.js'
import type {
  GitDiscoveryDiagnostic,
  GitRepositorySummary,
  GitWorktreeSummary,
} from './types.js'

export type InspectGitRepositoryResult = {
  repository?: GitRepositorySummary
  diagnostics: GitDiscoveryDiagnostic[]
}

export async function inspectGitRepositoryPath(path: string): Promise<InspectGitRepositoryResult> {
  const diagnostics: GitDiscoveryDiagnostic[] = []
  const repositoryPath = await canonicalPath(path)
  const gitDirPath = join(repositoryPath, '.git')

  if (!(await isDirectory(gitDirPath))) {
    return { diagnostics }
  }

  const gitDir = await canonicalPath(gitDirPath)
  const commonGitDir = await readCommonGitDir(gitDir, diagnostics)
  const head = await readHeadMetadata(gitDir, commonGitDir, diagnostics)
  const originUrl = await readOriginUrl(commonGitDir, diagnostics)

  return {
    repository: {
      path: repositoryPath,
      kind: 'repository',
      gitDir,
      commonGitDir,
      mainWorktreePath: repositoryPath,
      ...head,
      ...(originUrl === undefined ? {} : { originUrl }),
    },
    diagnostics,
  }
}

export async function readRegisteredWorktrees(
  _commonGitDir: string,
): Promise<{ worktrees: GitWorktreeSummary[]; diagnostics: GitDiscoveryDiagnostic[] }> {
  return { worktrees: [], diagnostics: [] }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}

async function readCommonGitDir(
  gitDir: string,
  diagnostics: GitDiscoveryDiagnostic[],
): Promise<string> {
  const commondirPath = join(gitDir, 'commondir')
  const commondir = await readOptionalMetadataFile(
    commondirPath,
    diagnostics,
    'Could not read git commondir metadata',
  )

  if (commondir === undefined) return gitDir

  const value = commondir.trim()
  if (value.length === 0) return gitDir

  return await canonicalPath(resolve(gitDir, value))
}

async function readHeadMetadata(
  gitDir: string,
  commonGitDir: string,
  diagnostics: GitDiscoveryDiagnostic[],
): Promise<Pick<GitRepositorySummary, 'branch' | 'headSha'>> {
  const headPath = join(gitDir, 'HEAD')
  const head = await readRequiredMetadataFile(
    headPath,
    diagnostics,
    'Could not read git HEAD metadata',
  )

  if (head === undefined) return {}

  const value = head.trim()
  const branch = parseHeadBranch(value)
  if (branch === undefined) {
    return value.length === 0 ? {} : { headSha: value }
  }

  const refPath = join(commonGitDir, 'refs', 'heads', branch)
  const ref = await readOptionalMetadataFile(
    refPath,
    diagnostics,
    'Could not read git branch ref metadata',
  )
  const headSha = ref?.trim()

  return {
    branch,
    ...(headSha === undefined || headSha.length === 0 ? {} : { headSha }),
  }
}

function parseHeadBranch(head: string): string | undefined {
  const prefix = 'ref: refs/heads/'
  if (!head.startsWith(prefix)) return undefined

  const branch = head.slice(prefix.length).trim()
  return branch.length === 0 ? undefined : branch
}

async function readOriginUrl(
  commonGitDir: string,
  diagnostics: GitDiscoveryDiagnostic[],
): Promise<string | undefined> {
  const configPath = join(commonGitDir, 'config')
  const config = await readOptionalMetadataFile(
    configPath,
    diagnostics,
    'Could not read git config metadata',
  )

  return config === undefined ? undefined : parseOriginUrl(config)
}

function parseOriginUrl(config: string): string | undefined {
  let inOriginRemote = false

  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue

    const section = line.match(/^\[(.+)\]$/)
    if (section) {
      inOriginRemote = section[1]?.trim() === 'remote "origin"'
      continue
    }

    if (!inOriginRemote) continue

    const url = line.match(/^url\s*=\s*(.*)$/)
    if (url) return url[1]?.trim()
  }

  return undefined
}

async function readRequiredMetadataFile(
  path: string,
  diagnostics: GitDiscoveryDiagnostic[],
  message: string,
): Promise<string | undefined> {
  return await readMetadataFile(path, diagnostics, message, true)
}

async function readOptionalMetadataFile(
  path: string,
  diagnostics: GitDiscoveryDiagnostic[],
  message: string,
): Promise<string | undefined> {
  return await readMetadataFile(path, diagnostics, message, false)
}

async function readMetadataFile(
  path: string,
  diagnostics: GitDiscoveryDiagnostic[],
  message: string,
  warnOnMissing: boolean,
): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (!warnOnMissing && isMissingPathError(error)) return undefined

    diagnostics.push({
      severity: 'warning',
      path,
      message,
      cause: error,
    })
    return undefined
  }
}
