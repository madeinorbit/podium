# Git Repository Worktree Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a filesystem-first TypeScript library in `@podium/agent-bridge` that discovers local Git repositories and worktrees, scans the user's home directory by default, scans a caller-provided path on demand, and resolves all worktrees for one concrete repository without recursively scanning the disk.

**Architecture:** Add a focused `packages/agent-bridge/src/discovery/git/` module split into public types, Git metadata parsing, filesystem walking, and public API exports. The broad scanner detects `.git` directories, `.git` pointer files, and bare repositories, then parses Git admin files directly with best-effort diagnostics. Direct worktree lookup resolves one repository's common Git directory and reads `<commonGitDir>/worktrees/*`.

**Tech Stack:** TypeScript ESM · Node `fs/promises`, `path`, and `os` APIs · existing discovery path helpers · Vitest · Bun task runner. No new package dependency is required.

**Source spec:** `docs/superpowers/specs/2026-06-03-git-repository-worktree-discovery-design.md`

---

## File Structure

- `packages/agent-bridge/src/discovery/git/types.ts` — public Git discovery option, result, summary, and diagnostic types.
- `packages/agent-bridge/src/discovery/git/metadata.ts` — direct Git admin-file parsing for `.git` directories, `.git` files, bare repositories, HEAD, config, common dirs, and registered worktrees.
- `packages/agent-bridge/src/discovery/git/scanner.ts` — public scan orchestration, deterministic bounded-concurrency filesystem walking, pruning, dedupe, and direct worktree lookup.
- `packages/agent-bridge/src/discovery/git/index.ts` — Git discovery barrel export.
- `packages/agent-bridge/src/discovery/index.ts` — re-export Git discovery through the existing discovery package barrel.
- `packages/agent-bridge/src/discovery/git/metadata.test.ts` — focused metadata-parser tests with synthetic Git directories.
- `packages/agent-bridge/src/discovery/git/scanner.test.ts` — public API scanner and worktree lookup tests with synthetic Git directories.

Conscious v1 scope decisions:

- Do not require or call the `git` binary in tests or implementation.
- Do not follow symlinked directories during recursive scans; canonicalize explicit roots instead.
- Return real/canonical filesystem paths in summaries.
- Treat malformed Git metadata and unreadable paths as diagnostics.
- Throw from `findGitWorktrees(repoPath)` only when the supplied path is not a Git repository or worktree.
- Resolve attached branches from `HEAD`; resolve `headSha` only for detached `HEAD` content or loose branch refs found under the common Git dir.
- Ignore packed refs in v1.

---

## Task 1: Public Types And Normal Repository Metadata

**Files:**
- Create: `packages/agent-bridge/src/discovery/git/types.ts`
- Create: `packages/agent-bridge/src/discovery/git/metadata.ts`
- Test: `packages/agent-bridge/src/discovery/git/metadata.test.ts`

- [ ] **Step 1: Write the failing normal-repository metadata test**

Create `packages/agent-bridge/src/discovery/git/metadata.test.ts`:

```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { inspectGitRepositoryPath } from './metadata.js'

const mainSha = '1111111111111111111111111111111111111111'

async function createTempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'podium-git-discovery-'))
}

async function writeNormalRepo(root: string, name = 'repo'): Promise<string> {
  const repo = join(root, name)
  const gitDir = join(repo, '.git')
  await mkdir(join(gitDir, 'objects'), { recursive: true })
  await mkdir(join(gitDir, 'refs', 'heads'), { recursive: true })
  await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
  await writeFile(join(gitDir, 'refs', 'heads', 'main'), `${mainSha}\n`)
  await writeFile(
    join(gitDir, 'config'),
    '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:podium/repo.git\n',
  )
  return repo
}

describe('inspectGitRepositoryPath', () => {
  test('detects a normal working-tree repository and parses branch, sha, and origin', async () => {
    const root = await createTempRoot()
    const repo = await writeNormalRepo(root)

    const result = await inspectGitRepositoryPath(repo)

    expect(result.diagnostics).toEqual([])
    expect(result.repository).toEqual(
      expect.objectContaining({
        path: repo,
        kind: 'repository',
        gitDir: join(repo, '.git'),
        commonGitDir: join(repo, '.git'),
        mainWorktreePath: repo,
        branch: 'main',
        headSha: mainSha,
        originUrl: 'git@github.com:podium/repo.git',
      }),
    )
  })

  test('returns no repository for a regular directory', async () => {
    const root = await createTempRoot()
    const directory = join(root, 'plain')
    await mkdir(directory)

    const result = await inspectGitRepositoryPath(directory)

    expect(result.repository).toBeUndefined()
    expect(result.diagnostics).toEqual([])
  })
})
```

- [ ] **Step 2: Run the metadata test and verify it fails because the module does not exist**

Run:

