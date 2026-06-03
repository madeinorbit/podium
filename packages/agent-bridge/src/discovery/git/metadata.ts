import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { canonicalPath, isMissingPathError } from '../paths.js'
import type { GitDiscoveryDiagnostic, GitRepositorySummary, GitWorktreeSummary } from './types.js'

export type InspectGitRepositoryResult = {
  repository?: GitRepositorySummary
  diagnostics: GitDiscoveryDiagnostic[]
}

export async function inspectGitRepositoryPath(path: string): Promise<InspectGitRepositoryResult> {
  const diagnostics: GitDiscoveryDiagnostic[] = []
  const repositoryPath = await canonicalPath(path)
  const gitPath = join(repositoryPath, '.git')
  const gitPathStats = await statOptional(gitPath)

  if (gitPathStats?.isDirectory()) {
    const gitDir = await canonicalPath(gitPath)
    const repository = await readRepositorySummary({
      path: repositoryPath,
      kind: 'repository',
      gitDir,
      mainWorktreePath: repositoryPath,
      diagnostics,
    })
    return { repository, diagnostics }
  }

  if (gitPathStats?.isFile()) {
    const gitDir = await readGitPointerFile(gitPath, diagnostics)
    if (gitDir === undefined) return { diagnostics }

    const commonGitDir = await readCommonGitDir(gitDir, diagnostics)
    const repository = await readRepositorySummary({
      path: repositoryPath,
      kind: 'worktree',
      gitDir,
      commonGitDir,
      mainWorktreePath: inferMainWorktreePath(commonGitDir),
      diagnostics,
    })
    return { repository, diagnostics }
  }

  if (gitPathStats !== undefined) return { diagnostics }

  if (await isBareGitAdminDir(repositoryPath, diagnostics)) {
    const repository = await readRepositorySummary({
      path: repositoryPath,
      kind: 'bare',
      gitDir: repositoryPath,
      commonGitDir: repositoryPath,
      diagnostics,
    })
    return { repository, diagnostics }
  }

  return { diagnostics }
}

export async function readRegisteredWorktrees(
  commonGitDir: string,
): Promise<{ worktrees: GitWorktreeSummary[]; diagnostics: GitDiscoveryDiagnostic[] }> {
  const diagnostics: GitDiscoveryDiagnostic[] = []
  const resolvedCommonGitDir = await canonicalPath(commonGitDir)
  const worktreesDir = join(resolvedCommonGitDir, 'worktrees')

  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = await readdir(worktreesDir, { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) return { worktrees: [], diagnostics }

    diagnostics.push({
      severity: 'warning',
      path: worktreesDir,
      message: 'Could not read git worktrees metadata',
      cause: error,
    })
    return { worktrees: [], diagnostics }
  }

  const worktrees: GitWorktreeSummary[] = []
  for (const entry of entries.sort(compareDirentNames)) {
    if (!entry.isDirectory()) continue

    const gitDir = await canonicalPath(join(worktreesDir, entry.name))
    const worktree = await readRegisteredWorktree(gitDir, resolvedCommonGitDir, diagnostics)
    if (worktree !== undefined) worktrees.push(worktree)
  }

  worktrees.sort((left, right) => compareStrings(left.path, right.path))
  return { worktrees, diagnostics }
}

type ReadRepositorySummaryOptions = {
  path: string
  kind: GitRepositorySummary['kind']
  gitDir: string
  commonGitDir?: string
  mainWorktreePath?: string
  diagnostics: GitDiscoveryDiagnostic[]
}

async function readRepositorySummary({
  path,
  kind,
  gitDir,
  commonGitDir,
  mainWorktreePath,
  diagnostics,
}: ReadRepositorySummaryOptions): Promise<GitRepositorySummary> {
  const resolvedCommonGitDir = commonGitDir ?? (await readCommonGitDir(gitDir, diagnostics))
  const head = await readHeadMetadata(gitDir, resolvedCommonGitDir, diagnostics)
  const originUrl = await readOriginUrl(resolvedCommonGitDir, diagnostics)

  return {
    path,
    kind,
    gitDir,
    commonGitDir: resolvedCommonGitDir,
    ...(mainWorktreePath === undefined ? {} : { mainWorktreePath }),
    ...head,
    ...(originUrl === undefined ? {} : { originUrl }),
  }
}

