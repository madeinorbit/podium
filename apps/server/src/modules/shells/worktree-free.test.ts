/**
 * Freeing a worktree removes the dock-shell mapping (POD-4436 step 4).
 *
 * Both freed paths of `freeWorktreeKeepBranch` — removed from disk and
 * already-gone — release every user's mapping row for the path, so no dock
 * reattaches a shell whose worktree is gone. The retired session ids are what
 * the lifetime policy parks/kills per its rule once terminal-lifetime lands
 * (step 3, held by the coordinator); removal is the whole wire today.
 */

import { asSessionId, asUserId, firstAdminMemberId, type SessionId, type UserId } from '@podium/model'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { systemPrincipal } from '../../command-principal'
import { SessionRegistry } from '../../relay'
import { openTestStore } from '../../test-support/open-test-store'
import type { ControlMessage } from '@podium/protocol/daemon'
import type { SessionStore } from '../../store'

const registries: SessionRegistry[] = []

afterEach(async () => {
  for (const r of registries.splice(0)) await r.dispose()
})

const WT = '/r/.worktrees/a'

function gitWorktreeList(entries: Array<{ path: string; branch?: string }>): string {
  return entries
    .map((entry) =>
      [`worktree ${entry.path}`, 'HEAD deadbeef', entry.branch ? `branch refs/heads/${entry.branch}` : null, '']
        .filter((field) => field !== null)
        .join('\0'),
    )
    .join('\0')
}

async function makeRegistry(statusImpl: () => Promise<{ ok: boolean; output: string }>): Promise<{
  reg: SessionRegistry
  store: SessionStore
}> {
  const store = await openTestStore(':memory:')
  await store.machines.upsertMachine({
    id: store.hostMachineId,
    name: 'test-host',
    hostname: 'test-host',
    tokenHash: 'test',
    ownerUserId: firstAdminMemberId(),
    assignment: { server: true, agentExecution: true },
  })
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(reg)
  const daemon: ControlMessage[] = []
  await reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, (m) => daemon.push(m))
  await reg.sessionStore.repos.addRepo('/r', reg.sessionStore.hostMachineId, 'git@github.com:example/r.git')
  const rpc = (
    reg.modules.sessions as unknown as {
      rpc: { repoOp: (...args: unknown[]) => Promise<{ ok: boolean; output: string }> }
    }
  ).rpc
  rpc.repoOp = (async (op: unknown, cwd: unknown) => {
    if (op === 'status') return await statusImpl()
    if (op === 'worktreeList') {
      // The registry is queried by repo root, not by worktree: it must list
      // the repo plus the linked worktree under test.
      return {
        ok: true,
        output: gitWorktreeList([
          { path: '/r', branch: 'main' },
          { path: WT, branch: 'issue/a' },
        ]),
      }
    }
    return { ok: true, output: '' }
  }) as typeof rpc.repoOp
  return { reg, store }
}

async function makeIssueWithWorktree(reg: SessionRegistry): Promise<string> {
  const issue = await reg.modules.issues.create({ repoPath: '/r', title: 'Dock shell home', startNow: false })
  await reg.modules.issues.update(issue.id, { worktreePath: WT, branch: 'issue/a' })
  return issue.id
}

describe('freeWorktreeKeepBranch releases dock shells', () => {
  it('removing the worktree releases every user mapping for the path', async () => {
    const { reg, store } = await makeRegistry(async () => ({ ok: true, output: '## issue/a\n' }))
    const issueId = await makeIssueWithWorktree(reg)
    const alice: UserId = firstAdminMemberId()
    const bob: UserId = asUserId('user:bob')
    const shellA: SessionId = asSessionId(randomUUID())
    const shellB: SessionId = asSessionId(randomUUID())
    const now = new Date().toISOString()
    await store.dockShells.set(alice, WT, shellA, now)
    await store.dockShells.set(bob, `${WT}/`, shellB, now)
    // An unrelated worktree mapping survives the free.
    await store.dockShells.set(alice, '/r/.worktrees/b', shellB, now)

    const freed = await reg.modules.issues.freeWorktreeKeepBranch(issueId, systemPrincipal('stop'))
    expect(freed.ok).toBe(true)
    expect(freed.worktreeFreed).toBe(true)
    expect(await store.dockShells.get(alice, WT)).toBeUndefined()
    expect(await store.dockShells.get(bob, WT)).toBeUndefined()
    expect(await store.dockShells.get(alice, '/r/.worktrees/b')).toBe(shellB)
  })

  it('an already-gone worktree clears the stale path record and the mapping', async () => {
    const { reg, store } = await makeRegistry(async () => ({
      ok: false,
      output: `cannot change to ${WT}: no such file or directory`,
    }))
    const issueId = await makeIssueWithWorktree(reg)
    const alice: UserId = firstAdminMemberId()
    const shellA: SessionId = asSessionId(randomUUID())
    await store.dockShells.set(alice, WT, shellA, new Date().toISOString())

    const freed = await reg.modules.issues.freeWorktreeKeepBranch(issueId, systemPrincipal('stop'))
    expect(freed.ok).toBe(true)
    expect(freed.worktreeFreed).toBe(true)
    expect(await store.dockShells.get(alice, WT)).toBeUndefined()
  })

  it('a refused free keeps the mapping', async () => {
    const { reg, store } = await makeRegistry(async () => ({
      ok: true,
      output: '## issue/a\nM dirty-file.txt',
    }))
    const issueId = await makeIssueWithWorktree(reg)
    const alice: UserId = firstAdminMemberId()
    const shellA: SessionId = asSessionId(randomUUID())
    await store.dockShells.set(alice, WT, shellA, new Date().toISOString())

    const freed = await reg.modules.issues.freeWorktreeKeepBranch(issueId, systemPrincipal('stop'))
    expect(freed.ok).toBe(false)
    expect(await store.dockShells.get(alice, WT)).toBe(shellA)
  })
})