```bash
bun test packages/agent-bridge/src/discovery/git/metadata.test.ts
```

Expected: FAIL with an import error for `./metadata.js`.

- [ ] **Step 3: Add public Git discovery types**

Create `packages/agent-bridge/src/discovery/git/types.ts`:

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
```

- [ ] **Step 4: Add normal repository metadata parsing**

Create `packages/agent-bridge/src/discovery/git/metadata.ts` with this first implementation:

```ts
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { canonicalPath, isMissingPathError, isNodeError } from '../paths.js'
import type {
  GitDiscoveryDiagnostic,
  GitRepositoryKind,
  GitRepositorySummary,
  GitWorktreeSummary,
} from './types.js'

export type InspectGitRepositoryResult = {
  repository?: GitRepositorySummary
  diagnostics: GitDiscoveryDiagnostic[]
}

type GitLayout = {
  kind: GitRepositoryKind
  gitDir: string
  commonGitDir: string
}

type HeadMetadata = {
  branch?: string
  headSha?: string
}

export async function inspectGitRepositoryPath(path: string): Promise<InspectGitRepositoryResult> {
  const diagnostics: GitDiscoveryDiagnostic[] = []
  const canonicalWorktreePath = await canonicalPath(path)
  const layout = await detectGitLayout(canonicalWorktreePath, diagnostics)
  if (!layout) return { diagnostics }

  const head = await readHeadMetadata(layout.gitDir, layout.commonGitDir, diagnostics)
  const originUrl = await readOriginUrl(layout.commonGitDir, diagnostics)
  const mainWorktreePath = mainWorktreePathFromCommonGitDir(layout.commonGitDir)

  return {
    repository: {
      path: canonicalWorktreePath,
      kind: layout.kind,
      gitDir: layout.gitDir,
      commonGitDir: layout.commonGitDir,
      mainWorktreePath,
      ...head,
      ...(originUrl ? { originUrl } : {}),
    },
    diagnostics,
  }
}

export async function readRegisteredWorktrees(
  commonGitDir: string,
): Promise<{ worktrees: GitWorktreeSummary[]; diagnostics: GitDiscoveryDiagnostic[] }> {
  return { worktrees: [], diagnostics: [] }
}

async function detectGitLayout(
  path: string,
  diagnostics: GitDiscoveryDiagnostic[],
): Promise<GitLayout | undefined> {
  const dotGit = join(path, '.git')
  const dotGitStats = await statIfExists(dotGit)

  if (dotGitStats?.isDirectory()) {
    const gitDir = await canonicalPath(dotGit)
    return {
      kind: 'repository',
      gitDir,
      commonGitDir: await resolveCommonGitDir(gitDir, diagnostics),
    }
  }

  return undefined
}

async function resolveCommonGitDir(
  gitDir: string,
  diagnostics: GitDiscoveryDiagnostic[],
): Promise<string> {
  try {
    const commonDir = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim()
    if (commonDir.length > 0) return await canonicalPath(resolveGitPath(gitDir, commonDir))
  } catch (cause) {
    if (!isMissingPathError(cause)) {
      diagnostics.push({
        severity: 'warning',
        path: join(gitDir, 'commondir'),
        message: 'Could not read Git common dir metadata',
        cause,
      })
    }
  }

  return gitDir
}

async function readHeadMetadata(
  gitDir: string,
  commonGitDir: string,
  diagnostics: GitDiscoveryDiagnostic[],
): Promise<HeadMetadata> {
  const headPath = join(gitDir, 'HEAD')
  try {
    const head = firstLine(await readFile(headPath, 'utf8'))
    if (head.startsWith('ref: ')) {
      const ref = head.slice('ref: '.length).trim()
      const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
      const headSha = await readLooseRefSha(commonGitDir, ref, diagnostics)
      return { branch, ...(headSha ? { headSha } : {}) }
    }
    if (isSha(head)) return { headSha: head }
  } catch (cause) {
    diagnostics.push({
      severity: 'warning',
      path: headPath,
      message: 'Could not read Git HEAD metadata',
      cause,
    })
  }

  return {}
}

async function readLooseRefSha(
  commonGitDir: string,
  ref: string,
  diagnostics: GitDiscoveryDiagnostic[],
): Promise<string | undefined> {
  const refPath = join(commonGitDir, ref)
  try {
    const value = firstLine(await readFile(refPath, 'utf8'))
    return isSha(value) ? value : undefined
  } catch (cause) {
    if (!isMissingPathError(cause)) {
      diagnostics.push({
        severity: 'warning',
        path: refPath,
        message: 'Could not read Git ref metadata',
        cause,
      })
    }
  }
  return undefined
}

