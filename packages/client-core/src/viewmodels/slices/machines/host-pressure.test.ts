import { asMachineId, asSessionId, type SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  hostAgentsView,
  hostLoadView,
  idleSessionSplit,
  listReclaimableWorktreesClient,
  occupiedRootsFromKey,
  placeReclaimable,
  residencyBreakdown,
  residentSessionsOnMachine,
  residentWorktreeKey,
} from './facts'

const host = (over: { one?: number; cpuCount?: number; load?: false } = {}) => ({
  hostname: 'podium-vps',
  machineId: asMachineId('m1'),
  sampledAt: '2026-08-08T00:00:00.000Z',
  memory: { totalBytes: 32e9, availableBytes: 20e9, swapTotalBytes: 0, swapFreeBytes: 0 },
  ...(over.load === false
    ? {}
    : {
        load: {
          one: over.one ?? 12,
          five: 10,
          fifteen: 8,
          cpuCount: over.cpuCount ?? 8,
        },
      }),
})

const session = (
  over: { sessionId: string } & Partial<Omit<SessionMeta, 'sessionId'>>,
): SessionMeta =>
  ({
    agentKind: 'claude-code',
    title: over.sessionId,
    cwd: '/repo/.worktrees/x',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    lastActiveAt: '2026-08-01T00:00:00.000Z',
    origin: { kind: 'user' },
    archived: false,
    readAt: null,
    unread: false,
    machineId: asMachineId('m1'),
    ...over,
    sessionId: asSessionId(over.sessionId),
  }) as SessionMeta

describe('hostLoadView', () => {
  it('fills the meter against loadPerCore, not 100%', () => {
    // 12 / 8 = 1.5× at threshold 1.5 → full meter
    const v = hostLoadView(host({ one: 12, cpuCount: 8 }), 1.5)
    expect(v.perCore).toBe(1.5)
    expect(v.meterPct).toBe(100)
    expect(v.severity).toBe('critical')
    expect(v.label).toBe('1.5×')
  })

  it('warns at ≥ 0.8× of threshold', () => {
    // 1.25× against a 1.5× threshold → ratio 5/6 ≈ 0.833
    const v = hostLoadView(host({ one: 10, cpuCount: 8 }), 1.5)
    expect(v.severity).toBe('warn')
    expect(v.meterPct).toBe(83)
  })

  it('blanks when the daemon has no load field', () => {
    const v = hostLoadView(host({ load: false }), 1.5)
    expect(v.perCore).toBeNull()
    expect(v.label).toBe('—')
    expect(v.meterPct).toBe(0)
  })
})

describe('residency', () => {
  it('keeps resident inventory neutral and meters only observed idle phases', () => {
    const sessions = [
      session({
        sessionId: 'a',
        status: 'live',
        agentState: { phase: 'idle', since: '2026-08-01T00:00:00.000Z', nativeSubagentCount: 0 },
      }),
      session({
        sessionId: 'b',
        status: 'live',
        agentState: {
          phase: 'working',
          since: '2026-08-01T00:00:00.000Z',
          nativeSubagentCount: 0,
        },
      }),
      session({ sessionId: 'c', status: 'hibernated' }),
      session({ sessionId: 'd', status: 'live', machineId: asMachineId('other') }),
      session({ sessionId: 'e', status: 'reconnecting' }),
    ]
    expect(residentSessionsOnMachine(sessions, 'm1')).toHaveLength(3)
    const agents = hostAgentsView(sessions, 'm1', 8, 'podium-vps')
    expect(agents.count).toBe(3)
    expect(agents.observedIdleCount).toBe(1)
    expect(agents.idleTarget).toBe(8)
    expect(agents.meterPct).toBe(13) // one observed idle; other residents do not fill it
    expect(agents.severity).toBe('ok')
  })

  it('does not alarm at the target and does alarm on a known idle overage', () => {
    const idle = (sessionId: string) =>
      session({
        sessionId,
        agentState: { phase: 'idle', since: '2026-08-01T00:00:00.000Z', nativeSubagentCount: 0 },
      })
    expect(hostAgentsView([idle('a'), idle('b')], 'm1', 2, 'h').severity).toBe('ok')
    expect(hostAgentsView([idle('a'), idle('b'), idle('c')], 'm1', 2, 'h').severity).toBe(
      'critical',
    )
  })

  it('omits the meter when maxIdleSessions is unlimited', () => {
    const sessions = [session({ sessionId: 'a' })]
    expect(hostAgentsView(sessions, 'm1', null, 'h')).toMatchObject({
      count: 1,
      idleTarget: null,
      meterPct: null,
      severity: 'ok',
    })
  })

  it('breaks down working vs idle vs waiting for the tooltip', () => {
    const phase = (p: 'working' | 'idle' | 'needs_user') => ({
      phase: p,
      since: '2026-08-01T00:00:00.000Z',
      nativeSubagentCount: 0,
    })
    const sessions = [
      session({ sessionId: 'w', agentState: phase('working') }),
      session({ sessionId: 'i', agentState: phase('idle') }),
      session({ sessionId: 'n', agentState: phase('needs_user') }),
    ]
    expect(residencyBreakdown(sessions, 'm1')).toEqual({
      working: 1,
      idle: 1,
      waiting: 1,
      other: 0,
    })
  })
})

