/**
 * Freeing a worktree removes the dock-shell mapping (POD-4436 step 4), and the
 * stop path answers the policy's owning worktree from the mapping (step 3).
 *
 * Both freed paths of `freeWorktreeKeepBranch` — removed from disk and
 * already-gone — release every user's mapping row for the path, so no dock
 * reattaches a shell whose worktree is gone.
 *
 * Step 3 at the stop trigger: a mapped shell is judged by its worktree's
 * top-level issue, not by its bound issue or its cwd string. An untouched,
 * unheld shell mapped to a CLOSED issue's worktree is killed on stop; the
 * same shell without the mapping is parked.
 */

import { asSessionId, asUserId, firstAdminMemberId, type SessionId, type UserId } from '@podium/model'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { systemPrincipal } from '../../command-principal'
import { SessionRegistry } from '../../relay'
import { openTestStore } from '../../test-support/open-test-store'
import { testClientPrincipal } from '../../test-support/client-principal'
import type { ControlMessage } from '@podium/protocol/daemon'
import type { ServerMessage } from '@podium/protocol'
import type { ClientConn } from '../../gateway/client-registry'
import type { SessionStore } from '../../store'
import type { Session } from '../sessions/session'
import type { SessionLifecycle } from '../sessions/lifecycle'

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
      rpc: {
        repoOp: (...args: unknown[]) => Promise<{ ok: boolean; output: string }>
        runtimeLifecycle: (...args: never[]) => Promise<unknown>
      }
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
  // Graceful stop settles without a daemon round trip.
  rpc.runtimeLifecycle = (async () => ({
    sessionId: 'stopped',
    result: { ok: true, retirement: 'confirmed' },
  })) as typeof rpc.runtimeLifecycle
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

describe('stopSession answers the policy from the mapping (step 3)', () => {
  /**
   * The shell under test is bound to OPEN issue B and runs its cwd OUTSIDE
   * the worktree, so without the mapping the policy sees no closed owner
   * (bound B is open, `/r` resolves to nothing). Mapped to the CLOSED issue
   * A's worktree, the same untouched, unheld shell is killed on stop
   * (row 8: untouched-shell-owner-gone) instead of parked (row 9).
   *
   * A live sibling session occupies the worktree so the stop never frees it:
   * the free would remove the mapping first and hand row 8 the same verdict
   * through `worktreeFreed`, proving nothing about the mapping.
   */
  async function setupMappedStop(mapped: boolean) {
    const { reg, store } = await makeRegistry(async () => ({ ok: true, output: '## issue/a\n' }))
    const issueA = await reg.modules.issues.create({ repoPath: '/r', title: 'Owner', startNow: false })
    await reg.modules.issues.update(issueA.id, { worktreePath: WT, branch: 'issue/a' })
    const issueB = await reg.modules.issues.create({ repoPath: '/r', title: 'Binding', startNow: false })
    // A live occupant blocks the free so the verdict can only come from the mapping.
    await reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: WT })
    const shell = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r',
      issueId: issueB.id,
    })
    await reg.modules.issues.update(issueA.id, { stage: 'done' })
    await vi.waitFor(async () => {
      expect((await reg.modules.issues.getMeta(issueA.id))?.stage).toBe('done')
    })
    // The close must have kept the worktree (occupied) and therefore the mapping.
    expect((await reg.modules.issues.getMeta(issueA.id))?.worktreePath).toBe(WT)
    if (mapped) {
      await store.dockShells.set(firstAdminMemberId(), WT, shell.sessionId, new Date().toISOString())
    }
    return { reg, store, shellId: shell.sessionId }
  }

  async function statusOf(reg: SessionRegistry, sessionId: SessionId) {
    return (await reg.modules.sessions.listSessions(undefined, 'rpc')).find(
      (s) => s.sessionId === sessionId,
    )?.status
  }

  it('a shell mapped to a closed issue worktree is killed on stop', async () => {
    const { reg, shellId } = await setupMappedStop(true)
    const r = await reg.modules.issueSessionLifecycle.stopSession({ sessionId: shellId })
    expect(r.ok).toBe(true)
    expect(r.worktreeFreed).toBe(false)
    expect(await statusOf(reg, shellId)).toBeUndefined()
  })

  it('the same shell without the mapping is parked, not killed', async () => {
    const { reg, shellId } = await setupMappedStop(false)
    const r = await reg.modules.issueSessionLifecycle.stopSession({ sessionId: shellId })
    expect(r.ok).toBe(true)
    expect(await statusOf(reg, shellId)).toBe('hibernated')
  })
})

describe('freeWorktreeKeepBranch runs the shell lifetime policy (POD-4525)', () => {
  function stubClient(id: string): ClientConn & { sent: ServerMessage[] } {
    const sent: ServerMessage[] = []
    return {
      id,
      principal: testClientPrincipal(id),
      send: (m: ServerMessage) => sent.push(m),
      viewports: new Map(),
      viewportSeq: new Map(),
      attached: new Set(),
      caps: new Set(),
      wireVersion: 1,
      transcriptSubs: new Set(),
      visible: true,
      viewVisible: new Set(),
      focused: null,
      viewModes: {},
      sent,
    }
  }

  /** Type into the shell through its terminal: first attach becomes controller. */
  function typeInto(session: Session, clientId: string, text: string): void {
    session.terminal.attachClient(stubClient(clientId) as ClientConn)
    session.terminal.handleInput(clientId, Buffer.from(text).toString('base64'))
  }

  function liveSession(reg: SessionRegistry, sessionId: SessionId): Session {
    const session = (reg.modules.sessions as unknown as SessionLifecycle).sessions.get(sessionId)
    if (!session) throw new Error(`no live session ${sessionId}`)
    return session
  }

  async function statusOf(reg: SessionRegistry, sessionId: SessionId) {
    return (await reg.modules.sessions.listSessions(undefined, 'rpc')).find(
      (s) => s.sessionId === sessionId,
    )?.status
  }

  async function setupDockShell(opts: { touched: boolean }) {
    const { reg, store } = await makeRegistry(async () => ({ ok: true, output: '## issue/a\n' }))
    const issueId = await makeIssueWithWorktree(reg)
    const shell = await reg.modules.sessions.createSession({ agentKind: 'shell', cwd: WT })
    if (opts.touched) typeInto(liveSession(reg, shell.sessionId), 'c-typer', 'echo hi\n')
    await store.dockShells.set(firstAdminMemberId(), WT, shell.sessionId, new Date().toISOString())
    return { reg, store, shellId: shell.sessionId, issueId }
  }

  it('a touched dock shell whose worktree is freed directly ends hibernated', async () => {
    const { reg, store, shellId, issueId } = await setupDockShell({ touched: true })
    const freed = await reg.modules.issues.freeWorktreeKeepBranch(issueId, systemPrincipal('stop'))
    expect(freed.ok).toBe(true)
    expect(freed.worktreeFreed).toBe(true)
    expect(await store.dockShells.get(firstAdminMemberId(), WT)).toBeUndefined()
    expect(await statusOf(reg, shellId)).toBe('hibernated')
  })

  it('an untouched unheld dock shell whose worktree is freed directly ends tombstoned', async () => {
    const { reg, store, shellId, issueId } = await setupDockShell({ touched: false })
    const freed = await reg.modules.issues.freeWorktreeKeepBranch(issueId, systemPrincipal('stop'))
    expect(freed.ok).toBe(true)
    expect(freed.worktreeFreed).toBe(true)
    expect(await store.dockShells.get(firstAdminMemberId(), WT)).toBeUndefined()
    expect(await statusOf(reg, shellId)).toBeUndefined()
  })
})
