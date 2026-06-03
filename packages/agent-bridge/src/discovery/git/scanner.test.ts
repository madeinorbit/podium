import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import * as scanner from './scanner.js'

const { scanGitRepositoriesAtPath } = scanner

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

async function writeRepoWithStaleRegisteredWorktree(root: string): Promise<{
  repo: string
  staleGitdir: string
}> {
  const repo = await writeNormalRepo(root, 'repo')
  const staleAdminDir = join(repo, '.git', 'worktrees', 'stale')
  const staleGitdir = join(staleAdminDir, 'gitdir')
  await mkdir(staleAdminDir, { recursive: true })
  await writeFile(staleGitdir, `${join(root, 'missing-worktree', '.git')}\n`)
  await writeFile(join(staleAdminDir, 'HEAD'), 'ref: refs/heads/main\n')
  return { repo, staleGitdir }
}

describe('scanGitRepositories', () => {
  test('scans the provided home directory by default', async () => {
    const home = await createTempRoot()
    const repo = await writeNormalRepo(join(home, 'projects'), 'repo')

    const result = await scanner.scanGitRepositories({ homeDir: home })

    expect(result.diagnostics).toEqual([])
    expect(result.repositories.map((repository) => repository.path)).toEqual([repo])
  })

  test('scans explicit roots when home is excluded', async () => {
    const home = await createTempRoot()
    await writeNormalRepo(home, 'ignored-home-repo')
    const root = await createTempRoot()
    const repo = await writeNormalRepo(root, 'repo')

    const result = await scanner.scanGitRepositories({
      roots: [root],
      homeDir: home,
      includeHome: false,
    })

    expect(result.diagnostics).toEqual([])
    expect(result.repositories.map((repository) => repository.path)).toEqual([repo])
  })

  test('returns empty when home excluded and no roots are provided', async () => {
    const result = await scanner.scanGitRepositories({ includeHome: false })

    expect(result).toEqual({ repositories: [], diagnostics: [] })
  })

  test('dedupes equivalent explicit home and default home roots before scanning', async () => {
    const home = await createTempRoot()
    const { repo, staleGitdir } = await writeRepoWithStaleRegisteredWorktree(home)

    const result = await scanner.scanGitRepositories({ roots: [home], homeDir: home })

    expect(result.repositories.map((repository) => repository.path)).toEqual([repo])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        path: staleGitdir,
        message: 'Git worktree target is missing',
      }),
    ])
  })
})

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

  test('continues scanning when a child directory cannot be inspected', async () => {
    const root = await createTempRoot()
    const locked = join(root, 'locked')
    await mkdir(locked)
    const visible = await writeNormalRepo(root, 'visible')
    await chmod(locked, 0)

    let result: Awaited<ReturnType<typeof scanGitRepositoriesAtPath>>
    try {
      result = await scanGitRepositoriesAtPath(root)
    } finally {
      await chmod(locked, 0o700).catch(() => {})
    }

    expect(result.repositories.map((repo) => repo.path)).toEqual([visible])
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        path: locked,
        message: 'Could not inspect Git scan directory',
      }),
    )
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

  test('warns and returns no repositories when the root is not a directory', async () => {
    const root = await createTempRoot()
    const file = join(root, 'not-directory')
    await writeFile(file, 'content\n')

    const result = await scanGitRepositoriesAtPath(file)

    expect(result.repositories).toEqual([])
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        path: file,
        message: 'Git scan root is not a directory',
      },
    ])
  })

  test('warns and returns no repositories when the scan root cannot be resolved', async () => {
    const root = await createTempRoot()
    const locked = join(root, 'locked')
    const child = join(locked, 'child')
    await mkdir(locked)
    await chmod(locked, 0)

    let result: Awaited<ReturnType<typeof scanGitRepositoriesAtPath>>
    try {
      result = await scanGitRepositoriesAtPath(child)
    } finally {
      await chmod(locked, 0o700).catch(() => {})
    }

    expect(result).toEqual({
      repositories: [],
      diagnostics: [
        expect.objectContaining({
          severity: 'warning',
          path: child,
          message: 'Could not resolve Git scan root',
        }),
      ],
    })
  })

  test('expands home-relative roots against the provided home directory', async () => {
    const home = await createTempRoot()
    const repo = await writeNormalRepo(join(home, 'projects'), 'repo')

    const result = await scanGitRepositoriesAtPath('~/projects', { homeDir: home })

    expect(result.diagnostics).toEqual([])
    expect(result.repositories.map((repository) => repository.path)).toEqual([repo])
  })

  test('uses custom ignored directory names', async () => {
    const root = await createTempRoot()
    await writeNormalRepo(join(root, 'skip-me'), 'hidden')
    const visible = await writeNormalRepo(join(root, 'node_modules'), 'visible')

    const result = await scanGitRepositoriesAtPath(root, {
      ignoredDirectoryNames: ['skip-me'],
    })

    expect(result.repositories.map((repository) => repository.path)).toEqual([visible])
  })

  test('attaches registered worktrees to discovered repositories', async () => {
    const root = await createTempRoot()
    const { main, worktree } = await writeLinkedWorktree(root)

    const result = await scanGitRepositoriesAtPath(main)

    expect(result.diagnostics).toEqual([])
    expect(result.repositories).toHaveLength(2)
    expect(result.repositories[0]).toEqual(
      expect.objectContaining({
        path: main,
        worktrees: [
          expect.objectContaining({
            path: worktree,
            branch: 'feature',
            headSha: featureSha,
          }),
        ],
      }),
    )
  })

  test('includes registered worktrees as separate summaries and attached worktrees', async () => {
    const root = await createTempRoot()
    const { main, worktree } = await writeLinkedWorktree(root)

    const result = await scanGitRepositoriesAtPath(main)

    expect(result.diagnostics).toEqual([])
    expect(result.repositories.map((repository) => repository.path)).toEqual([main, worktree])
    expect(result.repositories).toEqual([
      expect.objectContaining({
        path: main,
        kind: 'repository',
        worktrees: [
          expect.objectContaining({
            path: worktree,
            branch: 'feature',
            headSha: featureSha,
          }),
        ],
      }),
      expect.objectContaining({
        path: worktree,
        kind: 'worktree',
        gitDir: join(main, '.git', 'worktrees', 'main-feature'),
        commonGitDir: join(main, '.git'),
        mainWorktreePath: main,
        branch: 'feature',
        headSha: featureSha,
      }),
    ])
  })
})