async function readOriginUrl(
  commonGitDir: string,
  diagnostics: GitDiscoveryDiagnostic[],
): Promise<string | undefined> {
  const configPath = join(commonGitDir, 'config')
  try {
    let inOrigin = false
    for (const rawLine of (await readFile(configPath, 'utf8')).split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line.startsWith('[')) {
        inOrigin = line === '[remote "origin"]'
        continue
      }
      if (inOrigin && line.startsWith('url')) {
        const separator = line.indexOf('=')
        if (separator >= 0) return line.slice(separator + 1).trim()
      }
    }
  } catch (cause) {
    if (!isMissingPathError(cause)) {
      diagnostics.push({
        severity: 'warning',
        path: configPath,
        message: 'Could not read Git config metadata',
        cause,
      })
    }
  }
  return undefined
}

async function statIfExists(path: string): Promise<import('node:fs').Stats | undefined> {
  try {
    return await stat(path)
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }
}

function resolveGitPath(baseDirectory: string, value: string): string {
  return value.startsWith('/') ? value : join(baseDirectory, value)
}

function mainWorktreePathFromCommonGitDir(commonGitDir: string): string | undefined {
  return basename(commonGitDir) === '.git' ? dirname(commonGitDir) : undefined
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? ''
}

function isSha(value: string): boolean {
  return /^[0-9a-f]{40,64}$/i.test(value)
}
```

- [ ] **Step 5: Run the metadata test and verify it passes**

Run:

```bash
bun test packages/agent-bridge/src/discovery/git/metadata.test.ts
```

Expected: PASS for both `inspectGitRepositoryPath` tests.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add packages/agent-bridge/src/discovery/git/types.ts packages/agent-bridge/src/discovery/git/metadata.ts packages/agent-bridge/src/discovery/git/metadata.test.ts
git commit -m "feat(agent-bridge): parse git repository metadata"
```

---

## Task 2: Linked Worktrees, Bare Repositories, And Registered Worktrees

**Files:**
- Modify: `packages/agent-bridge/src/discovery/git/metadata.ts`
- Test: `packages/agent-bridge/src/discovery/git/metadata.test.ts`

- [ ] **Step 1: Add failing tests for linked worktrees, bare repos, and malformed pointer files**

Append these tests and helpers to `packages/agent-bridge/src/discovery/git/metadata.test.ts`:

```ts
const featureSha = '2222222222222222222222222222222222222222'

async function writeLinkedWorktree(root: string): Promise<{ main: string; worktree: string }> {
  const main = await writeNormalRepo(root, 'main')
  const worktree = join(root, 'main-feature')
  const adminDir = join(main, '.git', 'worktrees', 'main-feature')
  await mkdir(worktree, { recursive: true })
  await mkdir(adminDir, { recursive: true })
  await writeFile(join(worktree, '.git'), `gitdir: ${adminDir}\n`)
  await writeFile(join(adminDir, 'commondir'), '../..\n')
  await writeFile(join(adminDir, 'gitdir'), `${join(worktree, '.git')}\n`)
  await writeFile(join(adminDir, 'HEAD'), 'ref: refs/heads/feature\n')
  await writeFile(join(main, '.git', 'refs', 'heads', 'feature'), `${featureSha}\n`)
  return { main, worktree }
}

async function writeBareRepo(root: string): Promise<string> {
  const bare = join(root, 'repo.git')
  await mkdir(join(bare, 'objects'), { recursive: true })
  await mkdir(join(bare, 'refs'), { recursive: true })
  await writeFile(join(bare, 'HEAD'), `${mainSha}\n`)
  return bare
}

test('detects a linked worktree through a .git pointer file', async () => {
  const root = await createTempRoot()
  const { main, worktree } = await writeLinkedWorktree(root)

  const result = await inspectGitRepositoryPath(worktree)

  expect(result.diagnostics).toEqual([])
  expect(result.repository).toEqual(
    expect.objectContaining({
      path: worktree,
      kind: 'worktree',
      gitDir: join(main, '.git', 'worktrees', 'main-feature'),
      commonGitDir: join(main, '.git'),
      mainWorktreePath: main,
      branch: 'feature',
      headSha: featureSha,
    }),
  )
})

test('reads registered linked worktrees from the common Git directory', async () => {
  const root = await createTempRoot()
  const { main, worktree } = await writeLinkedWorktree(root)

  const result = await readRegisteredWorktrees(join(main, '.git'))

  expect(result.diagnostics).toEqual([])
  expect(result.worktrees).toEqual([
    expect.objectContaining({
      path: worktree,
      gitDir: join(main, '.git', 'worktrees', 'main-feature'),
      commonGitDir: join(main, '.git'),
      branch: 'feature',
      headSha: featureSha,
    }),
  ])
})

test('detects a bare repository when the scanned directory is the Git admin dir', async () => {
  const root = await createTempRoot()
  const bare = await writeBareRepo(root)

  const result = await inspectGitRepositoryPath(bare)

  expect(result.diagnostics).toEqual([])
  expect(result.repository).toEqual(
    expect.objectContaining({
      path: bare,
      kind: 'bare',
      gitDir: bare,
      commonGitDir: bare,
      headSha: mainSha,
    }),
  )
})

test('reports malformed .git pointer files as diagnostics', async () => {
  const root = await createTempRoot()
  const worktree = join(root, 'broken')
  await mkdir(worktree)
  await writeFile(join(worktree, '.git'), 'not-a-pointer\n')

  const result = await inspectGitRepositoryPath(worktree)

  expect(result.repository).toBeUndefined()
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      severity: 'warning',
      path: join(worktree, '.git'),
      message: 'Malformed Git pointer file',
    }),
  ])
})
```

