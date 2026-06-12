import type { ConversationSummaryWire, GitRepositoryWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  agentBadge,
  formatMemBytes,
  hostMemoryView,
  mergeResumable,
  panelLabel,
  reposToViews,
  resumableForRepoFallback,
  resumableForWorktree,
  sessionsForWorktree,
} from '../src/derive'

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
  origin: { kind: 'spawn' },
})

const conv = (projectPath: string, id: string): ConversationSummaryWire => ({
  id,
  agentKind: 'claude-code',
  providerId: 'p',
  projectPath,
  resume: { kind: 'claude-session', value: id },
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

describe('resumable matching', () => {
  it('worktree gets exact projectPath matches', () => {
    const all = [conv('/src/app-feat', 'a'), conv('/src/app', 'b')]
    expect(resumableForWorktree(all, '/src/app-feat').map((c) => c.id)).toEqual(['a'])
  })
  it('repo fallback gets under-repo convs not matched to any worktree', () => {
    const all = [conv('/src/app', 'b'), conv('/src/app-feat', 'a'), conv('/src/other', 'z')]
    const wtPaths = ['/src/app', '/src/app-feat']
    expect(resumableForRepoFallback(all, '/src/app', wtPaths).map((c) => c.id)).toEqual([])
    const all2 = [conv('/src/app/sub', 'c')]
    expect(resumableForRepoFallback(all2, '/src/app', wtPaths).map((c) => c.id)).toEqual(['c'])
  })

  it('excludes conversations without a resume ref', () => {
    const noResume: ConversationSummaryWire = {
      id: 'n',
      agentKind: 'claude-code',
      providerId: 'p',
      projectPath: '/src/app',
    }
    expect(resumableForWorktree([noResume], '/src/app')).toEqual([])
    expect(resumableForRepoFallback([noResume], '/src/app', [])).toEqual([])
  })

  it('does not match a sibling path as under the repo', () => {
    const sibling = conv('/src/application', 's')
    expect(resumableForRepoFallback([sibling], '/src/app', []).map((c) => c.id)).toEqual([])
  })
})

describe('mergeResumable', () => {
  it('dedupes conversations that appear in both exact and fallback lists', () => {
    const shared = conv('/src/app', 'facaab0d-326c-4915-9018-c1fd8f4a4e5b')
    expect(mergeResumable([shared], [shared])).toEqual([shared])
  })
})

describe('panelLabel', () => {
  it('maps agent kinds to display names', () => {
    expect(panelLabel('claude-code')).toBe('Claude')
    expect(panelLabel('codex')).toBe('Codex')
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

  it('idle verdicts: done is calm, the rest want attention', () => {
    expect(agentBadge(sessionWithState(stateAt('idle', { idle: { kind: 'done' } })))).toEqual({
      label: 'idle',
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