describe('findGitWorktrees', () => {
  test('from a main repository returns repository plus all registered worktrees', async () => {
    const root = await createTempRoot()
    const { main, worktree } = await writeLinkedWorktree(root)

    const result = await scanner.findGitWorktrees(main)

    expect(result.diagnostics).toEqual([])
    expect(result.repository).toEqual(
      expect.objectContaining({
        path: main,
        kind: 'repository',
        worktrees: [
          expect.objectContaining({
            path: worktree,
            branch: 'feature',
            headSha: featureSha,
          }),
        ],
      }),
    )
    expect(result.worktrees).toEqual([
      expect.objectContaining({
        path: worktree,
        branch: 'feature',
        headSha: featureSha,
      }),
    ])
  })

  test('from a linked worktree resolves the main repository and returns all registered worktrees', async () => {
    const root = await createTempRoot()
    const { main, worktree } = await writeLinkedWorktree(root)

    const result = await scanner.findGitWorktrees(worktree)

    expect(result.diagnostics).toEqual([])
    expect(result.repository).toEqual(
      expect.objectContaining({
        path: main,
        kind: 'repository',
        worktrees: [
          expect.objectContaining({
            path: worktree,
            branch: 'feature',
            headSha: featureSha,
          }),
        ],
      }),
    )
    expect(result.worktrees).toEqual([
      expect.objectContaining({
        path: worktree,
        branch: 'feature',
        headSha: featureSha,
      }),
    ])
  })

  test('rejects a non-repository path', async () => {
    const root = await createTempRoot()
    const directory = join(root, 'plain')
    await mkdir(directory)

    await expect(scanner.findGitWorktrees(directory)).rejects.toThrow(
      `Path is not a Git repository, worktree, or bare repository: ${directory}`,
    )
  })
})

describe('git discovery barrel exports', () => {
  test('are importable from the git index', async () => {
    const git = await import('./index.js')

    expect(git.scanGitRepositoriesAtPath).toBe(scanGitRepositoriesAtPath)
    expect(git.findGitWorktrees).toBe(scanner.findGitWorktrees)
  })

  test('are importable from the discovery package barrel', async () => {
    const discovery = await import('../index.js')

    expect(discovery.scanGitRepositoriesAtPath).toBe(scanGitRepositoriesAtPath)
    expect(discovery.findGitWorktrees).toBe(scanner.findGitWorktrees)
  })
})
