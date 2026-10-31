import type { SessionView, SessionViewInput } from '@podium/client-core/session-values'
import { archivedSessionsForIssue, archivedSessionsForWorktreePath, branchRollup, type IssueNavigationModel, mostUrgentSession, type RepoNavView, repoUsageAt, rowUnreadEmphasized, sessionUrgencyRank, spawnTargetForRepo, type UnifiedWorkRow, type WorktreeNavView } from '@podium/client-core/values'
import {
  asMachineId,
  isIssueDeferred,
  issueReturnedFromDefer,
  type UnbrandIds,
} from '@podium/model'
import { describe, expect, it } from 'vitest'

const NOW = Date.parse('2026-07-06T12:00:00.000Z')
const HOUR = 3_600_000

function sess(id: string, cwd: string, over: Partial<SessionViewInput> = {}): SessionView {
  return {
    sessionId: id,
    cwd,
    createdAt: new Date(NOW - 24 * HOUR).toISOString(),
    lastActiveAt: new Date(NOW - HOUR).toISOString(),
    agentKind: 'claude-code',
    status: 'live',
    busy: false,
    archived: false,
    title: 't',
    ...over,
  } as unknown as SessionView
}

const needsYou = (id: string, cwd: string, over: Partial<SessionViewInput> = {}): SessionView =>
  sess(id, cwd, { agentState: { phase: 'needs_user' }, ...over } as Partial<SessionViewInput>)
const working = (id: string, cwd: string): SessionView =>
  sess(id, cwd, { agentState: { phase: 'working' } } as Partial<SessionViewInput>)
const idle = (id: string, cwd: string, over: Partial<SessionViewInput> = {}): SessionView =>
  sess(id, cwd, {
    agentState: { phase: 'idle', idle: { kind: 'done' } },
    ...over,
  } as Partial<SessionViewInput>)

function navWt(path: string, over: Partial<WorktreeNavView> = {}): WorktreeNavView {
  return {
    path,
    repoPath: over.repoPath ?? path,
    isMain: over.isMain ?? true,
    repoName: path.split('/').pop() ?? path,
    sessions: [],
    issues: [],
    ...over,
  }
}

function issue(over: Partial<UnbrandIds<IssueNavigationModel>> = {}): IssueNavigationModel {
  return {
    id: 'i1',
    repoPath: '/r/a',
    seq: 1,
    title: 'Fix login',
    description: '',
    stage: 'in_progress',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    blockedByNotes: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    archived: false,
    needsHuman: false,
    intentOrigin: 'human' as const,
    audience: 'human' as const,
    isDraftVessel: false,
    childCount: 0,
    childDoneCount: 0,
    ...over,
  } as unknown as IssueNavigationModel
}

describe('spawnTargetForRepo', () => {
  const repo = (worktrees: WorktreeNavView[]): RepoNavView => ({
    path: '/src/podium',
    name: 'podium',
    worktrees,
  })
  const own = navWt('/src/podium', { repoPath: '/src/podium' })
  const clone = navWt('/src/podium-conv-identity', { repoPath: '/src/podium-conv-identity' })
  const branch = navWt('/src/podium/.worktrees/x', { isMain: false, repoPath: '/src/podium' })

  it("always picks the repo's OWN main checkout, never a sibling clone", () => {
    const t = spawnTargetForRepo(repo([clone, own, branch]))
    expect(t.worktree.path).toBe('/src/podium')
    expect(t.repoName).toBe('podium')
  })

  it('never picks a linked worktree', () => {
    const t = spawnTargetForRepo(repo([branch, own]))
    expect(t.worktree.isMain).toBe(true)
    expect(t.worktree.path).toBe('/src/podium')
  })

  it('label is the registered repo name even when clones differ', () => {
    const t = spawnTargetForRepo(repo([clone, own]))
    expect(t.repoName).toBe('podium')
  })

  it('reconstructs the main checkout when nothing matches the repo path', () => {
    const t = spawnTargetForRepo({ path: '/gone', name: 'gone', worktrees: [clone, branch] })
    expect(t.worktree).toEqual({ path: '/gone', repoPath: '/gone', isMain: true })
    expect(t.repoName).toBe('gone')
  })

  it('reconstructs the main checkout when the nav list is empty', () => {
    const t = spawnTargetForRepo({ path: '/r/a', name: 'a', worktrees: [] })
    expect(t.worktree).toEqual({ path: '/r/a', repoPath: '/r/a', isMain: true })
    expect(t.repoName).toBe('a')
  })

  it('uses the selected machine main checkout when one is provided', () => {
    const hostMain = navWt('/home/podium-host/podium', {
      repoPath: '/home/podium-host/podium',
      machineId: asMachineId('podium-host'),
    })
    const vmi = navWt('/home/vmi34/podium', {
      repoPath: '/home/vmi34/podium',
      machineId: asMachineId('vmi34'),
    })
    const t = spawnTargetForRepo(
      { path: '/home/podium-host/podium', name: 'podium', worktrees: [hostMain, vmi] },
      asMachineId('vmi34'),
    )
    expect(t.worktree).toMatchObject({
      path: '/home/vmi34/podium',
      repoPath: '/home/vmi34/podium',
      machineId: 'vmi34',
      isMain: true,
    })
    expect(t.repoName).toBe('podium')
  })
})

