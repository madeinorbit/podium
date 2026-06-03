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

  test('does not set headSha from detached HEAD with non-SHA content', async () => {
    const root = await createTempRoot()
    const repo = await writeNormalRepo(root)
    await writeFile(join(repo, '.git', 'HEAD'), 'not-a-sha\n')

    const result = await inspectGitRepositoryPath(repo)

    expect(result.repository).not.toHaveProperty('branch')
    expect(result.repository).not.toHaveProperty('headSha')
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        path: join(repo, '.git', 'HEAD'),
        message: 'Invalid git HEAD metadata',
      }),
    ])
  })

  test('keeps branch but does not set headSha from loose branch ref with non-SHA content', async () => {
    const root = await createTempRoot()
    const repo = await writeNormalRepo(root)
    await writeFile(join(repo, '.git', 'refs', 'heads', 'main'), 'not-a-sha\n')

    const result = await inspectGitRepositoryPath(repo)

    expect(result.repository).toEqual(expect.objectContaining({ branch: 'main' }))
    expect(result.repository).not.toHaveProperty('headSha')
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        path: join(repo, '.git', 'refs', 'heads', 'main'),
        message: 'Invalid git branch ref metadata',
      }),
    ])
  })

  test('does not set branch or headSha from HEAD pointing at a tag ref', async () => {
    const root = await createTempRoot()
    const repo = await writeNormalRepo(root)
    await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/tags/v1\n')

    const result = await inspectGitRepositoryPath(repo)

    expect(result.repository).not.toHaveProperty('branch')
    expect(result.repository).not.toHaveProperty('headSha')
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        path: join(repo, '.git', 'HEAD'),
        message: 'Invalid git HEAD metadata',
      }),
    ])
  })

  test('does not read normalized branch ref paths from malformed branch HEAD metadata', async () => {
    const root = await createTempRoot()
    const repo = await writeNormalRepo(root)
    await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/foo/../main\n')

    const result = await inspectGitRepositoryPath(repo)

    expect(result.repository).not.toHaveProperty('branch')
    expect(result.repository).not.toHaveProperty('headSha')
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        path: join(repo, '.git', 'HEAD'),
        message: 'Invalid git HEAD metadata',
      }),
    ])
  })

  test('does not set branch or headSha from HEAD pointing at an invalid lock ref', async () => {
    const root = await createTempRoot()
    const repo = await writeNormalRepo(root)
    await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main.lock\n')

    const result = await inspectGitRepositoryPath(repo)

    expect(result.repository).not.toHaveProperty('branch')
    expect(result.repository).not.toHaveProperty('headSha')
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        path: join(repo, '.git', 'HEAD'),
        message: 'Invalid git HEAD metadata',
      }),
    ])
  })

  test('does not set headSha from detached HEAD with 41 hex characters', async () => {
    const root = await createTempRoot()
    const repo = await writeNormalRepo(root)
    await writeFile(join(repo, '.git', 'HEAD'), `${'1'.repeat(41)}\n`)

    const result = await inspectGitRepositoryPath(repo)

    expect(result.repository).not.toHaveProperty('branch')
    expect(result.repository).not.toHaveProperty('headSha')
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        path: join(repo, '.git', 'HEAD'),
        message: 'Invalid git HEAD metadata',
      }),
    ])
  })

  test('keeps branch but does not set headSha from loose branch ref with 63 hex characters', async () => {
    const root = await createTempRoot()
    const repo = await writeNormalRepo(root)
    await writeFile(join(repo, '.git', 'refs', 'heads', 'main'), `${'1'.repeat(63)}\n`)

    const result = await inspectGitRepositoryPath(repo)

    expect(result.repository).toEqual(expect.objectContaining({ branch: 'main' }))
    expect(result.repository).not.toHaveProperty('headSha')
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        path: join(repo, '.git', 'refs', 'heads', 'main'),
        message: 'Invalid git branch ref metadata',
      }),
    ])
  })

  test('does not trim branch HEAD metadata before validation', async () => {
    const root = await createTempRoot()
    const repo = await writeNormalRepo(root)
    await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/ main\n')

    const result = await inspectGitRepositoryPath(repo)

    expect(result.repository).not.toHaveProperty('branch')
    expect(result.repository).not.toHaveProperty('headSha')
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        path: join(repo, '.git', 'HEAD'),
        message: 'Invalid git HEAD metadata',
      }),
    ])
  })
})
