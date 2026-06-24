import type { GitRepositoryWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  agentBadge,
  chatActivity,
  defaultChatCapable,
  exitedRecovery,
  filterSidebarSections,
  formatMemBytes,
  hostMemoryView,
  isKnownWorktreePath,
  isSnoozed,
  orderTabs,
  orphanSessionFor,
  panelLabel,
  partitionWorkItems,
  reposToViews,
  sessionDotClass,
  sessionDotTone,
  sessionsForWorktree,
  sidebarSections,
  snoozeUntil1h,
  snoozeUntilTomorrow5am,
  sortRepos,
  sortSessionsForPins,
  sortSessionsForSidebar,
} from '../src/derive'

describe('defaultChatCapable', () => {
  it('offers chat for structured-transcript harnesses incl. codex, not shell', () => {
    expect(defaultChatCapable('claude-code')).toBe(true)
    expect(defaultChatCapable('grok')).toBe(true)
    expect(defaultChatCapable('codex')).toBe(true)
    expect(defaultChatCapable('opencode')).toBe(true)
    expect(defaultChatCapable('cursor')).toBe(true)
    expect(defaultChatCapable('shell')).toBe(false)
  })
})

const repo: GitRepositoryWire = {
  path: '/src/app',
  kind: 'repository',
  branch: 'main',
  worktrees: [{ path: '/src/app-feat', branch: 'feat' }],
}

const session = (cwd: string): SessionMeta => ({
  sessionId: `s-${cwd}`,
  agentKind: 'claude-code',
  title: 't',
  cwd,
  status: 'live',
  controllerId: null,
  geometry: { cols: 80, rows: 24 },
  epoch: 0,
  clientCount: 0,
  createdAt: '2026-06-03T00:00:00.000Z',
  lastActiveAt: '2026-06-03T00:00:00.000Z',
  origin: { kind: 'spawn' },
  archived: false,
})

describe('reposToViews', () => {
  it('lists the repo checkout as main plus linked worktrees', () => {
    const [view] = reposToViews([repo])
    expect(view.name).toBe('app')
    expect(view.worktrees).toEqual([
      { path: '/src/app', branch: 'main', repoPath: '/src/app', isMain: true },
      { path: '/src/app-feat', branch: 'feat', repoPath: '/src/app', isMain: false },
    ])
  })

  it('dedupes worktrees that also appear as standalone repo entries', () => {
    const parent: GitRepositoryWire = {
      path: '/src/app',
      kind: 'repository',
      branch: 'main',
      worktrees: [{ path: '/src/app-feat', branch: 'feat' }],
    }
    const standalone: GitRepositoryWire = {
      path: '/src/app-feat',
      kind: 'worktree',
      branch: 'feat',
      worktrees: [],
    }
    const views = reposToViews([parent, standalone])
    expect(views.map((v) => v.path)).toEqual(['/src/app'])
    expect(views[0].worktrees.map((w) => w.path)).toEqual(['/src/app', '/src/app-feat'])
  })
})

describe('sessionsForWorktree', () => {
  it('matches by exact cwd', () => {
    const all = [session('/src/app'), session('/src/app-feat')]
    expect(sessionsForWorktree(all, '/src/app-feat')).toHaveLength(1)
    expect(sessionsForWorktree(all, '/src/app-feat')[0].cwd).toBe('/src/app-feat')
  })
})

describe('isKnownWorktreePath', () => {
  it('is true for the repo checkout and its linked worktrees', () => {
    expect(isKnownWorktreePath([repo], '/src/app')).toBe(true)
    expect(isKnownWorktreePath([repo], '/src/app-feat')).toBe(true)
  })

  it('is false for a path that no live worktree covers (e.g. a removed worktree)', () => {
    expect(isKnownWorktreePath([repo], '/src/app-gone')).toBe(false)
  })

  it('is false when no repos are loaded', () => {
    expect(isKnownWorktreePath([], '/src/app')).toBe(false)
  })
})