async function readRegisteredWorktree(
  gitDir: string,
  commonGitDir: string,
  diagnostics: GitDiscoveryDiagnostic[],
): Promise<GitWorktreeSummary | undefined> {
  const gitdirPath = join(gitDir, 'gitdir')
  const gitdir = await readRequiredMetadataFile(
    gitdirPath,
    diagnostics,
    'Could not read git worktree gitdir metadata',
  )

  if (gitdir === undefined) return undefined

  const gitFilePath = trimLineEnding(firstLine(gitdir)).trim()
  if (gitFilePath.length === 0) {
    diagnostics.push({
      severity: 'warning',
      path: gitdirPath,
      message: 'Invalid git worktree gitdir metadata',
    })
    return undefined
  }

  const resolvedGitFilePath = resolveMetadataPath(dirname(gitdirPath), gitFilePath)
  let gitFileStats: Awaited<ReturnType<typeof stat>> | undefined
  try {
    gitFileStats = await statOptional(resolvedGitFilePath)
  } catch (error) {
    diagnostics.push({
      severity: 'warning',
      path: gitdirPath,
      message: 'Could not read git worktree target metadata',
      cause: error,
    })
    return undefined
  }

  if (gitFileStats === undefined) {
    diagnostics.push({
      severity: 'warning',
      path: gitdirPath,
      message: 'Git worktree target is missing',
    })
    return undefined
  }

  if (!gitFileStats.isFile()) {
    diagnostics.push({
      severity: 'warning',
      path: gitdirPath,
      message: 'Git worktree target is not a pointer file',
    })
    return undefined
  }

  const pointer = await readRequiredMetadataFile(
    resolvedGitFilePath,
    diagnostics,
    'Could not read git worktree target metadata',
  )

  if (pointer === undefined) return undefined

  const backPointerGitDir = parseGitPointerTargetPath(pointer, resolvedGitFilePath)
  const canonicalBackPointerGitDir = await readCanonicalWorktreeTargetPath(
    backPointerGitDir,
    gitdirPath,
    diagnostics,
    'Git worktree target does not point back to registration',
  )
  const canonicalRegisteredGitDir = await readCanonicalWorktreeTargetPath(
    gitDir,
    gitdirPath,
    diagnostics,
    'Git worktree target does not point back to registration',
  )
  if (
    canonicalBackPointerGitDir === undefined ||
    canonicalRegisteredGitDir === undefined ||
    canonicalBackPointerGitDir !== canonicalRegisteredGitDir
  ) {
    pushWarningDiagnostic(diagnostics, {
      severity: 'warning',
      path: gitdirPath,
      message: 'Git worktree target does not point back to registration',
    })
    return undefined
  }

  const canonicalGitFilePath = await canonicalPath(resolvedGitFilePath)
  const path = await canonicalPath(dirname(canonicalGitFilePath))
  const head = await readHeadMetadata(gitDir, commonGitDir, diagnostics)
  const locked = await markerExists(
    join(gitDir, 'locked'),
    diagnostics,
    'Could not read git worktree locked metadata',
  )
  const prunable = await markerExists(
    join(gitDir, 'prunable'),
    diagnostics,
    'Could not read git worktree prunable metadata',
  )

  return {
    path,
    gitDir,
    commonGitDir,
    ...head,
    ...(locked ? { locked: true } : {}),
    ...(prunable ? { prunable: true } : {}),
  }
}

async function readCanonicalWorktreeTargetPath(
  path: string | undefined,
  diagnosticPath: string,
  diagnostics: GitDiscoveryDiagnostic[],
  message: string,
): Promise<string | undefined> {
  if (path === undefined) return undefined

  try {
    return await canonicalPath(path)
  } catch (error) {
    pushWarningDiagnostic(diagnostics, {
      severity: 'warning',
      path: diagnosticPath,
      message,
      cause: error,
    })
    return undefined
  }
}

