import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { inspectGitRepositoryPath, readRegisteredWorktrees } from './metadata.js'

const mainSha = '1111111111111111111111111111111111111111'
const featureSha = '2222222222222222222222222222222222222222'

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

  test('keeps branch but rejects loose branch ref with trailing whitespace after SHA', async () => {
    const root = await createTempRoot()
    const repo = await writeNormalRepo(root)
    await writeFile(join(repo, '.git', 'refs', 'heads', 'main'), `${mainSha} \n`)

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

  test('keeps branch but rejects loose branch ref with leading whitespace before SHA', async () => {
    const root = await createTempRoot()
    const repo = await writeNormalRepo(root)
    await writeFile(join(repo, '.git', 'refs', 'heads', 'main'), ` ${mainSha}\n`)

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

  test('skips stale registered worktrees whose target git file is missing', async () => {
    const root = await createTempRoot()
    const repo = await writeNormalRepo(root)
    const commonGitDir = join(repo, '.git')
    const staleAdminDir = join(commonGitDir, 'worktrees', 'stale')
    const staleGitFile = join(root, 'missing-worktree', '.git')
    const staleGitdir = join(staleAdminDir, 'gitdir')
    await mkdir(staleAdminDir, { recursive: true })
    await writeFile(staleGitdir, `${staleGitFile}\n`)
    await writeFile(join(staleAdminDir, 'HEAD'), 'ref: refs/heads/main\n')

    const result = await readRegisteredWorktrees(commonGitDir)

    expect(result.worktrees).toEqual([])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        path: staleGitdir,
        message: 'Git worktree target is missing',
      }),
    ])
  })

  test('skips registered worktrees whose target git path is not a pointer file', async () => {
    const root = await createTempRoot()
    const repo = await writeNormalRepo(root)
    const commonGitDir = join(repo, '.git')
    const adminDir = join(commonGitDir, 'worktrees', 'not-pointer')
    const targetGitDir = join(root, 'not-pointer', '.git')
    const gitdir = join(adminDir, 'gitdir')
    await mkdir(adminDir, { recursive: true })
    await mkdir(targetGitDir, { recursive: true })
    await writeFile(gitdir, `${targetGitDir}\n`)
    await writeFile(join(adminDir, 'HEAD'), 'ref: refs/heads/main\n')

    const result = await readRegisteredWorktrees(commonGitDir)

    expect(result.worktrees).toEqual([])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        path: gitdir,
        message: 'Git worktree target is not a pointer file',
      }),
    ])
  })

  test('skips registered worktrees whose target pointer does not point back to registration', async () => {
    const root = await createTempRoot()
    const repo = await writeNormalRepo(root)
    const commonGitDir = join(repo, '.git')
    const adminDir = join(commonGitDir, 'worktrees', 'wrong-pointer')
    const otherAdminDir = join(root, 'other-admin')
    const worktree = join(root, 'wrong-pointer')
    const gitdir = join(adminDir, 'gitdir')
    await mkdir(adminDir, { recursive: true })
    await mkdir(otherAdminDir, { recursive: true })
    await mkdir(worktree, { recursive: true })
    await writeFile(join(worktree, '.git'), `gitdir: ${otherAdminDir}\n`)
    await writeFile(gitdir, `${join(worktree, '.git')}\n`)
    await writeFile(join(adminDir, 'HEAD'), 'ref: refs/heads/main\n')

    const result = await readRegisteredWorktrees(commonGitDir)

    expect(result.worktrees).toEqual([])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        path: gitdir,
        message: 'Git worktree target does not point back to registration',
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

  test('does not treat a non-bare repository admin directory as a bare repository', async () => {
    const root = await createTempRoot()
    const repo = await writeNormalRepo(root)
    await writeFile(join(repo, '.git', 'config'), '[core]\n\tbare = false\n')

    const result = await inspectGitRepositoryPath(join(repo, '.git'))

    expect(result.repository).toBeUndefined()
    expect(result.diagnostics).toEqual([])
  })

  test('parses core bare config after a commented section header', async () => {
    const root = await createTempRoot()
    const repo = await writeNormalRepo(root)
    await writeFile(join(repo, '.git', 'config'), '[core] # comment\n\tbare = false\n')

    const result = await inspectGitRepositoryPath(join(repo, '.git'))

    expect(result.repository).toBeUndefined()
    expect(result.diagnostics).toEqual([])
  })

  test('treats a bare core config key without assignment as true', async () => {
    const root = await createTempRoot()
    const bare = await writeBareRepo(root)
    await writeFile(join(bare, 'config'), '[core]\n\tbare = false\n\tbare\n')

    const result = await inspectGitRepositoryPath(bare)

    expect(result.diagnostics).toEqual([])
    expect(result.repository).toEqual(
      expect.objectContaining({
        path: bare,
        kind: 'bare',
        gitDir: bare,
        commonGitDir: bare,
      }),
    )
  })

  test('continues bare detection with diagnostics when bare config cannot be read', async () => {
    const root = await createTempRoot()
    const bare = await writeBareRepo(root)
    await mkdir(join(bare, 'config'))

    const result = await inspectGitRepositoryPath(bare)

    expect(result.repository).toEqual(
      expect.objectContaining({
        path: bare,
        kind: 'bare',
        gitDir: bare,
        commonGitDir: bare,
      }),
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        path: join(bare, 'config'),
        message: 'Could not read git config metadata',
      }),
    ])
  })

  test('uses the last recognized core bare config value', async () => {
    const root = await createTempRoot()
    const repo = await writeNormalRepo(root)
    await writeFile(join(repo, '.git', 'config'), '[core]\n\tbare = true\n\tbare = false\n')

    const result = await inspectGitRepositoryPath(join(repo, '.git'))

    expect(result.repository).toBeUndefined()
    expect(result.diagnostics).toEqual([])
  })

  test.each([
    '[core]\n\tbare = false # comment\n',
    '[core]\n\tbare = false ; comment\n',
    '[core]\n\tbare = "false"\n',
    '[core]\n\tbare =\n',
  ])('does not treat git admin dirs with false bare config form %# as bare', async (config) => {
    const root = await createTempRoot()
    const repo = await writeNormalRepo(root)
    await writeFile(join(repo, '.git', 'config'), config)

    const result = await inspectGitRepositoryPath(join(repo, '.git'))

    expect(result.repository).toBeUndefined()
    expect(result.diagnostics).toEqual([])
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

  test('reports missing .git pointer targets as diagnostics', async () => {
    const root = await createTempRoot()
    const worktree = join(root, 'stale-pointer')
    await mkdir(worktree)
    await writeFile(join(worktree, '.git'), 'gitdir: ../missing-admin\n')

    const result = await inspectGitRepositoryPath(worktree)

    expect(result.repository).toBeUndefined()
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        path: join(worktree, '.git'),
        message: 'Git pointer target is missing',
      }),
    ])
  })
})
