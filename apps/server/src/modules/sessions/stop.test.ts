/**
 * session/issue stop [spec:SP-9904]: park process, free worktree keep branch,
 * resume recreates worktree; unsaved guard + force.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../../relay'
import type { ControlMessage } from '@podium/protocol'

const registries: SessionRegistry[] = []

afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
})

type RepoOpStub = (
  op: string,
  cwd: string,
  args?: Record<string, string>,
  machineId?: string,
) => Promise<{ ok: boolean; output: string }>

function makeRegistry(statusOutput = '## issue/x\n'): {
  reg: SessionRegistry
  daemon: ControlMessage[]
  repoOps: { op: string; cwd: string; args?: Record<string, string> }[]
  setRepoOp: (fn: RepoOpStub) => void
} {
  const reg = new SessionRegistry()
  registries.push(reg)
  const daemon: ControlMessage[] = []
  reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
  const repoOps: { op: string; cwd: string; args?: Record<string, string> }[] = []
  // Both sessions.rpc.repoOp and issues.deps.repoOp close over the same DaemonRpc
  // instance — stubbing rpc.repoOp covers free/ensure/status for stop.
  const rpc = (reg.modules.sessions as unknown as { rpc: { repoOp: RepoOpStub } }).rpc
  let impl: RepoOpStub = async (op, cwd, args) => {
    repoOps.push({ op, cwd, ...(args ? { args } : {}) })
    if (op === 'status') return { ok: true, output: statusOutput }
    if (op === 'worktreeRemove') return { ok: true, output: '' }
    if (op === 'worktreeAddExisting') return { ok: true, output: 'Preparing worktree' }
    return { ok: true, output: '' }
  }
  rpc.repoOp = (op, cwd, args, machineId) => impl(op, cwd, args, machineId)
  return {
    reg,
    daemon,
    repoOps,
    setRepoOp: (fn) => {
      impl = async (op, cwd, args, machineId) => {
        repoOps.push({ op, cwd, ...(args ? { args } : {}) })
        return fn(op, cwd, args, machineId)
      }
    },
  }
}

function bindLive(reg: SessionRegistry, sessionId: string, cwd: string): void {
  reg.modules.sessions.onDaemonMessageFrom('local', {
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd,
    agentKind: 'claude-code',
    geometry: { cols: 80, rows: 24 },
  })
  reg.modules.sessions.onDaemonMessageFrom('local', {
    type: 'sessionResumeRef',
    sessionId,
    resume: { kind: 'claude-session', value: 'native-1' },
  })
}

describe('stopSession [spec:SP-9904]', () => {
  it('parks a live session, frees the issue worktree, keeps the branch', async () => {
    const { reg, daemon, repoOps } = makeRegistry()
    const issue = reg.modules.issues.create({
      repoPath: '/r',
      title: 'Stop target',
      startNow: false,
    })
    reg.modules.issues.update(issue.id, {
      worktreePath: '/r/.worktrees/issue-1-stop-target',
      branch: 'issue/1-stop-target',
    })
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/r/.worktrees/issue-1-stop-target',
      issueId: issue.id,
    })
    bindLive(reg, sessionId, '/r/.worktrees/issue-1-stop-target')
    expect(reg.modules.sessions.listSessions()[0]?.status).toBe('live')
    reg.modules.sessions.markSessionRead(sessionId)
    expect(reg.modules.sessions.listSessions()[0]?.unread).toBe(false)

    const r = await reg.modules.sessions.stopSession({ sessionId })
    expect(r.ok).toBe(true)
    expect(r.worktreeFreed).toBe(true)
    const meta = reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
    expect(meta?.status).toBe('hibernated')
    expect(meta?.stoppedAt).toBeTruthy()
    // A plain (no --force) operator stop is an orderly park — never 'forced'.
    expect(meta?.stopReason).toBe('parent')
    expect(meta?.readAt).toBeNull()
    expect(meta?.unread).toBe(true)
    expect(meta?.resume).toEqual({ kind: 'claude-session', value: 'native-1' })
    // Row kept (not deleted).
    expect(meta).toBeTruthy()
    // Process kill sent.
    expect(daemon.some((m) => m.type === 'kill' && m.sessionId === sessionId)).toBe(true)
    // Worktree removed, branch still on issue.
    expect(repoOps.some((c) => c.op === 'worktreeRemove')).toBe(true)
    const after = reg.modules.issues.getMeta(issue.id)
    expect(after?.worktreePath).toBeNull()
    expect(after?.branch).toBe('issue/1-stop-target')
  })

  it('refuses stop when the working tree is dirty without --force', async () => {
    const { reg, setRepoOp } = makeRegistry()
    setRepoOp(async (op) => {
      if (op === 'status') return { ok: true, output: '## issue/2-dirty\n M dirty.ts\n' }
      return { ok: true, output: '' }
    })
    const issue = reg.modules.issues.create({
      repoPath: '/r',
      title: 'Dirty stop',
      startNow: false,
    })
    reg.modules.issues.update(issue.id, {
      worktreePath: '/r/.worktrees/issue-2-dirty',
      branch: 'issue/2-dirty',
    })

    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/r/.worktrees/issue-2-dirty',
      issueId: issue.id,
    })
    bindLive(reg, sessionId, '/r/.worktrees/issue-2-dirty')

    const r = await reg.modules.sessions.stopSession({ sessionId })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/unsaved changes/)
    expect(r.reason).toMatch(/dirty\.ts/)
    // Still live — not parked.
    expect(reg.modules.sessions.listSessions()[0]?.status).toBe('live')
    // Branch and worktree unchanged.
    expect(reg.modules.issues.getMeta(issue.id)?.worktreePath).toBe('/r/.worktrees/issue-2-dirty')
  })

  it('--force stops and frees even with dirty tree', async () => {
    const { reg, setRepoOp } = makeRegistry()
    setRepoOp(async (op, _cwd, args) => {
      if (op === 'status') return { ok: true, output: '## issue/3-force\n M dirty.ts\n' }
      if (op === 'worktreeRemove') {
        expect(args?.force).toBe('1')
        return { ok: true, output: '' }
      }
      return { ok: true, output: '' }
    })
    const issue = reg.modules.issues.create({
      repoPath: '/r',
      title: 'Force stop',
      startNow: false,
    })
    reg.modules.issues.update(issue.id, {
      worktreePath: '/r/.worktrees/issue-3-force',
      branch: 'issue/3-force',
    })

    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/r/.worktrees/issue-3-force',
      issueId: issue.id,
    })
    bindLive(reg, sessionId, '/r/.worktrees/issue-3-force')

    const r = await reg.modules.sessions.stopSession({ sessionId, force: true })
    expect(r.ok).toBe(true)
    expect(r.worktreeFreed).toBe(true)
    expect(
      reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.stopReason,
    ).toBe('forced')
    expect(reg.modules.issues.getMeta(issue.id)?.branch).toBe('issue/3-force')
    expect(reg.modules.issues.getMeta(issue.id)?.worktreePath).toBeNull()
  })

  it('self-stop holds the kill until finalizeDeferredStopKill (after-reply)', async () => {
    const { reg, daemon } = makeRegistry()
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })
    bindLive(reg, sessionId, '/w')

    const r = await reg.modules.sessions.stopSession({ sessionId, selfStop: true })
    expect(r.ok).toBe(true)
    expect(r.deferredKill).toBe(true)
    expect(
      reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.stopReason,
    ).toBe('self')
    // No timer — kill is not sent until the relay replies.
    expect(daemon.some((m) => m.type === 'kill')).toBe(false)
    reg.modules.sessions.finalizeDeferredStopKill(sessionId)
    expect(daemon.some((m) => m.type === 'kill' && m.sessionId === sessionId)).toBe(true)
  })

  it('does not free the worktree while a sibling session is still live', async () => {
    const { reg, repoOps } = makeRegistry()
    const issue = reg.modules.issues.create({
      repoPath: '/r',
      title: 'Shared wt',
      startNow: false,
    })
    const wt = '/r/.worktrees/issue-4-shared'
    reg.modules.issues.update(issue.id, { worktreePath: wt, branch: 'issue/4-shared' })
    const a = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: wt,
      issueId: issue.id,
    }).sessionId
    const b = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: wt,
      issueId: issue.id,
    }).sessionId
    bindLive(reg, a, wt)
    bindLive(reg, b, wt)

    const r = await reg.modules.sessions.stopSession({ sessionId: a })
    expect(r.ok).toBe(true)
    expect(r.worktreeFreed).toBe(false)
    expect(repoOps.some((c) => c.op === 'worktreeRemove')).toBe(false)
    expect(reg.modules.issues.getMeta(issue.id)?.worktreePath).toBe(wt)
  })

  it('does not free when a live session of ANOTHER issue shares the cwd', async () => {
    const { reg, repoOps } = makeRegistry()
    const a = reg.modules.issues.create({
      repoPath: '/r',
      title: 'Owner issue',
      startNow: false,
    })
    const b = reg.modules.issues.create({
      repoPath: '/r',
      title: 'Squatter issue',
      startNow: false,
    })
    const wt = '/r/.worktrees/issue-cross-share'
    reg.modules.issues.update(a.id, { worktreePath: wt, branch: 'issue/a-owner' })
    // B is a different issue but its session runs inside A's worktree.
    const owner = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: wt,
      issueId: a.id,
    }).sessionId
    const squatter = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: wt,
      issueId: b.id,
    }).sessionId
    bindLive(reg, owner, wt)
    bindLive(reg, squatter, wt)

    const r = await reg.modules.sessions.stopSession({ sessionId: owner })
    expect(r.ok).toBe(true)
    expect(r.worktreeFreed).toBe(false)
    expect(repoOps.some((c) => c.op === 'worktreeRemove')).toBe(false)
    expect(reg.modules.issues.getMeta(a.id)?.worktreePath).toBe(wt)
  })

  it('freeWorktreeKeepBranch passes issue.machineId on status and remove', async () => {
    const { reg, setRepoOp } = makeRegistry()
    const seen: { op: string; machineId?: string }[] = []
    setRepoOp(async (op, _cwd, _args, machineId) => {
      seen.push({ op, machineId })
      if (op === 'status') return { ok: true, output: '## issue/x\n' }
      return { ok: true, output: '' }
    })
    const issue = reg.modules.issues.create({
      repoPath: '/r',
      title: 'Remote free',
      startNow: false,
    })
    reg.modules.issues.update(issue.id, {
      worktreePath: '/r/.worktrees/issue-remote',
      branch: 'issue/remote',
      machineId: 'machine-remote',
    })
    const freed = await reg.modules.issues.freeWorktreeKeepBranch(issue.id)
    expect(freed.ok).toBe(true)
    expect(seen.find((s) => s.op === 'status')?.machineId).toBe('machine-remote')
    expect(seen.find((s) => s.op === 'worktreeRemove')?.machineId).toBe('machine-remote')
  })

  it('resurrect recreates a freed worktree from the preserved branch', async () => {
    const { reg, daemon } = makeRegistry()
    const issue = reg.modules.issues.create({
      repoPath: '/r',
      title: 'Resume recreate',
      startNow: false,
    })
    const wt = '/r/.worktrees/issue-5-resume'
    reg.modules.issues.update(issue.id, { worktreePath: wt, branch: 'issue/5-resume' })
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: wt,
      issueId: issue.id,
    })
    bindLive(reg, sessionId, wt)
    await reg.modules.sessions.stopSession({ sessionId })
    expect(reg.modules.issues.getMeta(issue.id)?.worktreePath).toBeNull()

    daemon.length = 0
    const woke = await reg.modules.sessions.resurrectSession({ sessionId })
    expect(woke.ok).toBe(true)
    expect(reg.modules.issues.getMeta(issue.id)?.worktreePath).toBe(wt)
    expect(reg.modules.issues.getMeta(issue.id)?.branch).toBe('issue/5-resume')
    const spawn = daemon.find((m) => m.type === 'spawn')
    expect(spawn).toMatchObject({
      type: 'spawn',
      sessionId,
      cwd: wt,
      resume: { kind: 'claude-session', value: 'native-1' },
    })
  })

  it('resurrects an issue session that never owned a dedicated worktree', async () => {
    const { reg, daemon, repoOps } = makeRegistry()
    const issue = reg.modules.issues.create({
      repoPath: '/r',
      title: 'Repository root session',
      startNow: false,
    })
    expect(reg.modules.issues.getMeta(issue.id)).toMatchObject({
      worktreePath: null,
      branch: null,
    })
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/r',
      issueId: issue.id,
    })
    bindLive(reg, sessionId, '/r')
    expect(reg.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })

    daemon.length = 0
    const woke = await reg.modules.sessions.resurrectSession({ sessionId })
    expect(woke).toEqual({ ok: true })
    expect(repoOps.some((call) => call.op === 'worktreeAddExisting')).toBe(false)
    expect(daemon.find((message) => message.type === 'spawn')).toMatchObject({
      type: 'spawn',
      sessionId,
      cwd: '/r',
      resume: { kind: 'claude-session', value: 'native-1' },
    })
  })
})

describe('stopIssue [spec:SP-9904]', () => {
  it('stops every member session then frees the worktree', async () => {
    const { reg } = makeRegistry()
    const issue = reg.modules.issues.create({
      repoPath: '/r',
      title: 'Issue stop',
      startNow: false,
    })
    const wt = '/r/.worktrees/issue-6-all'
    reg.modules.issues.update(issue.id, { worktreePath: wt, branch: 'issue/6-all' })
    const a = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: wt,
      issueId: issue.id,
    }).sessionId
    const b = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: wt,
      issueId: issue.id,
    }).sessionId
    bindLive(reg, a, wt)
    bindLive(reg, b, wt)

    const r = await reg.modules.sessions.stopIssue({ issueId: issue.id })
    expect(r.ok).toBe(true)
    expect(r.stopped.sort()).toEqual([a, b].sort())
    expect(r.worktreeFreed).toBe(true)
    for (const id of [a, b]) {
      expect(reg.modules.sessions.listSessions().find((s) => s.sessionId === id)?.status).toBe(
        'hibernated',
      )
    }
    expect(reg.modules.issues.getMeta(issue.id)?.worktreePath).toBeNull()
    expect(reg.modules.issues.getMeta(issue.id)?.branch).toBe('issue/6-all')
  })

  it('resolves a human ref/seq before matching members (POD-985 regression)', async () => {
    const { reg } = makeRegistry()
    const issue = reg.modules.issues.create({
      repoPath: '/r',
      title: 'Issue stop by ref',
      startNow: false,
    })
    const wt = '/r/.worktrees/issue-7-ref'
    reg.modules.issues.update(issue.id, { worktreePath: wt, branch: 'issue/7-ref' })
    const a = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: wt,
      issueId: issue.id,
    }).sessionId
    const b = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: wt,
      issueId: issue.id,
    }).sessionId
    bindLive(reg, a, wt)
    bindLive(reg, b, wt)

    // The CLI passes the ref verbatim (resolution is server-side); before the fix,
    // stopIssue compared the raw ref against stored internal ids and stopped 0.
    const r = await reg.modules.sessions.stopIssue({ issueId: String(issue.seq) })
    expect(r.ok).toBe(true)
    expect(r.stopped.sort()).toEqual([a, b].sort())
    expect(r.worktreeFreed).toBe(true)
  })
})