Also update the import line:

```ts
import { inspectGitRepositoryPath, readRegisteredWorktrees } from './metadata.js'
```

- [ ] **Step 2: Run the metadata tests and verify the new tests fail**

Run:

```bash
bun test packages/agent-bridge/src/discovery/git/metadata.test.ts
```

Expected: FAIL because linked worktrees, bare repositories, and registered worktrees are not implemented.

- [ ] **Step 3: Implement pointer-file, bare-repo, and registered-worktree parsing**

Modify `packages/agent-bridge/src/discovery/git/metadata.ts`:

```ts
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
```

Replace `readRegisteredWorktrees` with:

```ts
export async function readRegisteredWorktrees(
  commonGitDir: string,
): Promise<{ worktrees: GitWorktreeSummary[]; diagnostics: GitDiscoveryDiagnostic[] }> {
  const diagnostics: GitDiscoveryDiagnostic[] = []
  const worktreesRoot = join(commonGitDir, 'worktrees')
  const entries = await safeReadDirectory(worktreesRoot, diagnostics)
  const worktrees: GitWorktreeSummary[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const gitDir = await canonicalPath(join(worktreesRoot, entry.name))
    const gitdirFile = join(gitDir, 'gitdir')
    try {
      const gitFilePath = firstLine(await readFile(gitdirFile, 'utf8'))
      const worktreePath = await canonicalPath(dirname(resolveGitPath(gitDir, gitFilePath)))
      const head = await readHeadMetadata(gitDir, commonGitDir, diagnostics)
      worktrees.push({
        path: worktreePath,
        gitDir,
        commonGitDir,
        ...head,
        ...((await pathExists(join(gitDir, 'locked'))) ? { locked: true } : {}),
        ...((await pathExists(join(gitDir, 'prunable'))) ? { prunable: true } : {}),
      })
    } catch (cause) {
      diagnostics.push({
        severity: 'warning',
        path: gitdirFile,
        message: 'Could not read registered Git worktree metadata',
        cause,
      })
    }
  }

  return { worktrees: worktrees.sort(compareWorktrees), diagnostics }
}
```

Extend `detectGitLayout` after the `.git` directory branch:

```ts
  if (dotGitStats?.isFile()) {
    const gitDir = await readGitPointerFile(dotGit, diagnostics)
    if (!gitDir) return undefined
    const canonicalGitDir = await canonicalPath(gitDir)
    return {
      kind: 'worktree',
      gitDir: canonicalGitDir,
      commonGitDir: await resolveCommonGitDir(canonicalGitDir, diagnostics),
    }
  }

  if (await isBareGitDir(path)) {
    return {
      kind: 'bare',
      gitDir: path,
      commonGitDir: await resolveCommonGitDir(path, diagnostics),
    }
  }
```

Add these helper functions:

```ts
async function readGitPointerFile(
  pointerFile: string,
  diagnostics: GitDiscoveryDiagnostic[],
): Promise<string | undefined> {
  try {
    const value = firstLine(await readFile(pointerFile, 'utf8'))
    if (!value.startsWith('gitdir:')) {
      diagnostics.push({
        severity: 'warning',
        path: pointerFile,
        message: 'Malformed Git pointer file',
      })
      return undefined
    }
    const target = value.slice('gitdir:'.length).trim()
    if (target.length === 0) {
      diagnostics.push({
        severity: 'warning',
        path: pointerFile,
        message: 'Malformed Git pointer file',
      })
      return undefined
    }
    return resolveGitPath(dirname(pointerFile), target)
  } catch (cause) {
    diagnostics.push({
      severity: 'warning',
      path: pointerFile,
      message: 'Could not read Git pointer file',
      cause,
    })
  }
  return undefined
}

async function isBareGitDir(path: string): Promise<boolean> {
  const [head, objects, refs] = await Promise.all([
    statIfExists(join(path, 'HEAD')),
    statIfExists(join(path, 'objects')),
    statIfExists(join(path, 'refs')),
  ])
  return Boolean(head?.isFile() && objects?.isDirectory() && refs?.isDirectory())
}

async function safeReadDirectory(
  path: string,
  diagnostics: GitDiscoveryDiagnostic[],
): Promise<import('node:fs').Dirent[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).sort(compareDirents)
  } catch (cause) {
    if (isMissingPathError(cause)) return []
    diagnostics.push({
      severity: 'warning',
      path,
      message: 'Could not read Git worktrees directory',
      cause,
    })
    return []
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (cause) {
    if (isMissingPathError(cause)) return false
    throw cause
  }
}

function compareDirents(left: { name: string }, right: { name: string }): number {
  return compareStrings(left.name, right.name)
}

function compareWorktrees(left: GitWorktreeSummary, right: GitWorktreeSummary): number {
  return compareStrings(left.path, right.path)
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
```

