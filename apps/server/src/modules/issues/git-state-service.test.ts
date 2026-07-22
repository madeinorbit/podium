import type { SessionMeta } from '@podium/protocol'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../../store'
import { type IssueDeps, IssueService } from './service'
import { issueTestPlumbing } from './service/test-plumbing'

// POD-98: the git-state service wiring end-to-end at the service layer —
// turn-end trigger → coalesced probe (via repoOp) → targeted gitState update,
// with attribution unioned from recorded session activity.
function harness(sessions: SessionMeta[], repoOpScript: Record<string, string>) {
  const store = new SessionStore(':memory:')
  const broadcast = vi.fn()
  const repoOp = vi.fn(async (op: string, _cwd: string, args?: Record<string, string>) => {
    const key = op === 'revListCount' ? `${op}:${args?.from}..${args?.to}` : op
    const output = repoOpScript[key]
    return output !== undefined ? { ok: true, output } : { ok: false, output: '' }
  })
  const deps: IssueDeps = {
    store,
    listSessions: () => sessions,
    getSettings: () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: '',
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: vi.fn(() => ({ sessionId: 's1' })),
    repoOp: repoOp as IssueDeps['repoOp'],
    ...issueTestPlumbing((msg) => broadcast(msg)),
    setSessionArchived: vi.fn(),
    now: () => '2026-07-20T00:00:00.000Z',
  }
  return { svc: new IssueService(deps), repoOp, broadcast }
}

const member = (sessionId: string, issueId: string): SessionMeta =>
  ({
    sessionId,
    agentKind: 'claude-code',
    title: 't',
    cwd: '/repo',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: 't',
    lastActiveAt: 't',
    origin: { kind: 'spawn' },
    archived: false,
    issueId,
  }) as unknown as SessionMeta

