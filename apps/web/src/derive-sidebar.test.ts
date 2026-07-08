import type { GitRepositoryWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  dedupeSessionsByResume,
  EMPTY_PINS,
  partitionStaleSessions,
  sessionsForWorktree,
  sidebarSections,
  worktreeForCwd,
} from './derive'

const NOW = Date.parse('2026-06-21T12:00:00.000Z')

/** Minimal session: idle/done (non-working) by default, last active `hoursAgo`. */
function sess(id: string, hoursAgo: number, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: id,
    lastActiveAt: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
    agentKind: 'claude-code',
    status: 'hibernated',
    busy: false,
    archived: false,
    agentState: { phase: 'idle', since: '', openTaskCount: 0, idle: { kind: 'done' } },
    ...over,
  } as unknown as SessionMeta
}

const working = (id: string, hoursAgo: number): SessionMeta =>
  sess(id, hoursAgo, {
    status: 'live',
    agentState: { phase: 'working', since: '', openTaskCount: 0 },
  } as Partial<SessionMeta>)

describe('worktreeForCwd', () => {
  const roots = ['/repo', '/repo/.worktrees/feat', '/other']

  it('picks the LONGEST containing root, so a worktree beats its parent repo', () => {
    expect(worktreeForCwd('/repo/.worktrees/feat/apps/web', roots)).toBe('/repo/.worktrees/feat')
    expect(worktreeForCwd('/repo/packages/web', roots)).toBe('/repo')
    expect(worktreeForCwd('/repo', roots)).toBe('/repo')
  })

  it('does not match sibling prefixes without a path boundary', () => {
    expect(worktreeForCwd('/repo-two/src', roots)).toBeNull()
  })

  it('returns null when no root contains the cwd', () => {
    expect(worktreeForCwd('/tmp/scratch', roots)).toBeNull()
  })
})

describe('sessionsForWorktree (containment grouping)', () => {
  const roots = ['/repo', '/repo/.worktrees/feat']
  const at = (id: string, cwd: string): SessionMeta => sess(id, 1, { cwd } as Partial<SessionMeta>)

  it('a session whose cwd is a SUBDIRECTORY of the worktree still shows in it', () => {
    const list = [at('a', '/repo/packages/web'), at('b', '/repo')]
    expect(sessionsForWorktree(list, '/repo', roots).map((s) => s.sessionId)).toEqual(['a', 'b'])
  })

  it('a session inside a nested worktree does NOT show in the parent repo group', () => {
    const list = [at('a', '/repo/.worktrees/feat/sub'), at('b', '/repo')]
    expect(sessionsForWorktree(list, '/repo', roots).map((s) => s.sessionId)).toEqual(['b'])
    expect(sessionsForWorktree(list, '/repo/.worktrees/feat', roots).map((s) => s.sessionId)).toEqual(['a'])
  })

  it('falls back to exact-match when no root list is given (legacy callers)', () => {
    const list = [at('a', '/repo/packages/web'), at('b', '/repo')]
    expect(sessionsForWorktree(list, '/repo').map((s) => s.sessionId)).toEqual(['b'])
  })
})

describe('sidebarSections (containment grouping)', () => {
  it('a session stamped with a subdirectory cwd shows under its containing worktree', () => {
    const repos: GitRepositoryWire[] = [
      {
        path: '/repo',
        kind: 'repository',
        branch: 'main',
        worktrees: [{ path: '/repo/.worktrees/feat', branch: 'feat' }],
      },
    ]
    const sessions = [
      sess('inMain', 1, { cwd: '/repo/packages/web' } as Partial<SessionMeta>),
      sess('inFeat', 1, { cwd: '/repo/.worktrees/feat/apps' } as Partial<SessionMeta>),
    ]
    const sections = sidebarSections(repos, sessions, EMPTY_PINS, NOW)
    const worktrees = sections.repos.flatMap((r) => r.worktrees)
    const byPath = (p: string) =>
      worktrees.find((w) => w.path === p)?.sessions.map((s) => s.sessionId) ?? []
    expect(byPath('/repo')).toEqual(['inMain'])
    expect(byPath('/repo/.worktrees/feat')).toEqual(['inFeat'])
  })

  it('attaches non-archived issues to their worktree; shells never appear in sidebar sessions', () => {
    const repos: GitRepositoryWire[] = [
      {
        path: '/repo',
        kind: 'repository',
        branch: 'main',
        worktrees: [{ path: '/repo/.worktrees/feat', branch: 'feat' }],
      },
    ]
    const issue = (id: string, over: Record<string, unknown>) =>
      ({
        id,
        title: id,
        stage: 'in_progress',
        repoPath: '/repo',
        archived: false,
        worktreePath: '/repo/.worktrees/feat',
        updatedAt: new Date(NOW).toISOString(),
        ...over,
      }) as unknown as import('@podium/protocol').IssueWire
    const issues = [
      issue('live-1', {}),
      issue('live-2', {}), // two issues may own the same worktree
      issue('archived', { archived: true }),
      issue('unstarted', { worktreePath: null }),
    ]
    const sessions = [
      sess('agent', 1, { cwd: '/repo/.worktrees/feat' } as Partial<SessionMeta>),
      sess('sh', 1, { cwd: '/repo/.worktrees/feat', agentKind: 'shell' } as Partial<SessionMeta>),
    ]
    const sections = sidebarSections(repos, sessions, EMPTY_PINS, NOW, issues)
    const worktrees = sections.repos.flatMap((r) => r.worktrees)
    const feat = worktrees.find((w) => w.path === '/repo/.worktrees/feat')
    expect(feat?.issues.map((i) => i.id)).toEqual(['live-1', 'live-2'])
    expect(worktrees.find((w) => w.path === '/repo')?.issues).toEqual([])
    // The shell is filtered out of every sidebar session list.
    expect(feat?.sessions.map((s) => s.sessionId)).toEqual(['agent'])
  })
})