Remove the unused `isNodeError` import if TypeScript reports it unused.

- [ ] **Step 4: Run the metadata tests and verify they pass**

Run:

```bash
bun test packages/agent-bridge/src/discovery/git/metadata.test.ts
```

Expected: PASS for normal repositories, linked worktrees, bare repositories, registered worktrees, and malformed pointer diagnostics.

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git add packages/agent-bridge/src/discovery/git/metadata.ts packages/agent-bridge/src/discovery/git/metadata.test.ts
git commit -m "feat(agent-bridge): parse git worktree metadata"
```

---

## Task 3: Path-Scoped Repository Scanner

**Files:**
- Create: `packages/agent-bridge/src/discovery/git/scanner.ts`
- Test: `packages/agent-bridge/src/discovery/git/scanner.test.ts`

- [ ] **Step 1: Write failing scanner tests for explicit path scans**

Create `packages/agent-bridge/src/discovery/git/scanner.test.ts`:

```ts
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { scanGitRepositoriesAtPath } from './scanner.js'

const mainSha = '1111111111111111111111111111111111111111'
const featureSha = '2222222222222222222222222222222222222222'

async function createTempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'podium-git-scan-'))
}

async function writeNormalRepo(root: string, name: string): Promise<string> {
  const repo = join(root, name)
  const gitDir = join(repo, '.git')
  await mkdir(join(gitDir, 'objects'), { recursive: true })
  await mkdir(join(gitDir, 'refs', 'heads'), { recursive: true })
  await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
  await writeFile(join(gitDir, 'refs', 'heads', 'main'), `${mainSha}\n`)
  return repo
}

async function writeLinkedWorktree(root: string): Promise<{ main: string; worktree: string }> {
  const main = await writeNormalRepo(root, 'main')
  const worktree = join(root, 'main-feature')
  const adminDir = join(main, '.git', 'worktrees', 'main-feature')
  await mkdir(worktree, { recursive: true })
  await mkdir(adminDir, { recursive: true })
  await writeFile(join(worktree, '.git'), `gitdir: ${adminDir}\n`)
  await writeFile(join(adminDir, 'commondir'), '../..\n')
  await writeFile(join(adminDir, 'gitdir'), `${join(worktree, '.git')}\n`)
  await writeFile(join(adminDir, 'HEAD'), 'ref: refs/heads/feature\n')
  await writeFile(join(main, '.git', 'refs', 'heads', 'feature'), `${featureSha}\n`)
  return { main, worktree }
}

describe('scanGitRepositoriesAtPath', () => {
  test('discovers nested repositories and linked worktrees in deterministic path order', async () => {
    const root = await createTempRoot()
    const alpha = await writeNormalRepo(join(root, 'projects'), 'alpha')
    const { main, worktree } = await writeLinkedWorktree(join(root, 'projects'))

    const result = await scanGitRepositoriesAtPath(root)

    expect(result.diagnostics).toEqual([])
    expect(result.repositories.map((repo) => repo.path)).toEqual([alpha, main, worktree])
    expect(result.repositories.map((repo) => repo.kind)).toEqual([
      'repository',
      'repository',
      'worktree',
    ])
  })

  test('prunes ignored directories before descending', async () => {
    const root = await createTempRoot()
    await writeNormalRepo(join(root, 'node_modules'), 'hidden')
    const visible = await writeNormalRepo(root, 'visible')

    const result = await scanGitRepositoriesAtPath(root)

    expect(result.repositories.map((repo) => repo.path)).toEqual([visible])
  })

  test('dedupes explicit symlinked roots by canonical repository path', async () => {
    const root = await createTempRoot()
    const repo = await writeNormalRepo(root, 'repo')
    const link = join(root, 'repo-link')
    await symlink(repo, link)

    const result = await scanGitRepositoriesAtPath(link)

    expect(result.diagnostics).toEqual([])
    expect(result.repositories.map((repository) => repository.path)).toEqual([repo])
  })

  test('honors maxDepth for broad scans', async () => {
    const root = await createTempRoot()
    await writeNormalRepo(join(root, 'one', 'two'), 'deep')

    const result = await scanGitRepositoriesAtPath(root, { maxDepth: 1 })

    expect(result.repositories).toEqual([])
  })
})
```

- [ ] **Step 2: Run scanner tests and verify they fail because the scanner module does not exist**

Run:

```bash
bun test packages/agent-bridge/src/discovery/git/scanner.test.ts
```

Expected: FAIL with an import error for `./scanner.js`.

- [ ] **Step 3: Implement the path-scoped scanner**

Create `packages/agent-bridge/src/discovery/git/scanner.ts`:

```ts
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalPath, expandHome, isDirectory, isMissingPathError } from '../paths.js'
import { inspectGitRepositoryPath, readRegisteredWorktrees } from './metadata.js'
import type {
  FindGitWorktreesResult,
  GitDiscoveryDiagnostic,
  GitRepositorySummary,
  ScanGitRepositoriesAtPathOptions,
  ScanGitRepositoriesOptions,
  ScanGitRepositoriesResult,
} from './types.js'