describe('sessionUrgencyRank / mostUrgentSession', () => {
  it('ranks needs-you AND finished-idle 0 (above working), working 1, stale/exited 3', () => {
    expect(sessionUrgencyRank(needsYou('a', '/w'), NOW)).toBe(0)
    expect(sessionUrgencyRank(working('b', '/w'), NOW)).toBe(1)
    // A just-finished agent is attention, not background — it outranks working.
    expect(sessionUrgencyRank(idle('c', '/w'), NOW)).toBe(0)
    expect(
      sessionUrgencyRank(
        idle('d', '/w', { lastActiveAt: new Date(NOW - 48 * HOUR).toISOString() }),
        NOW,
      ),
    ).toBe(3)
    expect(sessionUrgencyRank(idle('e', '/w', { status: 'exited' }), NOW)).toBe(3)
  })

  it('a snoozed needs-you session is not rank 0', () => {
    const s = needsYou('a', '/w', { snoozedUntil: new Date(NOW + HOUR).toISOString() })
    expect(sessionUrgencyRank(s, NOW)).toBe(2)
  })

  it('mostUrgentSession returns the lowest-ranked child', () => {
    const urgent = needsYou('u', '/w')
    const olderIdle = idle('i1', '/w', { lastActiveAt: new Date(NOW - 2 * HOUR).toISOString() })
    expect(mostUrgentSession([working('w1', '/w'), urgent, olderIdle], NOW)).toBe(urgent)
    expect(mostUrgentSession([], NOW)).toBeUndefined()
  })
})

describe('rowUnreadEmphasized preserves unseen working activity', () => {
  const issueRow = (
    over: Partial<UnbrandIds<IssueNavigationModel>>,
    sessions: SessionView[] = [],
  ): Extract<UnifiedWorkRow, { kind: 'issue' }> => ({
    kind: 'issue',
    issue: issue(over),
    sessions,
    activityAt: NOW,
  })
  const wtRow = (sessions: SessionView[]): Extract<UnifiedWorkRow, { kind: 'worktree' }> => ({
    kind: 'worktree',
    worktree: navWt('/r/a/.worktrees/x', { isMain: false, sessions }),
    activityAt: NOW,
  })

  it('emphasizes an unread issue row with no working session', () => {
    expect(
      rowUnreadEmphasized(
        issueRow({ unread: true } as Partial<UnbrandIds<IssueNavigationModel>>, [idle('a', '/w')]),
      ),
    ).toBe(true)
  })

  it('emphasizes an unread issue row that has a currently-working session', () => {
    expect(
      rowUnreadEmphasized(
        issueRow({ unread: true } as Partial<UnbrandIds<IssueNavigationModel>>, [
          working('a', '/w'),
        ]),
      ),
    ).toBe(true)
  })

  it('emphasizes an unread worktree row that has a currently-working session', () => {
    expect(
      rowUnreadEmphasized(
        wtRow([idle('a', '/w', { unread: true } as Partial<SessionViewInput>), working('b', '/w')]),
      ),
    ).toBe(true)
  })

  it('leaves a read row un-emphasized regardless of working state', () => {
    expect(
      rowUnreadEmphasized(
        issueRow({ unread: false } as Partial<UnbrandIds<IssueNavigationModel>>, [
          working('a', '/w'),
        ]),
      ),
    ).toBe(false)
  })
})

