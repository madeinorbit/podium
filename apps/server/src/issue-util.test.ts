import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '@podium/protocol'
import { isMemberCwd, selectMailNudgeSession, sessionsForIssue, slugifyBranch, stageIndex, summarizeSessions } from './issue-util'

const sess = (cwd: string, phase?: string): SessionMeta =>
  ({
    sessionId: cwd, agentKind: phase ? 'claude-code' : 'shell', title: 't', cwd,
    status: 'live', controllerId: null, geometry: { cols: 80, rows: 24 }, epoch: 0,
    clientCount: 0, createdAt: 't', lastActiveAt: 't', origin: { kind: 'spawn' }, archived: false,
    ...(phase ? { agentState: { phase, since: 't', nativeSubagentCount: 0 } } : {}),
  }) as unknown as SessionMeta

describe('slugifyBranch', () => {
  it('builds issue/<seq>-<slug>', () => {
    expect(slugifyBranch(7, 'Fix the Login Flow!')).toBe('issue/7-fix-the-login-flow')
  })
  it('truncates and trims', () => {
    expect(slugifyBranch(1, 'a'.repeat(80)).length).toBeLessThanOrEqual('issue/1-'.length + 40)
  })
  it('handles empty title', () => {
    expect(slugifyBranch(3, '  ')).toBe('issue/3')
  })
})

describe('membership', () => {
  it('matches exact and nested cwds, never when worktree null', () => {
    expect(isMemberCwd(null, '/r/wt')).toBe(false)
    expect(isMemberCwd('/r/wt', '/r/wt')).toBe(true)
    expect(isMemberCwd('/r/wt', '/r/wt/pkg')).toBe(true)
    expect(isMemberCwd('/r/wt', '/r/wt-other')).toBe(false)
  })
  it('filters sessions and summarizes phases', () => {
    const all = [sess('/r/wt', 'working'), sess('/r/wt/pkg', 'idle'), sess('/r/wt'), sess('/other')]
    const members = sessionsForIssue('/r/wt', all)
    expect(members.length).toBe(3)
    const sum = summarizeSessions(members)
    expect(sum.total).toBe(3)
    expect(sum.byPhase).toEqual({ working: 1, idle: 1, shell: 1 })
  })
})

describe('stageIndex', () => {
  it('orders stages', () => {
    expect(stageIndex('proposed')).toBe(0) // curation lane sits before backlog [spec:SP-6144]
    expect(stageIndex('backlog')).toBe(1)
    expect(stageIndex('done')).toBe(5)
  })
})

describe('selectMailNudgeSession (agent mail #103)', () => {
  const meta = (o: {
    id: string
    agentKind?: string
    status?: string
    phase?: string
    lastActiveAt?: string
  }): SessionMeta =>
    ({
      sessionId: o.id, agentKind: o.agentKind ?? 'claude-code', title: 't', cwd: '/r/wt',
      status: o.status ?? 'live', controllerId: null, geometry: { cols: 80, rows: 24 }, epoch: 0,
      clientCount: 0, createdAt: 't', lastActiveAt: o.lastActiveAt ?? '2026-07-06T00:00:00Z',
      origin: { kind: 'spawn' }, archived: false,
      ...(o.phase ? { agentState: { phase: o.phase, since: 't', nativeSubagentCount: 0 } } : {}),
    }) as unknown as SessionMeta

  it('single idle live agent → immediate send', () => {
    expect(selectMailNudgeSession([meta({ id: 'a', phase: 'idle' })])).toEqual({
      sessionId: 'a',
      mode: 'send',
    })
  })

  it('single busy live agent → queued send', () => {
    expect(selectMailNudgeSession([meta({ id: 'a', phase: 'working' })])).toEqual({
      sessionId: 'a',
      mode: 'queue',
    })
  })

  it('several live agents → most recently active, queued (even if one is idle)', () => {
    const picked = selectMailNudgeSession([
      meta({ id: 'old', phase: 'idle', lastActiveAt: '2026-07-06T00:00:00Z' }),
      meta({ id: 'new', phase: 'working', lastActiveAt: '2026-07-06T01:00:00Z' }),
    ])
    expect(picked).toEqual({ sessionId: 'new', mode: 'queue' })
  })

  it('ignores shells and non-live sessions; none live → null', () => {
    expect(
      selectMailNudgeSession([
        meta({ id: 'sh', agentKind: 'shell', phase: 'idle' }),
        meta({ id: 'gone', status: 'exited', phase: 'idle' }),
      ]),
    ).toBeNull()
    // the shell must not count toward the "exactly one live agent" rule
    expect(
      selectMailNudgeSession([
        meta({ id: 'sh', agentKind: 'shell' }),
        meta({ id: 'a', phase: 'idle' }),
      ]),
    ).toEqual({ sessionId: 'a', mode: 'send' })
  })
})