export const defaultGitIgnoredDirectoryNames: readonly string[] = [
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
]

type WalkItem = {
  path: string
  depth: number
}

export async function scanGitRepositoriesAtPath(
  path: string,
  options: ScanGitRepositoriesAtPathOptions = {},
): Promise<ScanGitRepositoriesResult> {
  const homeDir = options.homeDir ?? process.env.HOME ?? process.cwd()
  const expanded = expandHome(path, homeDir)
  const diagnostics: GitDiscoveryDiagnostic[] = []
  const root = await canonicalPath(expanded)

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

  return await scanCanonicalRoots([root], {
    maxDepth: options.maxDepth,
    concurrency: options.concurrency,
    ignoredDirectoryNames: options.ignoredDirectoryNames,
    diagnostics,
  })
}

export async function scanGitRepositories(
  options: ScanGitRepositoriesOptions = {},
): Promise<ScanGitRepositoriesResult> {
  const homeDir = options.homeDir ?? process.env.HOME ?? process.cwd()
  const requestedRoots = [
    ...(options.includeHome ?? true ? [homeDir] : []),
    ...(options.roots ?? []),
  ]
  const diagnostics: GitDiscoveryDiagnostic[] = []
  const roots: string[] = []
  const seenRoots = new Set<string>()

  for (const requestedRoot of requestedRoots) {
    const expanded = expandHome(requestedRoot, homeDir)
    const root = await canonicalPath(expanded)
    if (seenRoots.has(root)) continue
    seenRoots.add(root)
    if (!(await isDirectory(root))) {
      diagnostics.push({
        severity: 'warning',
        path: root,
        message: 'Git scan root is not a directory',
      })
      continue
    }
    roots.push(root)
  }

  return await scanCanonicalRoots(roots, {
    maxDepth: options.maxDepth,
    concurrency: options.concurrency,
    ignoredDirectoryNames: options.ignoredDirectoryNames,
    diagnostics,
  })
}

export async function findGitWorktrees(_repoPath: string): Promise<FindGitWorktreesResult> {
  throw new Error('findGitWorktrees is added in Task 4')
}

