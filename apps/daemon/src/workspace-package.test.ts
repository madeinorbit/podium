import { execFileSync } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanWorkspacePeeks,
  exportWorkspaceSnapshot,
  importWorkspaceSnapshot,
} from './workspace-package'

const roots: string[] = []
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
async function repo(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `podium-${name}-`))
  roots.push(path)
  git(path, 'init', '-b', 'main')
  git(path, 'config', 'user.email', 'test@podium.local')
  git(path, 'config', 'user.name', 'Podium Test')
  await writeFile(join(path, 'tracked.txt'), 'base\n')
  git(path, 'add', '.')
  git(path, 'commit', '-m', 'base')
  return path
}
async function home(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `podium-home-${name}-`))
  roots.push(path)
  return path
}
async function stageFor(exported: { stagePath: string }, fetcherHome: string, fetchId: string) {
  const stage = join(fetcherHome, '.podium', 'handoff', `${fetchId}.tgz`)
  await mkdir(dirname(stage), { recursive: true })
  await copyFile(exported.stagePath, stage)
}
afterEach(() => {
  for (const root of roots.splice(0)) execFileSync('rm', ['-rf', root])
})

describe('workspace package', () => {
  it('fetch materializes unpushed commits + dirty + untracked state, source untouched', async () => {
    const source = await repo('ws-source')
    const base = git(source, 'rev-parse', 'HEAD')
    const fetcher = await mkdtemp(join(tmpdir(), 'podium-ws-fetcher-'))
    roots.push(fetcher)
    execFileSync('git', ['clone', source, fetcher])
    git(source, 'checkout', '-b', 'issue/ws')
    await writeFile(join(source, 'branch.txt'), 'unpushed commit\n')
    git(source, 'add', '.')
    git(source, 'commit', '-m', 'unpushed')
    await writeFile(join(source, 'tracked.txt'), 'dirty\n')
    await writeFile(join(source, 'untracked.txt'), 'untracked\n')
    const sourceStatus = git(source, 'status', '--porcelain')
    const sourceHead = git(source, 'rev-parse', 'HEAD')

    const sourceHome = await home('ws-source')
    const fetcherHome = await home('ws-fetcher')
    const exported = await exportWorkspaceSnapshot({
      fetchId: 'ws-e2e',
      cwd: source,
      baseShas: [base],
      repoId: 'repo',
      sourceMachineId: 'source-machine',
      homeDir: sourceHome,
    })
    expect(exported.manifest.branch).toBe('issue/ws')
    expect(exported.manifest.snapshotSha).toBeTruthy()
    // Source is untouched: same HEAD, same dirty status, no leftover refs.
    expect(git(source, 'rev-parse', 'HEAD')).toBe(sourceHead)
    expect(git(source, 'status', '--porcelain')).toBe(sourceStatus)
    expect(git(source, 'for-each-ref', 'refs/podium/')).toBe('')

    await stageFor(exported, fetcherHome, 'ws-e2e')
    const imported = await importWorkspaceSnapshot({
      fetchId: 'ws-e2e',
      repoPath: fetcher,
      homeDir: fetcherHome,
    })
    expect(imported.path).toContain('.worktrees/.peek/')
    expect(await readFile(join(imported.path, 'branch.txt'), 'utf8')).toBe('unpushed commit\n')
    expect(await readFile(join(imported.path, 'tracked.txt'), 'utf8')).toBe('dirty\n')
    expect(await readFile(join(imported.path, 'untracked.txt'), 'utf8')).toBe('untracked\n')
    // Detached peek: no branch created or moved on the fetcher, no leftover refs,
    // no leftover stage archive.
    expect(git(imported.path, 'branch', '--show-current')).toBe('')
    expect(git(fetcher, 'for-each-ref', 'refs/heads/issue/ws')).toBe('')
    expect(git(fetcher, 'for-each-ref', 'refs/podium/')).toBe('')
    await expect(access(join(fetcherHome, '.podium', 'handoff', 'ws-e2e.tgz'))).rejects.toThrow()

    const removed = await cleanWorkspacePeeks(fetcher)
    expect(removed).toEqual([imported.path])
    await expect(access(imported.path)).rejects.toThrow()
  })

  it('ships a clean tree with unpushed commits (no snapshot) via the ref bundle', async () => {
    const source = await repo('ws-clean')
    const base = git(source, 'rev-parse', 'HEAD')
    const fetcher = await mkdtemp(join(tmpdir(), 'podium-ws-clean-fetcher-'))
    roots.push(fetcher)
    execFileSync('git', ['clone', source, fetcher])
    git(source, 'checkout', '-b', 'issue/clean')
    await writeFile(join(source, 'commit.txt'), 'committed only\n')
    git(source, 'add', '.')
    git(source, 'commit', '-m', 'clean tip')

    const sourceHome = await home('ws-clean')
    const fetcherHome = await home('ws-clean-fetcher')
    const exported = await exportWorkspaceSnapshot({
      fetchId: 'ws-clean',
      cwd: source,
      baseShas: [base],
      repoId: 'repo',
      sourceMachineId: 'source-machine',
      homeDir: sourceHome,
    })
    expect(exported.manifest.snapshotSha).toBeNull()
    expect(git(source, 'for-each-ref', 'refs/podium/')).toBe('')
    await stageFor(exported, fetcherHome, 'ws-clean')
    const imported = await importWorkspaceSnapshot({
      fetchId: 'ws-clean',
      repoPath: fetcher,
      homeDir: fetcherHome,
    })
    expect(await readFile(join(imported.path, 'commit.txt'), 'utf8')).toBe('committed only\n')
    expect(git(imported.path, 'rev-parse', 'HEAD')).toBe(exported.manifest.headSha)
  })

  it('imports a dirty-only snapshot whose branch tip sits on a shared base', async () => {
    const source = await repo('ws-dirty-only')
    const base = git(source, 'rev-parse', 'HEAD')
    const fetcher = await mkdtemp(join(tmpdir(), 'podium-ws-dirty-fetcher-'))
    roots.push(fetcher)
    execFileSync('git', ['clone', source, fetcher])
    await writeFile(join(source, 'untracked.txt'), 'dirty only\n')

    const sourceHome = await home('ws-dirty')
    const fetcherHome = await home('ws-dirty-fetcher')
    const exported = await exportWorkspaceSnapshot({
      fetchId: 'ws-dirty',
      cwd: source,
      baseShas: [base],
      repoId: 'repo',
      sourceMachineId: 'source-machine',
      homeDir: sourceHome,
    })
    expect(exported.manifest.snapshotSha).toBeTruthy()
    await stageFor(exported, fetcherHome, 'ws-dirty')
    const imported = await importWorkspaceSnapshot({
      fetchId: 'ws-dirty',
      repoPath: fetcher,
      homeDir: fetcherHome,
    })
    expect(await readFile(join(imported.path, 'untracked.txt'), 'utf8')).toBe('dirty only\n')
  })

  it('refuses export when no base is shared', async () => {
    const source = await repo('ws-nobase')
    const sourceHome = await home('ws-nobase')
    await expect(
      exportWorkspaceSnapshot({
        fetchId: 'ws-nobase',
        cwd: source,
        baseShas: ['1234567890abcdef1234567890abcdef12345678'],
        repoId: 'repo',
        sourceMachineId: 'source-machine',
        homeDir: sourceHome,
      }),
    ).rejects.toThrow(/no bundle base shared/)
    expect(git(source, 'for-each-ref', 'refs/podium/')).toBe('')
  })
})
