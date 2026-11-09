import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { asSessionId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { Ledger } from '@podium/sync'
import { fixtureWriteScope, testLedgerWriter } from '@podium/sync/testing'
import { expect, it, vi } from 'vitest'
import { repoOpCommand } from '../../../../daemon/src/repo-op'
import type { SessionStore } from '../../store'
import { applyAfterCommit, spanOpen } from '../../store/executor/executor'
import { openTestStore } from '../../test-support/open-test-store'
import { sessionReadPorts } from '../../test-support/session-facts'
import { countStatements } from '../../test-support/statement-count'
import { type IssueDeps, IssueService } from './service'
import { issueTestPlumbing } from './service/test-plumbing'

const execFile = promisify(execFileCallback)

it('polls a real worktree without journaling checks, then journals each git change once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'podium-git-state-'))
  let store: SessionStore | undefined
  try {
    const repo = join(root, 'repo')
    const worktree = join(root, 'worktree')
    await mkdir(repo)
    let commitAt = '2026-07-20T10:00:00+00:00'
    const env = () => ({
      ...process.env,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Podium Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Podium Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      GIT_AUTHOR_DATE: commitAt,
      GIT_COMMITTER_DATE: commitAt,
    })
    const git = async (cwd: string, ...args: string[]) =>
      await execFile('git', args, { cwd, env: env() })
    await git(repo, 'init', '-b', 'main')
    await writeFile(join(repo, 'file.txt'), 'initial\n')
    await git(repo, 'add', 'file.txt')
    await git(repo, 'commit', '-m', 'Initial commit')
    await git(repo, 'worktree', 'add', '-b', 'issue/git-state', worktree, 'main')

    const db = await openTestStore(':memory:')
    store = db
    await db.repos.addRepo(repo, db.hostMachineId)
    let now = '2026-07-20T12:00:00.000Z'
    const ledger = new Ledger({
      repo: db.sync,
      now: () => Date.parse(now),
      transact: async (fn) => await db.transact(fn),
      applyCommit: { spanOpen, onCommit: applyAfterCommit },
    })
    const published = vi.fn()
    ledger.onAppended(published)
    const repoOp = vi.fn<IssueDeps['repoOp']>(async (op, cwd, args) => {
      const command = repoOpCommand(op, args)
      if ('error' in command) throw new Error(command.error)
      try {
        const { stdout } = await execFile(command.bin, command.argv, { cwd, env: env() })
        return { ok: true, output: stdout }
      } catch {
        return { ok: false, output: '' }
      }
    })
    const svc = await IssueService.create({
      store: db,
      ...sessionReadPorts(() => []),
      getSettings: async () => normalizeSettings({}),
      spawnSession: async () => ({
        sessionId: asSessionId('unused'),
        machine: 'machine-under-test',
      }),
      ...issueTestPlumbing(),
      ledger: testLedgerWriter(ledger),
      repoOp,
      now: () => now,
    })
    const { id } = await svc.crud.create(svc.reports.store.serverWriter, {
      repoPath: repo,
      title: 'Worktree git facts',
      parentBranch: 'main',
      startNow: false,
    })
    const row = await db.issues.getIssue(id)
    if (!row) throw new Error('missing fixture issue')
    await db.issues.upsertIssue(fixtureWriteScope(), {
      ...row,
      branch: 'issue/git-state',
      worktreePath: worktree,
    })
    await svc.gitWorkflow.refreshGitState(id)
    const initial = (await svc.reports.get(id))?.gitState
    expect(initial).toMatchObject({
      updatedAt: now,
      shared: false,
      branch: 'issue/git-state',
      dirtyFiles: 0,
      ahead: 0,
      lastCommitAt: commitAt,
    })
    let cursor = await ledger.cursor()
    repoOp.mockClear()
    published.mockClear()

    for (const checkedAt of ['2026-07-20T12:05:00.000Z', '2026-07-20T12:10:00.000Z']) {
      now = checkedAt
      const counts = await countStatements(db, () => svc.gitWorkflow.refreshGitState(id))
      // The existing row reads before/after git; no comparison read or publish SQL.
      expect(counts.statements, JSON.stringify([...counts.byQuery])).toBe(2)
      expect((await svc.reports.get(id))?.gitState).toEqual(initial)
    }
    expect(repoOp.mock.calls.filter(([op]) => op === 'statusProbe')).toHaveLength(2)
    expect(await ledger.changesSince(cursor)).toEqual([])
    expect(published).not.toHaveBeenCalled()

    await writeFile(join(worktree, 'file.txt'), 'changed\n')
    now = '2026-07-20T12:15:00.000Z'
    await svc.gitWorkflow.refreshGitState(id)
    expect(await ledger.changesSince(cursor)).toEqual([
      expect.objectContaining({
        entity: 'issueGitState',
        id,
        op: 'upsert',
        value: expect.objectContaining({ updatedAt: now, dirtyFiles: 1, ahead: 0 }),
      }),
    ])
    expect(published).toHaveBeenCalledTimes(1)
    cursor = await ledger.cursor()

    commitAt = '2026-07-20T12:16:00+00:00'
    await git(worktree, 'add', 'file.txt')
    await git(worktree, 'commit', '-m', 'Change the git facts')
    now = '2026-07-20T12:20:00.000Z'
    await svc.gitWorkflow.refreshGitState(id)
    expect(await ledger.changesSince(cursor)).toEqual([
      expect.objectContaining({
        entity: 'issueGitState',
        id,
        op: 'upsert',
        value: expect.objectContaining({
          updatedAt: now,
          dirtyFiles: 0,
          ahead: 1,
          lastCommitAt: commitAt,
        }),
      }),
    ])
    expect(published).toHaveBeenCalledTimes(2)
    cursor = await ledger.cursor()

    now = '2026-07-20T12:25:00.000Z'
    await svc.gitWorkflow.refreshGitState(id)
    expect(await ledger.changesSince(cursor)).toEqual([])
    expect((await svc.reports.get(id))?.gitState?.updatedAt).toBe('2026-07-20T12:20:00.000Z')
  } finally {
    await store?.close()
    await rm(root, { recursive: true, force: true })
  }
})
