import type { GitRepositoryWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  agentBadge,
  chatActivity,
  defaultChatCapable,
  formatMemBytes,
  hostMemoryView,
  orderTabs,
  panelLabel,
  reposToViews,
  sessionsForWorktree,
  sidebarSections,
  sortSessionsForPins,
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
  it('lifts pinned panels, worktrees, and repos without duplicating them in lower groups', () => {
    const sessions = [session('/src/app'), session('/src/app-feat')]
    const sections = sidebarSections([repo], sessions, {
      panels: ['s-/src/app-feat'],
      worktrees: ['/src/app-feat'],
      repos: ['/src/app'],
    })

    expect(sections.pinnedPanels.map((panel) => panel.sessionId)).toEqual(['s-/src/app-feat'])
    expect(sections.pinnedWorktrees.map((worktree) => worktree.path)).toEqual(['/src/app-feat'])
    expect(sections.pinnedWorktrees[0].sessions).toEqual([])
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