describe('isIssueDeferred / issueReturnedFromDefer', () => {
  it('snoozed while deferUntil is in the future', () => {
    const future = new Date(NOW + HOUR).toISOString()
    expect(isIssueDeferred(issue({ deferUntil: future }), NOW)).toBe(true)
    expect(issueReturnedFromDefer(issue({ deferUntil: future }), NOW)).toBe(false)
  })
  it('returned-from-defer once deferUntil has lapsed but is still set', () => {
    const past = new Date(NOW - HOUR).toISOString()
    expect(isIssueDeferred(issue({ deferUntil: past }), NOW)).toBe(false)
    expect(issueReturnedFromDefer(issue({ deferUntil: past }), NOW)).toBe(true)
  })
  it('neither when deferUntil is unset', () => {
    expect(isIssueDeferred(issue(), NOW)).toBe(false)
    expect(issueReturnedFromDefer(issue(), NOW)).toBe(false)
  })
})

describe('archivedSessionsForIssue / archivedSessionsForWorktreePath', () => {
  it('returns only the archived members of an issue (issueId or containment)', () => {
    const live = sess('l', '/wt', { issueId: 'i' })
    const arch = sess('a', '/wt', { issueId: 'i', archived: true })
    const other = sess('o', '/wt', { issueId: 'j', archived: true })
    const got = archivedSessionsForIssue(
      issue({ id: 'i', worktreePath: '/wt' }),
      [live, arch, other],
      ['/wt'],
    )
    expect(got.map((s) => s.sessionId)).toEqual(['a'])
  })
  it('returns archived sessions contained in a worktree path', () => {
    const live = sess('l', '/wt')
    const arch = sess('a', '/wt', { archived: true })
    const got = archivedSessionsForWorktreePath([live, arch], '/wt', ['/wt'])
    expect(got.map((s) => s.sessionId)).toEqual(['a'])
  })
})

describe('repoUsageAt', () => {
  const wire = (path: string, worktrees: { path: string }[] = []) =>
    ({ path, kind: 'repository', worktrees }) as never
  it('takes the max session activity over the repo root and its worktrees', () => {
    const r = wire('/src/a', [{ path: '/src/a/.worktrees/x' }])
    const s1 = sess('s1', '/src/a/pkg', { lastActiveAt: new Date(NOW - 2 * HOUR).toISOString() })
    const s2 = sess('s2', '/src/a/.worktrees/x', {
      lastActiveAt: new Date(NOW - HOUR).toISOString(),
    })
    const other = sess('s3', '/src/b', { lastActiveAt: new Date(NOW).toISOString() })
    expect(repoUsageAt(r, [s1, s2, other])).toBe(NOW - HOUR)
    expect(repoUsageAt(wire('/src/never'), [s1, s2, other])).toBe(0)
  })
  it('does not match sibling path prefixes without a boundary', () => {
    const r = wire('/src/a')
    const s1 = sess('s1', '/src/a-other')
    expect(repoUsageAt(r, [s1])).toBe(0)
  })
})

describe('branchRollup (POD-171 L4)', () => {
  const DAY = 24 * HOUR
  // A three-deep formal tree: root > mid > leaf, with the needs-you at the leaf.
  const tree = () => {
    const root = issue({ id: 'root', seq: 1, title: 'Epic', audience: 'human' })
    const mid = issue({ id: 'mid', seq: 2, title: 'Mid', audience: 'human', parentId: 'root' })
    const leaf = issue({
      id: 'leaf',
      seq: 3,
      audience: 'agent' as unknown as IssueNavigationModel['audience'],
      parentId: 'mid',
    })
    return { root, mid, leaf }
  }
  it('L4: branchRollup counts ALL descendants via parentId — decayed done children included', () => {
    const { root, mid, leaf } = tree()
    // Done grandchild long past its decay window: gone from rows, kept in k/m.
    const settled = issue({
      id: 'settled',
      seq: 4,
      parentId: 'mid',
      stage: 'done',
      readAt: new Date(NOW - 30 * DAY).toISOString(),
      closedAt: new Date(NOW - 30 * DAY).toISOString(),
    })
    const ghost = issue({ id: 'ghost', seq: 5, parentId: 'mid', archived: true })
    expect(branchRollup([root, mid, leaf, settled, ghost], 'mid')).toEqual({ total: 2, done: 1 })
    expect(branchRollup([root, mid, leaf, settled, ghost], 'root')).toEqual({ total: 3, done: 1 })
    expect(branchRollup([root, mid, leaf, settled, ghost], 'leaf')).toEqual({ total: 0, done: 0 })
  })

})