describe('partitionStaleSessions', () => {
  it('keeps everything visible when 5 or fewer sessions', () => {
    const list = [sess('a', 100), sess('b', 100), sess('c', 100), sess('d', 100), sess('e', 100)]
    const { visible, stale } = partitionStaleSessions(list, NOW)
    expect(stale).toEqual([])
    expect(visible).toHaveLength(5)
  })

  it('keeps everything visible when 3 or fewer stale candidates', () => {
    // 6 total but only 3 are old & non-working.
    const list = [
      sess('old1', 20),
      sess('old2', 20),
      sess('old3', 20),
      sess('fresh1', 1),
      sess('fresh2', 1),
      sess('fresh3', 1),
    ]
    const { stale } = partitionStaleSessions(list, NOW)
    expect(stale).toEqual([])
  })

  it('collapses stale candidates past the 3 most-recently-active', () => {
    // 7 total, 5 stale candidates (>16h, non-working) + 2 fresh.
    const list = [
      sess('s1', 17),
      sess('s2', 18),
      sess('s3', 19),
      sess('s4', 20),
      sess('s5', 21),
      sess('fresh1', 1),
      sess('fresh2', 2),
    ]
    const { visible, stale } = partitionStaleSessions(list, NOW)
    // The 3 most-recently-active candidates (s1,s2,s3) stay; s4,s5 collapse.
    expect(stale.map((s) => s.sessionId).sort()).toEqual(['s4', 's5'])
    expect(visible.map((s) => s.sessionId)).toContain('s1')
    expect(visible.map((s) => s.sessionId)).toContain('fresh1')
    expect(visible.map((s) => s.sessionId)).not.toContain('s4')
  })

  it('never collapses working sessions even if old', () => {
    const list = [
      working('w1', 50),
      working('w2', 50),
      sess('s1', 17),
      sess('s2', 18),
      sess('s3', 19),
      sess('s4', 20),
      sess('s5', 21),
    ]
    const { stale } = partitionStaleSessions(list, NOW)
    expect(stale.every((s) => s.sessionId.startsWith('s'))).toBe(true)
    expect(stale.map((s) => s.sessionId).sort()).toEqual(['s4', 's5'])
  })
})

function withResume(
  id: string,
  status: SessionMeta['status'],
  resumeValue: string | undefined,
  hoursAgo = 1,
): SessionMeta {
  return sess(id, hoursAgo, {
    status,
    ...(resumeValue ? { resume: { kind: 'codex-thread', value: resumeValue } } : {}),
  } as Partial<SessionMeta>)
}

describe('dedupeSessionsByResume', () => {
  it('keeps sessions with no resume ref untouched', () => {
    const list = [withResume('a', 'live', undefined), withResume('b', 'live', undefined)]
    expect(dedupeSessionsByResume(list).map((s) => s.sessionId)).toEqual(['a', 'b'])
  })

  it('collapses two rows sharing a codex thread, keeping the live one', () => {
    const list = [
      withResume('exited-twin', 'exited', 'thread-1', 5),
      withResume('live-one', 'live', 'thread-1', 1),
      withResume('other', 'live', 'thread-2', 1),
    ]
    const out = dedupeSessionsByResume(list)
    expect(out.map((s) => s.sessionId).sort()).toEqual(['live-one', 'other'])
  })

  it('keeps the most-recently-active when statuses tie', () => {
    const list = [
      withResume('old', 'exited', 'thread-9', 10),
      withResume('new', 'exited', 'thread-9', 1),
    ]
    expect(dedupeSessionsByResume(list).map((s) => s.sessionId)).toEqual(['new'])
  })
})