async function readGitPointerFile(
  gitPath: string,
  diagnostics: GitDiscoveryDiagnostic[],
): Promise<string | undefined> {
  const pointer = await readRequiredMetadataFile(
    gitPath,
    diagnostics,
    'Could not read Git pointer file',
  )

  if (pointer === undefined) return undefined

  const gitDir = parseGitPointerTargetPath(pointer, gitPath)
  if (gitDir === undefined) {
    diagnostics.push({
      severity: 'warning',
      path: gitPath,
      message: 'Malformed Git pointer file',
    })
    return undefined
  }

  const resolvedGitDir = gitDir
  let gitDirStats: Awaited<ReturnType<typeof stat>> | undefined
  try {
    gitDirStats = await statOptional(resolvedGitDir)
  } catch (error) {
    diagnostics.push({
      severity: 'warning',
      path: gitPath,
      message: 'Could not read Git pointer target metadata',
      cause: error,
    })
    return undefined
  }

  if (!gitDirStats?.isDirectory()) {
    diagnostics.push({
      severity: 'warning',
      path: gitPath,
      message: 'Git pointer target is missing',
    })
    return undefined
  }

  return await canonicalPath(resolvedGitDir)
}

async function isBareGitAdminDir(
  path: string,
  diagnostics: GitDiscoveryDiagnostic[],
): Promise<boolean> {
  const hasBareShape =
    (await isFile(join(path, 'HEAD'))) &&
    (await isDirectory(join(path, 'objects'))) &&
    (await isDirectory(join(path, 'refs')))

  if (!hasBareShape) return false

  const coreBare = await readCoreBareConfig(path, diagnostics)
  return coreBare !== false
}

async function isDirectory(path: string): Promise<boolean> {
  const stats = await statOptional(path)
  return stats?.isDirectory() ?? false
}

async function isFile(path: string): Promise<boolean> {
  const stats = await statOptional(path)
  return stats?.isFile() ?? false
}

async function statOptional(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(path)
  } catch (error) {
    if (isMissingPathError(error)) return undefined
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

  const value = trimLineEnding(head)
  const branch = parseHeadBranch(value)
  if (branch === undefined) {
    if (isGitSha(value)) return { headSha: value }

    diagnostics.push({
      severity: 'warning',
      path: headPath,
      message: 'Invalid git HEAD metadata',
    })
    return {}
  }

  const refPath = join(commonGitDir, 'refs', 'heads', branch)
  const ref = await readOptionalMetadataFile(
    refPath,
    diagnostics,
    'Could not read git branch ref metadata',
  )

  if (ref === undefined) return { branch }

  const headSha = trimLineEnding(ref)
  if (!isGitSha(headSha)) {
    diagnostics.push({
      severity: 'warning',
      path: refPath,
      message: 'Invalid git branch ref metadata',
    })
    return { branch }
  }

  return { branch, headSha }
}

function isGitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value) || /^[0-9a-f]{64}$/i.test(value)
}

function trimLineEnding(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2)
  if (value.endsWith('\n') || value.endsWith('\r')) return value.slice(0, -1)
  return value
}

function firstLine(value: string): string {
  const lineFeedIndex = value.indexOf('\n')
  if (lineFeedIndex !== -1) return value.slice(0, lineFeedIndex)

  const carriageReturnIndex = value.indexOf('\r')
  if (carriageReturnIndex !== -1) return value.slice(0, carriageReturnIndex)

  return value
}

function parseGitPointerTargetPath(pointer: string, gitPath: string): string | undefined {
  const line = trimLineEnding(firstLine(pointer))
  if (!line.startsWith('gitdir:')) return undefined

  const gitDir = line.slice('gitdir:'.length).trim()
  if (gitDir.length === 0) return undefined

  return resolveMetadataPath(dirname(gitPath), gitDir)
}

function parseHeadBranch(head: string): string | undefined {
  const prefix = 'ref: refs/heads/'
  if (!head.startsWith(prefix)) return undefined

  const branch = head.slice(prefix.length)
  return isSafeGitBranchRef(branch) ? branch : undefined
}