describe('POD-98 git-state service wiring', () => {
  it('turn end probes a shared checkout and lands attributed gitState on the wire', async () => {
    const sessions: SessionMeta[] = []
    const { svc } = harness(sessions, {
      statusProbe: '## main\n M apps/a.ts\n M apps/b.ts',
      logHead: 'abc\t2026-07-20T11:00:00Z',
    })
    const id = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    sessions.push(member('sess-1', id))

    // Daemon-captured attribution: one touched file. Registration also fires
    // the repopulation probe in the background, so poll until one settles.
    svc.recordSessionGitActivity('sess-1', { touched: ['/repo/apps/a.ts'] })
    await svc.refreshGitState(id, '/repo')
    for (let i = 0; i < 50; i++) {
      const gs = svc.allWire().find((w) => w.id === id)?.gitState
      if (gs && gs.updatedAt !== '' && gs.computing !== true) break
      await new Promise((r) => setTimeout(r, 10))
    }

    const wire = svc.allWire().find((w) => w.id === id)
    expect(wire?.gitState).toMatchObject({
      shared: true,
      branch: 'main',
      dirtyFiles: 2,
      dirtyOwn: 1,
      commits: [],
      updatedAt: '2026-07-20T00:00:00.000Z',
    })
    expect(wire?.gitState?.fallback).toBeUndefined()
    expect(wire?.gitState?.computing).toBeUndefined()
  })

  it('recording a commit triggers a probe via the turn-end path', async () => {
    const sessions: SessionMeta[] = []
    const { svc } = harness(sessions, {
      statusProbe: '## main',
      logHead: 'sha9\t2026-07-20T11:30:00Z',
    })
    const id = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    sessions.push(member('sess-1', id))

    svc.recordSessionGitActivity('sess-1', { commits: ['sha9'] })
    // The commit-triggered probe is fire-and-forget — poll until it settles
    // (vi.waitFor is unavailable under the bun runner).
    let commits: string[] | undefined
    for (let i = 0; i < 50 && commits === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10))
      commits = svc.allWire().find((w) => w.id === id)?.gitState?.commits
    }
    expect(commits).toEqual(['sha9'])
  })

  it('without any attribution the shared probe discloses fallback', async () => {
    const sessions: SessionMeta[] = []
    const { svc } = harness(sessions, {
      statusProbe: '## main\n M x.ts',
    })
    const id = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    sessions.push(member('sess-1', id))

    await svc.refreshGitState(id, '/repo')
    const wire = svc.allWire().find((w) => w.id === id)
    expect(wire?.gitState?.fallback).toBe(true)
    expect(wire?.gitState?.dirtyOwn).toBeUndefined()
  })

  it('first registration after a restart repopulates the stamp without a turn end', async () => {
    const sessions: SessionMeta[] = []
    const { svc } = harness(sessions, {
      statusProbe: '## main',
      logHead: 'abc\t2026-07-20T11:00:00Z',
    })
    const id = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    sessions.push(member('sess-1', id))

    // The daemon's empty baseline registration (SessionStart) is enough.
    svc.recordSessionGitActivity('sess-1', {})
    let state: unknown
    for (let i = 0; i < 50 && state === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10))
      const gs = svc.allWire().find((w) => w.id === id)?.gitState
      state = gs && gs.updatedAt !== '' && gs.computing !== true ? gs : undefined
    }
    expect(state).toMatchObject({ shared: true, branch: 'main' })
  })

  it('coalesces rapid turn ends and publishes one targeted final update', async () => {
    const sessions: SessionMeta[] = []
    const { svc, repoOp, broadcast } = harness(sessions, {
      statusProbe: '## main',
      logHead: 'abc\t2026-07-20T11:00:00Z',
    })
    const id = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    sessions.push(member('sess-1', id))
    repoOp.mockClear()
    broadcast.mockClear()

    svc.onSessionTurnEnd('sess-1')
    svc.onSessionTurnEnd('sess-1')
    svc.onSessionTurnEnd('sess-1')
    expect(repoOp).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()

    await svc.refreshGitState(id, '/repo')
    expect(repoOp).toHaveBeenCalledTimes(4)
    expect(broadcast.mock.calls.map(([msg]) => msg.type)).toEqual(['issueUpdated'])
  })

  it('runs one trailing probe for attribution recorded during an active refresh', async () => {
    const sessions: SessionMeta[] = []
    const { svc, repoOp, broadcast } = harness(sessions, {})
    const id = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    sessions.push(member('sess-1', id))
    let releaseStatus!: () => void
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve
    })
    let statusCalls = 0
    repoOp.mockImplementation(async (op: string) => {
      if (op === 'statusProbe') {
        statusCalls += 1
        if (statusCalls === 1) await statusGate
        return { ok: true, output: '## main' }
      }
      return { ok: false, output: '' }
    })
    broadcast.mockClear()

    const initial = svc.refreshGitState(id, '/repo')
    for (let i = 0; i < 50 && statusCalls === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(statusCalls).toBe(1)
    svc.recordSessionGitActivity('sess-1', { commits: ['late-sha'] })
    releaseStatus()
    await initial

    expect(statusCalls).toBe(2)
    expect(repoOp).toHaveBeenCalledTimes(8)
    expect(svc.get(id)?.gitState?.commits).toEqual(['late-sha'])
    expect(broadcast.mock.calls.map(([msg]) => msg.type)).toEqual(['issueUpdated'])
  })

  it('drops archived or removed sessions from file and commit attribution', async () => {
    const sessions: SessionMeta[] = []
    const { svc } = harness(sessions, {
      statusProbe: '## main\n M apps/a.ts\n M apps/b.ts',
    })
    const id = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    sessions.push(member('sess-1', id), member('sess-2', id))
    svc.recordSessionGitActivity('sess-1', {
      commits: ['sha-1'],
      touched: ['/repo/apps/a.ts'],
    })
    svc.recordSessionGitActivity('sess-2', {
      commits: ['sha-2'],
      touched: ['/repo/apps/b.ts'],
    })
    await svc.refreshGitState(id, '/repo')
    expect(svc.get(id)?.gitState).toMatchObject({
      commits: ['sha-1', 'sha-2'],
      dirtyOwn: 2,
    })

    svc.onSessionRemovedOrArchived('sess-1')
    await svc.refreshGitState(id, '/repo')
    expect(svc.get(id)?.gitState).toMatchObject({ commits: ['sha-2'], dirtyOwn: 1 })

    svc.onSessionRemovedOrArchived('sess-2')
    await svc.refreshGitState(id, '/repo')
    expect(svc.get(id)?.gitState).toMatchObject({ fallback: true })
    expect(svc.get(id)?.gitState?.commits).toBeUndefined()
    expect(svc.get(id)?.gitState?.dirtyOwn).toBeUndefined()
  })

  it('sessions without an issue are a no-op on turn end', () => {
    const sessions: SessionMeta[] = [
      { ...member('sess-x', 'nope'), issueId: undefined } as unknown as SessionMeta,
    ]
    const { svc, repoOp } = harness(sessions, {})
    svc.onSessionTurnEnd('sess-x')
    expect(repoOp).not.toHaveBeenCalled()
  })
})
