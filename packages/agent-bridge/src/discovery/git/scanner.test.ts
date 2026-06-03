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
    expect(result.repositories).toHaveLength(1)
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
})