function isSafeGitBranchRef(ref: string): boolean {
  if (ref.length === 0) return false
  if (ref.startsWith('/') || ref.endsWith('/')) return false
  if (ref.endsWith('.')) return false
  if (ref === '@') return false
  if (ref.includes('\\')) return false
  if (ref.includes('@{') || ref.includes('..') || ref.includes('//')) return false
  if (hasUnsafeGitBranchCharacter(ref)) return false

  return ref.split('/').every((segment) => {
    return (
      segment.length > 0 &&
      segment !== '.' &&
      segment !== '..' &&
      !segment.startsWith('.') &&
      !segment.endsWith('.lock')
    )
  })
}

function hasUnsafeGitBranchCharacter(ref: string): boolean {
  for (const character of ref) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined) continue
    if (codePoint <= 0x20 || codePoint === 0x7f) return true
    if ('?*[~^:'.includes(character)) return true
  }

  return false
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

async function readCoreBareConfig(
  gitDir: string,
  diagnostics: GitDiscoveryDiagnostic[],
): Promise<boolean | undefined> {
  const config = await readOptionalMetadataFile(
    join(gitDir, 'config'),
    diagnostics,
    'Could not read git config metadata',
  )
  return config === undefined ? undefined : parseCoreBare(config)
}

function parseCoreBare(config: string): boolean | undefined {
  let inCoreSection = false
  let parsedBare: boolean | undefined

  for (const rawLine of config.split(/\r?\n/)) {
    const line = stripGitConfigComments(rawLine).trim()
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue

    const section = line.match(/^\[(.+)\]$/)
    if (section) {
      inCoreSection = section[1]?.trim().toLowerCase() === 'core'
      continue
    }

    if (!inCoreSection) continue

    const bare = line.match(/^bare(?:\s*=\s*(.*))?$/i)
    if (!bare) continue

    if (bare[1] === undefined) {
      parsedBare = true
      continue
    }

    const value = normalizeGitConfigBooleanValue(bare[1])
    if (value === '' || value === 'false' || value === 'no' || value === 'off' || value === '0') {
      parsedBare = false
      continue
    }
    if (value === 'true' || value === 'yes' || value === 'on' || value === '1') parsedBare = true
  }

  return parsedBare
}

function normalizeGitConfigBooleanValue(value: string): string {
  const uncommented = stripGitConfigComments(value).trim()
  const quote = uncommented[0]
  if ((quote === '"' || quote === "'") && uncommented.endsWith(quote) && uncommented.length >= 2) {
    return uncommented.slice(1, -1).trim().toLowerCase()
  }

  return uncommented.toLowerCase()
}

function stripGitConfigComments(value: string): string {
  let quote: '"' | "'" | undefined

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      continue
    }

    if (character === '"' || character === "'") {
      quote = character
      continue
    }

    if (character === '#' || character === ';') return value.slice(0, index)
  }

  return value
}

async function markerExists(
  path: string,
  diagnostics: GitDiscoveryDiagnostic[],
  message: string,
): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false

    diagnostics.push({
      severity: 'warning',
      path,
      message,
      cause: error,
    })
    return false
  }
}

function resolveMetadataPath(baseDirectory: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDirectory, path)
}

function inferMainWorktreePath(commonGitDir: string): string | undefined {
  return basename(commonGitDir) === '.git' ? dirname(commonGitDir) : undefined
}

function compareDirentNames(left: { name: string }, right: { name: string }): number {
  return compareStrings(left.name, right.name)
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
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

    pushWarningDiagnostic(diagnostics, {
      severity: 'warning',
      path,
      message,
      cause: error,
    })
    return undefined
  }
}

function pushWarningDiagnostic(
  diagnostics: GitDiscoveryDiagnostic[],
  diagnostic: GitDiscoveryDiagnostic,
): void {
  if (
    diagnostics.some((existing) => {
      return (
        existing.severity === diagnostic.severity &&
        existing.path === diagnostic.path &&
        existing.message === diagnostic.message
      )
    })
  ) {
    return
  }

  diagnostics.push(diagnostic)
}
