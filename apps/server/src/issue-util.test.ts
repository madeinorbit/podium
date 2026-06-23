import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '@podium/protocol'
import { isMemberCwd, sessionsForIssue, slugifyBranch, stageIndex, summarizeSessions } from './issue-util'

const sess = (cwd: string, phase?: string): SessionMeta =>
  ({
    sessionId: cwd, agentKind: phase ? 'claude-code' : 'shell', title: 't', cwd,
    status: 'live', controllerId: null, geometry: { cols: 80, rows: 24 }, epoch: 0,
    clientCount: 0, createdAt: 't', lastActiveAt: 't', origin: { kind: 'spawn' }, archived: false,
    ...(phase ? { agentState: { phase, since: 't', openTaskCount: 0 } } : {}),
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
    expect(stageIndex('backlog')).toBe(0)
    expect(stageIndex('done')).toBe(5)
  })
})