async function scanCanonicalRoots(
  roots: readonly string[],
  options: {
    maxDepth: number | undefined
    concurrency: number | undefined
    ignoredDirectoryNames: readonly string[] | undefined
    diagnostics: GitDiscoveryDiagnostic[]
  },
): Promise<ScanGitRepositoriesResult> {
  const repositories: GitRepositorySummary[] = []
  const queue: WalkItem[] = roots.map((path) => ({ path, depth: 0 }))
  const seenDirectories = new Set<string>()
  const ignoredNames = new Set(options.ignoredDirectoryNames ?? defaultGitIgnoredDirectoryNames)
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY
  const workerCount = Math.max(1, options.concurrency ?? 16)

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift()
      if (!item) return
      if (seenDirectories.has(item.path)) continue
      seenDirectories.add(item.path)

      const inspected = await inspectGitRepositoryPath(item.path)
      options.diagnostics.push(...inspected.diagnostics)
      if (inspected.repository) {
        const worktrees = await readRegisteredWorktrees(inspected.repository.commonGitDir)
        options.diagnostics.push(...worktrees.diagnostics)
        repositories.push({
          ...inspected.repository,
          ...(worktrees.worktrees.length > 0 ? { worktrees: worktrees.worktrees } : {}),
        })
        continue
      }

      if (item.depth >= maxDepth) continue

      let entries: import('node:fs').Dirent[]
      try {
        entries = (await readdir(item.path, { withFileTypes: true })).sort(compareDirents)
      } catch (cause) {
        if (!isMissingPathError(cause)) {
          options.diagnostics.push({
            severity: 'warning',
            path: item.path,
            message: 'Could not read Git scan directory',
            cause,
          })
        }
        continue
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (ignoredNames.has(entry.name)) continue
        queue.push({ path: join(item.path, entry.name), depth: item.depth + 1 })
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  return {
    repositories: dedupeRepositories(repositories).sort(compareRepositories),
    diagnostics: options.diagnostics,
  }
}

function dedupeRepositories(
  repositories: readonly GitRepositorySummary[],
): GitRepositorySummary[] {
  const byKey = new Map<string, GitRepositorySummary>()
  for (const repository of repositories) {
    const key = `${repository.commonGitDir}\0${repository.path}`
    if (!byKey.has(key)) byKey.set(key, repository)
  }
  return [...byKey.values()]
}

function compareRepositories(
  left: GitRepositorySummary,
  right: GitRepositorySummary,
): number {
  return compareStrings(left.path, right.path)
}

function compareDirents(left: { name: string }, right: { name: string }): number {
  return compareStrings(left.name, right.name)
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
```

- [ ] **Step 4: Run scanner tests and verify Task 3 passes**

Run:

```bash
bun test packages/agent-bridge/src/discovery/git/scanner.test.ts
```

Expected: PASS for explicit path scanning, pruning, symlink-root canonicalization, and max-depth behavior.

- [ ] **Step 5: Commit Task 3**

Run:

```bash
git add packages/agent-bridge/src/discovery/git/scanner.ts packages/agent-bridge/src/discovery/git/scanner.test.ts
git commit -m "feat(agent-bridge): scan git repositories by path"
```

---

## Task 4: Default Home Scan, Direct Worktree Lookup, And Public Exports

**Files:**
- Create: `packages/agent-bridge/src/discovery/git/index.ts`
- Modify: `packages/agent-bridge/src/discovery/git/scanner.ts`
- Modify: `packages/agent-bridge/src/discovery/git/scanner.test.ts`
- Modify: `packages/agent-bridge/src/discovery/index.ts`

- [ ] **Step 1: Add failing tests for default scan, direct worktree lookup, and barrel exports**

Append these tests to `packages/agent-bridge/src/discovery/git/scanner.test.ts`:

```ts
import { findGitWorktrees, scanGitRepositories } from './scanner.js'

test('scanGitRepositories scans the supplied home directory by default', async () => {
  const homeDir = await createTempRoot()
  const repo = await writeNormalRepo(join(homeDir, 'src'), 'podium')

  const result = await scanGitRepositories({ homeDir })

  expect(result.diagnostics).toEqual([])
  expect(result.repositories.map((repository) => repository.path)).toEqual([repo])
})

test('scanGitRepositories can scan explicit roots without the home directory', async () => {
  const homeDir = await createTempRoot()
  await writeNormalRepo(homeDir, 'home-repo')
  const extra = await createTempRoot()
  const extraRepo = await writeNormalRepo(extra, 'extra-repo')

  const result = await scanGitRepositories({ homeDir, includeHome: false, roots: [extra] })

  expect(result.repositories.map((repository) => repository.path)).toEqual([extraRepo])
})

test('findGitWorktrees returns registered worktrees from the main repository path', async () => {
  const root = await createTempRoot()
  const { main, worktree } = await writeLinkedWorktree(root)

  const result = await findGitWorktrees(main)

  expect(result.diagnostics).toEqual([])
  expect(result.repository).toEqual(expect.objectContaining({ path: main, kind: 'repository' }))
  expect(result.worktrees).toEqual([
    expect.objectContaining({ path: worktree, branch: 'feature', headSha: featureSha }),
  ])
})

test('findGitWorktrees resolves siblings when called from a linked worktree path', async () => {
  const root = await createTempRoot()
  const { main, worktree } = await writeLinkedWorktree(root)

  const result = await findGitWorktrees(worktree)

  expect(result.repository).toEqual(expect.objectContaining({ path: main, kind: 'repository' }))
  expect(result.worktrees.map((summary) => summary.path)).toEqual([worktree])
})

test('findGitWorktrees rejects paths that are not repositories', async () => {
  const root = await createTempRoot()
  const plain = join(root, 'plain')
  await mkdir(plain)

  await expect(findGitWorktrees(plain)).rejects.toThrow('Path is not a Git repository')
})
```

Fix the existing scanner test import so there is only one import from `./scanner.js`:

```ts
import { findGitWorktrees, scanGitRepositories, scanGitRepositoriesAtPath } from './scanner.js'
```

Create `packages/agent-bridge/src/discovery/git/index.ts`:

```ts
export {
  defaultGitIgnoredDirectoryNames,
  findGitWorktrees,
  scanGitRepositories,
  scanGitRepositoriesAtPath,
} from './scanner.js'
export type * from './types.js'
```

Add this export to `packages/agent-bridge/src/discovery/index.ts`:

```ts
export * from './git/index.js'
```

- [ ] **Step 2: Run scanner tests and verify the new tests fail**

Run:

```bash
bun test packages/agent-bridge/src/discovery/git/scanner.test.ts
```

Expected: FAIL because `findGitWorktrees` still throws and `scanGitRepositories` does not yet add linked worktree summaries to broad scan output.

- [ ] **Step 3: Implement direct worktree lookup and include registered worktrees in scan output**

Modify `packages/agent-bridge/src/discovery/git/scanner.ts`.

Replace the temporary `findGitWorktrees` body with:

```ts
export async function findGitWorktrees(repoPath: string): Promise<FindGitWorktreesResult> {
  const inspected = await inspectGitRepositoryPath(repoPath)
  if (!inspected.repository) {
    throw new Error(`Path is not a Git repository: ${repoPath}`)
  }

  const registered = await readRegisteredWorktrees(inspected.repository.commonGitDir)
  const diagnostics = [...inspected.diagnostics, ...registered.diagnostics]
  const repository = await resolveMainRepositorySummary(inspected.repository, registered.worktrees)

  return {
    repository: {
      ...repository,
      ...(registered.worktrees.length > 0 ? { worktrees: registered.worktrees } : {}),
    },
    worktrees: registered.worktrees,
    diagnostics,
  }
}
```

In `scanCanonicalRoots`, replace the repository push block with:

```ts
        const worktrees = await readRegisteredWorktrees(inspected.repository.commonGitDir)
        options.diagnostics.push(...worktrees.diagnostics)
        repositories.push({
          ...inspected.repository,
          ...(worktrees.worktrees.length > 0 ? { worktrees: worktrees.worktrees } : {}),
        })
        repositories.push(...worktrees.worktrees.map(worktreeToRepositorySummary))
        continue
```

Add these helpers:

```ts
async function resolveMainRepositorySummary(
  repository: GitRepositorySummary,
  worktrees: readonly GitWorktreeSummary[],
): Promise<GitRepositorySummary> {
  if (repository.kind !== 'worktree') return repository
  if (!repository.mainWorktreePath) return repository

  const inspectedMain = await inspectGitRepositoryPath(repository.mainWorktreePath)
  if (inspectedMain.repository) return inspectedMain.repository

  return {
    path: repository.mainWorktreePath,
    kind: 'repository',
    gitDir: repository.commonGitDir,
    commonGitDir: repository.commonGitDir,
    mainWorktreePath: repository.mainWorktreePath,
    worktrees: [...worktrees],
  }
}

function worktreeToRepositorySummary(worktree: GitWorktreeSummary): GitRepositorySummary {
  return {
    path: worktree.path,
    kind: 'worktree',
    gitDir: worktree.gitDir,
    commonGitDir: worktree.commonGitDir,
    branch: worktree.branch,
    headSha: worktree.headSha,
  }
}
```

- [ ] **Step 4: Run scanner tests and verify they pass**

Run:

```bash
bun test packages/agent-bridge/src/discovery/git/scanner.test.ts
```

Expected: PASS for explicit scans, default home scan, and direct worktree lookup.

- [ ] **Step 5: Run all Git discovery tests**

Run:

```bash
bun test packages/agent-bridge/src/discovery/git
```

Expected: PASS for `metadata.test.ts` and `scanner.test.ts`.

- [ ] **Step 6: Commit Task 4**

Run:

```bash
git add packages/agent-bridge/src/discovery/index.ts packages/agent-bridge/src/discovery/git/index.ts packages/agent-bridge/src/discovery/git/scanner.ts packages/agent-bridge/src/discovery/git/scanner.test.ts
git commit -m "feat(agent-bridge): expose git worktree discovery"
```

---

## Task 5: Typecheck, Build, And Final Verification

**Files:**
- Inspect only unless verification reveals a real compile or lint issue.

- [ ] **Step 1: Run the package typecheck**

Run:

```bash
bun run --filter @podium/agent-bridge typecheck
```

Expected: PASS with `tsc --noEmit`.

- [ ] **Step 2: Run the package build**

Run:

```bash
bun run --filter @podium/agent-bridge build
```

Expected: PASS with `tsup` producing `dist`.

- [ ] **Step 3: Run the full test suite**

Run:

```bash
bun run test
```

Expected: PASS for all repository tests.

- [ ] **Step 4: Run lint**

Run:

```bash
bun run lint
```

Expected: PASS with Biome reporting no errors.

- [ ] **Step 5: Commit verification-driven fixes if any were required**

Only run this step if Steps 1-4 required source edits:

```bash
git add packages/agent-bridge/src/discovery/git packages/agent-bridge/src/discovery/index.ts
git commit -m "fix(agent-bridge): polish git discovery verification"
```

- [ ] **Step 6: Record final evidence**

Run:

```bash
git status --short
```

Expected: no uncommitted source changes from this implementation. Untracked build artifacts should be removed only if they were created by the build and are not ignored.
