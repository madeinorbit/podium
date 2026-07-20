import type { SessionMeta } from '@podium/protocol'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../../store'
import { type IssueDeps, IssueService } from './service'
import { issueTestPlumbing } from './service/test-plumbing'

// POD-98: the git-state service wiring end-to-end at the service layer —
// turn-end trigger → computing broadcast → probe (via repoOp) → gitState on
// the wire, with attribution unioned from recorded session activity.
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
  return { svc: new IssueService(deps), repoOp }
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

    // Daemon-captured attribution: one commit, one touched file.
    svc.recordSessionGitActivity('sess-1', { touched: ['/repo/apps/a.ts'] })
    await svc.refreshGitState(id, '/repo')

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

  it('sessions without an issue are a no-op on turn end', () => {
    const sessions: SessionMeta[] = [
      { ...member('sess-x', 'nope'), issueId: undefined } as unknown as SessionMeta,
    ]
    const { svc, repoOp } = harness(sessions, {})
    svc.onSessionTurnEnd('sess-x')
    expect(repoOp).not.toHaveBeenCalled()
  })
})