describe('idleSessionSplit', () => {
  it('protects needs_user and non-resumable idle sessions', () => {
    const phase = (p: 'idle' | 'ended' | 'needs_user' | 'working') => ({
      phase: p,
      since: '2026-08-01T00:00:00.000Z',
      nativeSubagentCount: 0,
    })
    const sessions = [
      session({ sessionId: 'p', resumable: true, agentState: phase('idle') }),
      session({ sessionId: 'n', resumable: true, agentState: phase('needs_user') }),
      session({ sessionId: 'r', resumable: false, agentState: phase('ended') }),
      session({ sessionId: 'busy', agentState: phase('working') }),
    ]
    expect(idleSessionSplit(sessions, 'm1')).toEqual({ parkable: 1, protected: 2, idle: 3 })
  })
})

describe('listReclaimableWorktreesClient', () => {
  const day = 24 * 60 * 60 * 1000
  const now = Date.parse('2026-08-08T00:00:00.000Z')

  it('keeps closed aged worktrees with no live session in the path', () => {
    const issues = [
      {
        id: 'old',
        title: 'Old done',
        stage: 'done',
        closedAt: new Date(now - 20 * day).toISOString(),
        worktreePath: '/r/.worktrees/old',
        machineId: 'm1',
      },
      {
        id: 'fresh',
        title: 'Just closed',
        stage: 'done',
        closedAt: new Date(now - 2 * day).toISOString(),
        worktreePath: '/r/.worktrees/fresh',
        machineId: 'm1',
      },
      {
        id: 'open',
        title: 'Still open',
        stage: 'in_progress',
        worktreePath: '/r/.worktrees/open',
        machineId: 'm1',
      },
      {
        id: 'busy',
        title: 'Session still in it',
        stage: 'done',
        closedAt: new Date(now - 30 * day).toISOString(),
        worktreePath: '/r/.worktrees/busy',
        machineId: 'm1',
      },
    ]
    const sessions = [session({ sessionId: 's', cwd: '/r/.worktrees/busy', status: 'live' })]
    const list = listReclaimableWorktreesClient({
      issues,
      occupiedRoots: occupiedRootsFromKey(residentWorktreeKey(sessions)),
      afterDays: 14,
      nowMs: now,
    })
    expect(list.map((c) => c.issueId)).toEqual(['old'])
  })
})

/**
 * Placement, and why it is not `row.machineId === thisMachine` (POD-563).
 *
 * A real instance records `machineId` on an issue ONLY when it is deliberately
 * placed on a remote machine — every ordinary issue, including ones created
 * today, carries null, and the server reads that null as "the hub" (its git ops
 * pass `row.machineId ?? undefined`, which routes locally). The obvious equality
 * filter therefore drops EVERY ordinary checkout: verified against the live
 * board, where 155 aged checkouts rendered as "0 reclaimable".
 */