describe('exitedRecovery', () => {
  it('a resumable agent resumes; a shell restarts; a dead-end agent is removed', () => {
    expect(
      exitedRecovery({ exitCode: 0, isShell: false, resumable: true, worktreeMissing: false })
        .action,
    ).toBe('resume')
    expect(
      exitedRecovery({ exitCode: 0, isShell: true, resumable: false, worktreeMissing: false })
        .action,
    ).toBe('restart')
    expect(
      exitedRecovery({ exitCode: 0, isShell: false, resumable: false, worktreeMissing: false })
        .action,
    ).toBe('remove')
  })

  it('forces remove and explains when the worktree is missing — even for a resumable agent', () => {
    const r = exitedRecovery({
      exitCode: 0,
      isShell: false,
      resumable: true,
      worktreeMissing: true,
    })
    expect(r.action).toBe('remove')
    expect(r.detail).toMatch(/worktree/i)
    expect(r.detail).toMatch(/can'?t be resumed/i)
  })

  it('a missing worktree also blocks a shell restart (its directory is gone)', () => {
    expect(
      exitedRecovery({ exitCode: 0, isShell: true, resumable: false, worktreeMissing: true })
        .action,
    ).toBe('remove')
  })

  it('names the worktree path in the notice when given one', () => {
    const r = exitedRecovery({
      exitCode: -1,
      isShell: false,
      resumable: true,
      worktreeMissing: true,
      worktreePath: '~/src/app-feat',
    })
    expect(r.detail).toContain('~/src/app-feat')
  })

  it('describes the exit cause when the worktree is intact', () => {
    expect(
      exitedRecovery({ exitCode: 137, isShell: false, resumable: true, worktreeMissing: false })
        .detail,
    ).toContain('137')
    expect(
      exitedRecovery({ exitCode: -1, isShell: false, resumable: true, worktreeMissing: false })
        .detail,
    ).toMatch(/failed to start/i)
  })
})

describe('orphanSessionFor', () => {
  const mk = (sessionId: string, cwd: string, archived = false): SessionMeta => ({
    ...session(cwd),
    sessionId,
    archived,
  })

  it('is null when nothing is selected', () => {
    expect(
      orphanSessionFor({ selectedWorktree: null, sessions: [mk('a', '/gone')], paneA: 'a' }),
    ).toBeNull()
  })

  it('is null when the selected path still has no sessions', () => {
    expect(
      orphanSessionFor({
        selectedWorktree: '/gone',
        sessions: [mk('a', '/elsewhere')],
        paneA: null,
      }),
    ).toBeNull()
  })

  it('surfaces the pane-A session when it is an orphan of the selected path', () => {
    const sessions = [mk('a', '/gone'), mk('b', '/gone')]
    expect(orphanSessionFor({ selectedWorktree: '/gone', sessions, paneA: 'b' })?.sessionId).toBe(
      'b',
    )
  })

  it('falls back to the first orphan when pane A is not one of them', () => {
    const sessions = [mk('a', '/gone'), mk('b', '/gone')]
    expect(orphanSessionFor({ selectedWorktree: '/gone', sessions, paneA: null })?.sessionId).toBe(
      'a',
    )
  })

  it('ignores archived sessions', () => {
    const sessions = [mk('a', '/gone', true)]
    expect(orphanSessionFor({ selectedWorktree: '/gone', sessions, paneA: 'a' })).toBeNull()
  })
})

describe('panelLabel', () => {
  it('maps agent kinds to display names', () => {
    expect(panelLabel('claude-code')).toBe('Claude')
    expect(panelLabel('codex')).toBe('Codex')
    expect(panelLabel('grok')).toBe('Grok')
    expect(panelLabel('opencode')).toBe('OpenCode')
    expect(panelLabel('shell')).toBe('Shell')
  })
})

describe('hostMemoryView', () => {
  const GIB = 1024 ** 3
  const host = (availableGib: number, totalGib = 32) => ({
    hostname: 'podium-host',
    sampledAt: '2026-06-11T00:00:00.000Z',
    memory: {
      totalBytes: totalGib * GIB,
      availableBytes: availableGib * GIB,
      swapTotalBytes: 8 * GIB,
      swapFreeBytes: 6 * GIB,
    },
  })

  it('shows used = total − available (never total − free)', () => {
    const v = hostMemoryView(host(20))
    expect(v.label).toBe('12.0/32 GB')
    expect(v.pct).toBe(38)
    expect(v.severity).toBe('ok')
    expect(v.hostname).toBe('podium-host')
  })

  it('grades severity at 75% and 90%', () => {
    expect(hostMemoryView(host(32 * 0.26)).severity).toBe('ok')
    expect(hostMemoryView(host(32 * 0.2)).severity).toBe('warn') // 80% used
    expect(hostMemoryView(host(32 * 0.05)).severity).toBe('critical') // 95% used
  })

  it('mentions swap in the tooltip but never the headline', () => {
    const v = hostMemoryView(host(20))
    expect(v.label).not.toMatch(/swap/i)
    expect(v.title).toContain('swap 2.0/8 GB')
    expect(v.title).toContain('podium-host')
  })

  it('omits swap from the tooltip on swapless machines', () => {
    const h = host(20)
    h.memory.swapTotalBytes = 0
    h.memory.swapFreeBytes = 0
    expect(hostMemoryView(h).title).not.toMatch(/swap/i)
  })

  it('clamps a pathological available > total to 0% used', () => {
    expect(hostMemoryView(host(64)).pct).toBe(0)
  })
})

describe('formatMemBytes', () => {
  const GIB = 1024 ** 3
  it('uses GB with one decimal from 1 GiB up', () => {
    expect(formatMemBytes(12.34 * GIB)).toBe('12.3 GB')
    expect(formatMemBytes(1 * GIB)).toBe('1.0 GB')
  })
  it('uses whole MB below 1 GiB', () => {
    expect(formatMemBytes(0.5 * GIB)).toBe('512 MB')
    expect(formatMemBytes(0)).toBe('0 MB')
  })
})

describe('pin-aware navigation derivation', () => {
  it('lifts pinned worktrees/repos out of lower groups, but keeps pinned panels in their worktree too', () => {
    const sessions = [session('/src/app'), session('/src/app-feat')]
    const sections = sidebarSections([repo], sessions, {
      panels: ['s-/src/app-feat'],
      worktrees: ['/src/app-feat'],
      repos: ['/src/app'],
    })

    // A pinned panel is lifted into PINNED PANELS *and* still shown in its own
    // worktree (so it appears in both places, selected in both).
    expect(sections.pinnedPanels.map((panel) => panel.sessionId)).toEqual(['s-/src/app-feat'])
    expect(sections.pinnedWorktrees.map((worktree) => worktree.path)).toEqual(['/src/app-feat'])
    expect(sections.pinnedWorktrees[0].sessions.map((panel) => panel.sessionId)).toEqual([
      's-/src/app-feat',
    ])
    expect(sections.pinnedRepos.map((pinnedRepo) => pinnedRepo.path)).toEqual(['/src/app'])
    expect(sections.pinnedRepos[0].worktrees.map((worktree) => worktree.path)).toEqual(['/src/app'])
    expect(sections.pinnedRepos[0].worktrees[0].sessions.map((panel) => panel.sessionId)).toEqual([
      's-/src/app',
    ])
    expect(sections.repos).toEqual([])
  })

  it('keeps an empty pinned repo visible so it can be unpinned', () => {
    const sections = sidebarSections([repo], [], {
      panels: [],
      worktrees: ['/src/app', '/src/app-feat'],
      repos: ['/src/app'],
    })

    expect(sections.pinnedRepos.map((pinnedRepo) => pinnedRepo.path)).toEqual(['/src/app'])
    expect(sections.pinnedRepos[0].worktrees).toEqual([])
    expect(sections.repos).toEqual([])
  })

  it('orders pinned panels first in tab strips', () => {
    const sessions = [session('/src/app'), { ...session('/src/app'), sessionId: 'pinned' }]

    expect(
      sortSessionsForPins(sessions, { panels: ['pinned'], worktrees: [], repos: [] }).map(
        (s) => s.sessionId,
      ),
    ).toEqual(['pinned', 's-/src/app'])
  })
})

describe('orderTabs', () => {
  const noPins = { panels: [], worktrees: [], repos: [] }
  const named = (id: string): SessionMeta => ({ ...session('/src/app'), sessionId: id })

  it('falls back to the pin-aware order when no manual order exists', () => {
    const sessions = [named('a'), named('pinned')]
    const pins = { panels: ['pinned'], worktrees: [], repos: [] }
    expect(orderTabs(sessions, undefined, pins).map((s) => s.sessionId)).toEqual(['pinned', 'a'])
    expect(orderTabs(sessions, [], pins).map((s) => s.sessionId)).toEqual(['pinned', 'a'])
  })

  it('applies the manual order, beating pin order', () => {
    const sessions = [named('a'), named('b'), named('c')]
    const pins = { panels: ['c'], worktrees: [], repos: [] }
    expect(orderTabs(sessions, ['b', 'a', 'c'], pins).map((s) => s.sessionId)).toEqual([
      'b',
      'a',
      'c',
    ])
  })

  it('appends sessions unknown to the manual order at the end', () => {
    const sessions = [named('new'), named('a'), named('b')]
    expect(orderTabs(sessions, ['b', 'a'], noPins).map((s) => s.sessionId)).toEqual([
      'b',
      'a',
      'new',
    ])
  })

  it('ignores manual entries whose sessions are gone', () => {
    const sessions = [named('a')]
    expect(orderTabs(sessions, ['dead', 'a'], noPins).map((s) => s.sessionId)).toEqual(['a'])
  })
})

const stateAt = (
  phase: NonNullable<SessionMeta['agentState']>['phase'],
  extra: Record<string, unknown> = {},
) =>
  ({ phase, since: '2026-06-12T10:00:00.000Z', openTaskCount: 0, ...extra }) as NonNullable<
    SessionMeta['agentState']
  >
const sessionWithState = (agentState?: SessionMeta['agentState']): SessionMeta => ({
  ...session('/src/app'),
  ...(agentState ? { agentState } : {}),
})

describe('agentBadge', () => {
  it('hides for uninstrumented or unknown sessions', () => {
    expect(agentBadge(sessionWithState())).toBeNull()
    expect(agentBadge(sessionWithState(stateAt('unknown')))).toBeNull()
  })

  it('working / compacting are calm working tones', () => {
    expect(agentBadge(sessionWithState(stateAt('working')))).toEqual({
      label: 'working',
      tone: 'working',
      showContinue: false,
    })
    expect(agentBadge(sessionWithState(stateAt('compacting')))).toEqual({
      label: 'compacting',
      tone: 'working',
      showContinue: false,
    })
  })

  it('idle verdicts: done/interrupted are calm, actionable blockers want attention', () => {
    expect(agentBadge(sessionWithState(stateAt('idle', { idle: { kind: 'done' } })))).toEqual({
      label: 'idle',
      tone: 'idle',
      showContinue: false,
    })
    expect(
      agentBadge(sessionWithState(stateAt('idle', { idle: { kind: 'interrupted' } }))),
    ).toEqual({
      label: 'interrupted',
      tone: 'idle',
      showContinue: false,
    })
    expect(
      agentBadge(
        sessionWithState(stateAt('idle', { idle: { kind: 'question', summary: 'A or B?' } })),
      )?.tone,
    ).toBe('attention')
    expect(
      agentBadge(sessionWithState(stateAt('idle', { idle: { kind: 'approval' } })))?.label,
    ).toBe('plan ready')
    expect(
      agentBadge(sessionWithState(stateAt('idle', { idle: { kind: 'open_todos' } })))?.label,
    ).toBe('todos open')
  })

  it('needs_user is attention with the need spelled out', () => {
    expect(
      agentBadge(sessionWithState(stateAt('needs_user', { need: { kind: 'permission' } }))),
    ).toEqual({
      label: 'needs permission',
      tone: 'attention',
      showContinue: false,
    })
    expect(
      agentBadge(sessionWithState(stateAt('needs_user', { need: { kind: 'question' } })))?.label,
    ).toBe('needs answer')
  })

  it('errored shows the class; Continue only when retryable', () => {
    expect(
      agentBadge(
        sessionWithState(stateAt('errored', { error: { class: 'rate_limit', retryable: true } })),
      ),
    ).toEqual({
      label: 'error: rate_limit',
      tone: 'error',
      showContinue: true,
    })
    expect(
      agentBadge(
        sessionWithState(
          stateAt('errored', { error: { class: 'billing_error', retryable: false } }),
        ),
      )?.showContinue,
    ).toBe(false)
  })

  it('ended is muted', () => {
    expect(agentBadge(sessionWithState(stateAt('ended')))).toEqual({
      label: 'ended',
      tone: 'muted',
      showContinue: false,
    })
  })
})

describe('partitionWorkItems', () => {
  // Real phase values: 'idle' | 'working' | 'compacting' | 'needs_user' | 'errored' | 'ended' | 'unknown'
  // Real status values: 'live' | 'starting' | 'reconnecting' | 'hibernated' | 'exited'
  const s = (
    id: string,
    phase: NonNullable<SessionMeta['agentState']>['phase'] | null,
    status: SessionMeta['status'] = 'live',
  ): SessionMeta => ({
    sessionId: id,
    agentKind: 'claude-code',
    title: id,
    cwd: '/src',
    status,
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-06-01T00:00:00.000Z',
    lastActiveAt: '2026-06-01T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    ...(phase != null ? { agentState: { phase, since: '', openTaskCount: 0 } } : {}),
  })

  it('partitions sessions by state and also lists pinned ones in pinnedPanels', () => {
    // 'idle' → attention, 'working' → working, 'needs_user' → attention
    const sessions = [s('a', 'idle'), s('b', 'working'), s('c', 'needs_user'), s('p', 'working')]
    const { attention, working, pinnedPanels } = partitionWorkItems(sessions, new Set(['p']))
    expect(attention.map((x) => x.sessionId)).toEqual(['a', 'c'])
    expect(working.map((x) => x.sessionId)).toEqual(['b', 'p'])
    expect(pinnedPanels.map((x) => x.sessionId)).toEqual(['p'])
  })

  it('excludes archived sessions from all buckets', () => {
    const archived: SessionMeta = { ...s('z', 'idle'), archived: true }
    const { attention, working, pinnedPanels } = partitionWorkItems([archived], new Set())
    expect(attention).toHaveLength(0)
    expect(working).toHaveLength(0)
    expect(pinnedPanels).toHaveLength(0)
  })

  it('pinned sessions still appear in attention or working based on state', () => {
    const { attention, working, pinnedPanels } = partitionWorkItems(
      [s('p', 'needs_user')],
      new Set(['p']),
    )
    expect(attention.map((x) => x.sessionId)).toEqual(['p'])
    expect(working).toHaveLength(0)
    expect(pinnedPanels.map((x) => x.sessionId)).toEqual(['p'])
  })

  it('compacting phase goes to working', () => {
    const { working } = partitionWorkItems([s('c', 'compacting')], new Set())
    expect(working.map((x) => x.sessionId)).toEqual(['c'])
  })

  it('errored phase goes to attention', () => {
    const { attention } = partitionWorkItems([s('e', 'errored')], new Set())
    expect(attention.map((x) => x.sessionId)).toEqual(['e'])
  })

  it('exited status (uninstrumented) goes to attention (idle group)', () => {
    const { attention } = partitionWorkItems([s('x', null, 'exited')], new Set())
    expect(attention.map((x) => x.sessionId)).toEqual(['x'])
  })

  it('returns empty buckets for an empty input', () => {
    const result = partitionWorkItems([], new Set())
    expect(result).toEqual({ attention: [], working: [], pinnedPanels: [] })
  })
})

describe('sortRepos', () => {
  const r = (id: string) => ({ id, name: id.toUpperCase() })
  it('sorts by mode', () => {
    const repos = [r('b'), r('a'), r('c')]
    const lu = new Map([
      ['a', 1],
      ['b', 3],
      ['c', 2],
    ])
    expect(sortRepos(repos, 'alphabetical', [], lu).map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(sortRepos(repos, 'lastUsed', [], lu).map((x) => x.id)).toEqual(['b', 'c', 'a'])
    expect(sortRepos(repos, 'custom', ['c', 'a'], lu).map((x) => x.id)).toEqual(['c', 'a', 'b'])
  })

  it('alphabetical is case-insensitive locale sort', () => {
    const repos = [r('Zebra'), r('apple'), r('Mango')]
    expect(sortRepos(repos, 'alphabetical', [], new Map()).map((x) => x.id)).toEqual([
      'apple',
      'Mango',
      'Zebra',
    ])
  })

  it('lastUsed puts unknown lastUsedAt at end, tiebreaks by name', () => {
    const repos = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ]
    const lu = new Map([['b', 5]])
    // b (ts=5), then a and c (ts=0) sorted by name
    expect(sortRepos(repos, 'lastUsed', [], lu).map((x) => x.id)).toEqual(['b', 'a', 'c'])
  })

  it('custom appends unknown ids in lastUsed order', () => {
    const repos = [
      { id: 'x', name: 'X' },
      { id: 'y', name: 'Y' },
      { id: 'z', name: 'Z' },
    ]
    const lu = new Map([
      ['z', 10],
      ['y', 5],
    ])
    // order=['x'], then z (ts=10), y (ts=5)
    expect(sortRepos(repos, 'custom', ['x'], lu).map((x) => x.id)).toEqual(['x', 'z', 'y'])
  })
})

const base = (over: Partial<SessionMeta>): SessionMeta =>
  ({
    sessionId: 's',
    agentKind: 'claude-code',
    title: 't',
    cwd: '/',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '',
    lastActiveAt: '',
    origin: { kind: 'spawn' },
    archived: false,
    ...over,
  }) as SessionMeta

describe('chatActivity', () => {
  it('shows Working… while the agent phase is working', () => {
    expect(
      chatActivity(base({ agentState: { phase: 'working', since: '', openTaskCount: 0 } }), false),
    ).toEqual({ label: 'Working…', tone: 'working' })
  })
  it('shows Compacting… while compacting', () => {
    expect(
      chatActivity(
        base({ agentState: { phase: 'compacting', since: '', openTaskCount: 0 } }),
        false,
      ),
    ).toEqual({ label: 'Compacting…', tone: 'working' })
  })
  it('surfaces attention states (needs answer)', () => {
    expect(
      chatActivity(
        base({
          agentState: {
            phase: 'needs_user',
            since: '',
            openTaskCount: 0,
            need: { kind: 'question' },
          },
        }),
        false,
      ),
    ).toEqual({ label: 'needs answer', tone: 'attention' })
  })
  it('falls back to PTY busy for uninstrumented kinds', () => {
    expect(chatActivity(base({ agentKind: 'shell', busy: true }), false)).toEqual({
      label: 'Working…',
      tone: 'working',
    })
  })
  it('shows Sending… optimistically right after submit, before any signal', () => {
    expect(
      chatActivity(base({ agentState: { phase: 'idle', since: '', openTaskCount: 0 } }), true),
    ).toEqual({ label: 'Sending…', tone: 'working' })
  })
  it('shows nothing when idle and not just-sent', () => {
    expect(
      chatActivity(base({ agentState: { phase: 'idle', since: '', openTaskCount: 0 } }), false),
    ).toBeNull()
    expect(chatActivity(undefined, false)).toBeNull()
  })
})

describe('sessionDotTone', () => {
  it('maps live phases to semantic tones', () => {
    expect(
      sessionDotTone(base({ agentState: { phase: 'working', since: '', openTaskCount: 0 } })),
    ).toBe('working')
    expect(
      sessionDotTone(
        base({
          agentState: {
            phase: 'needs_user',
            since: '',
            openTaskCount: 0,
            need: { kind: 'question' },
          },
        }),
      ),
    ).toBe('attention')
    expect(
      sessionDotTone(base({ agentState: { phase: 'idle', since: '', openTaskCount: 0 } })),
    ).toBe('ready')
  })

  it('keeps the last real tone on a hibernated session (#57), not grey', () => {
    // A hibernated agent that needed input still reads yellow — hibernation rides
    // on the grayed/italic row, not on draining the dot to grey.
    expect(
      sessionDotTone(
        base({
          status: 'hibernated',
          agentState: {
            phase: 'needs_user',
            since: '',
            openTaskCount: 0,
            need: { kind: 'question' },
          },
        }),
      ),
    ).toBe('attention')
    expect(
      sessionDotTone(
        base({
          status: 'hibernated',
          agentState: { phase: 'working', since: '', openTaskCount: 0 },
        }),
      ),
    ).toBe('working')
  })

  it('still drains an exited session to grey (phase is cleared server-side)', () => {
    expect(sessionDotTone(base({ status: 'exited' }))).toBe('neutral')
  })
})

describe('sessionDotClass', () => {
  it('adds the breathing-glow class for a live working dot only (#102)', () => {
    const working = sessionDotClass(
      base({ agentState: { phase: 'working', since: '', openTaskCount: 0 } }),
    )
    expect(working).toContain('dot-working')
    expect(working).toContain('bg-emerald-500')
  })

  it('does not animate a hibernated dot even if its last tone was working', () => {
    const cls = sessionDotClass(
      base({ status: 'hibernated', agentState: { phase: 'working', since: '', openTaskCount: 0 } }),
    )
    expect(cls).toContain('parked')
    expect(cls).not.toContain('dot-working')
  })

  it('does not animate non-working tones', () => {
    expect(
      sessionDotClass(base({ agentState: { phase: 'idle', since: '', openTaskCount: 0 } })),
    ).not.toContain('dot-working')
  })
})

describe('pinned panel ordering & co-location', () => {
  const work = (cwd: string, id: string): SessionMeta => ({
    ...session(cwd),
    sessionId: id,
    agentState: { phase: 'working', since: '', openTaskCount: 0 },
  })
  const needs = (cwd: string, id: string): SessionMeta => ({
    ...session(cwd),
    sessionId: id,
    agentState: { phase: 'needs_user', since: '', openTaskCount: 0, need: { kind: 'question' } },
  })

  it('orders pinned panels by agent state, not pin-insertion order (#105)', () => {
    // Pin a working one first, then a needs-you one — the comparator should sink
    // the working panel below the needs-you one regardless of pin order.
    const sessions = [work('/src/app', 'w'), needs('/src/app', 'n')]
    const sections = sidebarSections([repo], sessions, {
      panels: ['w', 'n'],
      worktrees: [],
      repos: [],
    })
    expect(sections.pinnedPanels.map((p) => p.sessionId)).toEqual(['n', 'w'])
  })
})

describe('filterSidebarSections (#100)', () => {
  const sessions = [session('/src/app'), session('/src/app-feat')]
  const noPins = { panels: [], worktrees: [], repos: [] }

  it('passes everything through on an empty/whitespace query', () => {
    const sections = sidebarSections([repo], sessions, noPins)
    expect(filterSidebarSections(sections, '')).toBe(sections)
    expect(filterSidebarSections(sections, '   ')).toBe(sections)
  })

  it('keeps a repo and all its worktrees when the repo name matches', () => {
    const sections = sidebarSections([repo], sessions, noPins)
    const filtered = filterSidebarSections(sections, 'APP') // case-insensitive
    expect(filtered.repos).toHaveLength(1)
    expect(filtered.repos[0].worktrees.map((w) => w.path)).toEqual(['/src/app', '/src/app-feat'])
  })

  it('narrows to only the matching worktree when matching a branch', () => {
    const sections = sidebarSections([repo], sessions, noPins)
    const filtered = filterSidebarSections(sections, 'feat')
    expect(filtered.repos).toHaveLength(1)
    expect(filtered.repos[0].worktrees.map((w) => w.path)).toEqual(['/src/app-feat'])
  })

  it('matches on path and drops repos with no match', () => {
    const sections = sidebarSections([repo], sessions, noPins)
    expect(filterSidebarSections(sections, 'nonexistent').repos).toEqual([])
    expect(
      filterSidebarSections(sections, '/src/app-feat').repos[0].worktrees.map((w) => w.path),
    ).toEqual(['/src/app-feat'])
  })

  it('leaves pinned panels untouched (they are a flat reach-list)', () => {
    const sections = sidebarSections([repo], sessions, {
      panels: ['s-/src/app-feat'],
      worktrees: [],
      repos: [],
    })
    expect(
      filterSidebarSections(sections, 'nonexistent').pinnedPanels.map((p) => p.sessionId),
    ).toEqual(['s-/src/app-feat'])
  })
})

const NOW = Date.parse('2026-06-19T12:00:00.000Z')
const withState = (
  s: SessionMeta,
  phase: NonNullable<SessionMeta['agentState']>['phase'],
  extra: Record<string, unknown> = {},
): SessionMeta => ({
  ...s,
  agentState: {
    phase,
    since: '2026-06-19T00:00:00.000Z',
    openTaskCount: 0,
    ...extra,
  } as NonNullable<SessionMeta['agentState']>,
})

describe('isSnoozed', () => {
  it('undefined=never, null=always, timed=until deadline', () => {
    const s = session('/w')
    expect(isSnoozed(s, NOW)).toBe(false)
    expect(isSnoozed({ ...s, snoozedUntil: null }, NOW)).toBe(true)
    expect(isSnoozed({ ...s, snoozedUntil: '2026-06-19T13:00:00.000Z' }, NOW)).toBe(true)
    expect(isSnoozed({ ...s, snoozedUntil: '2026-06-19T11:00:00.000Z' }, NOW)).toBe(false)
  })
})

describe('snooze time helpers', () => {
  it('1h adds an hour', () => {
    expect(snoozeUntil1h(NOW)).toBe(new Date(NOW + 3_600_000).toISOString())
  })
  it('tomorrow = next 5am local strictly after now', () => {
    const out = Date.parse(snoozeUntilTomorrow5am(NOW))
    const d = new Date(out)
    expect(d.getHours()).toBe(5)
    expect(out).toBeGreaterThan(NOW)
    // strictly the *next* 5am: no more than 24h away
    expect(out - NOW).toBeLessThanOrEqual(24 * 3_600_000)
  })
})

describe('partitionWorkItems with snooze', () => {
  it('excludes an effectively-snoozed needs_user session from attention', () => {
    const needs = withState(session('/w'), 'needs_user')
    const snoozed = { ...withState(session('/w2'), 'needs_user'), snoozedUntil: null }
    const { attention } = partitionWorkItems([needs, snoozed], new Set(), NOW)
    expect(attention.map((s) => s.sessionId)).toEqual([needs.sessionId])
  })
  it('a lapsed timed snooze re-enters attention', () => {
    const lapsed = {
      ...withState(session('/w'), 'needs_user'),
      snoozedUntil: '2026-06-19T11:00:00.000Z',
    }
    const { attention } = partitionWorkItems([lapsed], new Set(), NOW)
    expect(attention).toHaveLength(1)
  })
  it('orders the attention bucket most-recently-active first', () => {
    const older = {
      ...withState(session('/w'), 'needs_user'),
      sessionId: 'older',
      lastActiveAt: '2026-06-19T10:00:00.000Z',
    }
    const newer = {
      ...withState(session('/w'), 'needs_user'),
      sessionId: 'newer',
      lastActiveAt: '2026-06-19T12:00:00.000Z',
    }
    // Fed oldest-first; the bucket must come back newest-first (matches the home board).
    const { attention } = partitionWorkItems([older, newer], new Set(), NOW)
    expect(attention.map((s) => s.sessionId)).toEqual(['newer', 'older'])
  })
})

describe('sortSessionsForSidebar with snooze', () => {
  it('orders non-snoozed attention, then snoozed attention, then working', () => {
    const att = withState(session('/a'), 'needs_user')
    const snoozedAtt = { ...withState(session('/b'), 'needs_user'), snoozedUntil: null }
    const working = withState(session('/c'), 'working')
    const out = sortSessionsForSidebar([working, snoozedAtt, att], NOW)
    expect(out.map((s) => s.sessionId)).toEqual([
      att.sessionId,
      snoozedAtt.sessionId,
      working.sessionId,
    ])
  })
})
