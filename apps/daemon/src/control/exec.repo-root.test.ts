/**
 * POD-7503: the git panel and file search name a folder by the caller's text, and
 * the server matches it to a registered repository as text. A symlink inside the
 * repository passes that match while pointing at another checkout, so a repo op
 * that names its repository is checked on disk here, and git runs in the
 * resolved folder.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import type { DaemonContext } from './context'
import { execHandlers } from './exec'

type RepoOpRequest = Extract<ControlMessage, { type: 'repoOpRequest' }>

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  })
}

async function checkout(dir: string, file: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  git(dir, 'init', '-q')
  await writeFile(join(dir, file), text)
  git(dir, 'add', file)
  git(dir, 'commit', '-qm', `add ${file}`)
}

async function machine() {
  const base = await mkdtemp(join(tmpdir(), 'podium-repo-op-root-'))
  const repoRoot = join(base, 'repo')
  const other = join(base, 'other-checkout')
  await checkout(repoRoot, 'inside.txt', 'inside')
  await checkout(other, 'private-plan.txt', 'private')
  await mkdir(join(repoRoot, 'src'))
  await writeFile(join(repoRoot, 'src', 'nested.txt'), 'nested')
  git(repoRoot, 'add', 'src/nested.txt')
  git(repoRoot, 'commit', '-qm', 'add src/nested.txt')
  await symlink(other, join(repoRoot, 'escape'))
  return { repoRoot, other, link: join(repoRoot, 'escape') }
}

async function run(msg: Omit<RepoOpRequest, 'type' | 'requestId'>) {
  const sent: Array<{ ok: boolean; output: string }> = []
  const ctx = { send: (m: { ok: boolean; output: string }) => sent.push(m) }
  execHandlers.repoOpRequest(ctx as unknown as DaemonContext, {
    type: 'repoOpRequest',
    requestId: 'r',
    ...msg,
  })
  await expect.poll(() => sent.length, { timeout: 10_000 }).toBe(1)
  return sent[0] as { ok: boolean; output: string }
}

describe.skipIf(process.platform === 'win32')('a repo op that names its repository', () => {
  it('runs git in another checkout through a symlinked folder only without the check', async () => {
    const { link } = await machine()
    // The hole: without the repository the daemon lists the other checkout.
    expect(await run({ op: 'lsFiles', cwd: link })).toMatchObject({
      ok: true,
      output: expect.stringContaining('private-plan.txt'),
    })
  })

  it.each([
    ['lsFiles', undefined],
    ['logPanel', undefined],
    ['statusProbe', undefined],
    ['diffFile', { path: 'private-plan.txt' }],
  ] as const)('refuses %s through a symlinked folder', async (op, args) => {
    const { repoRoot, link } = await machine()
    const r = await run({ op, cwd: link, repoRoot, ...(args ? { args: { ...args } } : {}) })
    expect(r).toEqual(expect.objectContaining({ ok: false, output: 'outside repository' }))
  })

  it('serves the repository and a real folder inside it, from the resolved path', async () => {
    const { repoRoot } = await machine()
    // ls-files lists the folder it runs in: the whole repository, or one folder.
    for (const [cwd, listed] of [
      [repoRoot, 'inside.txt'],
      [join(repoRoot, 'src'), 'nested.txt'],
    ] as const) {
      const r = await run({ op: 'lsFiles', cwd, repoRoot })
      expect(r.ok).toBe(true)
      expect(r.output).toContain(listed)
      expect(r.output).not.toContain('private-plan.txt')
    }
  })

  it('compares realpaths: a repository registered through a symlink still serves', async () => {
    const { repoRoot } = await machine()
    const alias = join(await realpath(join(repoRoot, '..')), 'alias')
    await symlink(repoRoot, alias)
    expect(await run({ op: 'lsFiles', cwd: join(alias, 'src'), repoRoot })).toMatchObject({
      ok: true,
    })
  })

  it('refuses a folder or repository that does not resolve', async () => {
    const { repoRoot } = await machine()
    expect(await run({ op: 'lsFiles', cwd: join(repoRoot, 'gone'), repoRoot })).toEqual(
      expect.objectContaining({ ok: false, output: 'not found' }),
    )
    expect(
      await run({ op: 'lsFiles', cwd: repoRoot, repoRoot: join(repoRoot, '..', 'gone') }),
    ).toEqual(expect.objectContaining({ ok: false, output: 'repository not found' }))
  })
})