describe('placeReclaimable', () => {
  const candidate = (issueId: string, machineId: string | null) => ({
    issueId,
    title: issueId,
    worktreePath: `/r/.worktrees/${issueId}`,
    closedAt: '2026-07-01T00:00:00.000Z',
    machineId,
  })

  it('claims unattributed checkouts for the only machine', () => {
    const placed = placeReclaimable([candidate('a', null), candidate('b', null)], {
      machineId: 'm1',
      soleMachine: true,
    })
    expect(placed.here.map((c) => c.issueId)).toEqual(['a', 'b'])
    expect(placed.unplaceable).toBe(0)
  })

  it('counts unattributed checkouts instead of dropping them when there are several machines', () => {
    const placed = placeReclaimable(
      [candidate('mine', 'm1'), candidate('theirs', 'm2'), candidate('nowhere', null)],
      { machineId: 'm1', soleMachine: false },
    )
    // Never offered under a chip it might not belong to...
    expect(placed.here.map((c) => c.issueId)).toEqual(['mine'])
    // ...but never silently zero either.
    expect(placed.unplaceable).toBe(1)
  })

  it('keeps an attributed checkout off every other machine', () => {
    const placed = placeReclaimable([candidate('theirs', 'm2')], {
      machineId: 'm1',
      soleMachine: true,
    })
    expect(placed.here).toEqual([])
    expect(placed.unplaceable).toBe(0)
  })
})

/**
 * The memo key the header and both panels depend on instead of the sessions
 * array (POD-563). It has to be stable under the churn that dominates that
 * slice, and it has to round-trip — the candidate scan reads the paths back
 * out of it, so a key that compares equal but decodes differently would be a
 * silently stale candidate list.
 */
describe('residentWorktreeKey', () => {
  const phase = (p: 'working' | 'idle') => ({
    phase: p,
    since: '2026-08-01T00:00:00.000Z',
    nativeSubagentCount: 0,
  })

  it('ignores churn that cannot move a checkout in or out of the list', () => {
    const before = [
      session({ sessionId: 'a', cwd: '/r/.worktrees/a', status: 'live' }),
      session({ sessionId: 'b', cwd: '/r/.worktrees/b', status: 'live' }),
    ]
    const after = [
      // Same two sessions, re-emitted with a new phase and in the other order —
      // the shape of a routine store update.
      session({
        sessionId: 'b',
        cwd: '/r/.worktrees/b',
        status: 'live',
        agentState: phase('working'),
      }),
      session({
        sessionId: 'a',
        cwd: '/r/.worktrees/a',
        status: 'live',
        agentState: phase('idle'),
      }),
    ]
    expect(residentWorktreeKey(after)).toBe(residentWorktreeKey(before))
  })

  it('changes when a session moves into or out of residency', () => {
    const empty = residentWorktreeKey([])
    const one = residentWorktreeKey([
      session({ sessionId: 'a', cwd: '/r/.worktrees/a', status: 'live' }),
    ])
    expect(one).not.toBe(empty)
    // A hibernated session is not standing in the directory, so it is not in the key.
    expect(
      residentWorktreeKey([
        session({ sessionId: 'a', cwd: '/r/.worktrees/a', status: 'hibernated' }),
      ]),
    ).toBe(empty)
  })

  it('round-trips through occupiedRootsFromKey, including the empty case', () => {
    expect(occupiedRootsFromKey(residentWorktreeKey([]))).toEqual([])
    expect(
      occupiedRootsFromKey(
        residentWorktreeKey([
          session({ sessionId: 'b', cwd: '/r/.worktrees/b', status: 'live' }),
          session({ sessionId: 'a', cwd: '/r/.worktrees/a', status: 'starting' }),
        ]),
      ),
    ).toEqual(['/r/.worktrees/a', '/r/.worktrees/b'])
  })
})
