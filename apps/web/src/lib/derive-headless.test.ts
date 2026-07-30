import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  dedupeSessionsByResume,
  isHeadlessSession,
  partitionWorkItems,
  sessionsForWorktree,
  sidebarSections,
  withoutHeadless,
} from './derive'
import { withoutShells } from './home'

function meta(over: Partial<SessionMeta>): SessionMeta {
  return {
    sessionId: 's1',
    agentKind: 'claude-code',
    title: 't',
    cwd: '/w',
    status: 'live',
    controllerId: 'c0',
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-06-03T00:00:00.000Z',
    lastActiveAt: '2026-06-03T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    ...over,
  }
}

const normal = meta({ sessionId: 'n1' })
const headless = meta({ sessionId: 'h1', headless: true })

describe('headless session exclusion (concierge unification)', () => {
  it('isHeadlessSession keys strictly off meta.headless === true', () => {
    expect(isHeadlessSession(headless)).toBe(true)
    expect(isHeadlessSession(normal)).toBe(false)
    expect(isHeadlessSession(meta({ headless: false }))).toBe(false)
  })

  it('withoutHeadless drops headless rows and keeps the rest', () => {
    expect(withoutHeadless([normal, headless]).map((s) => s.sessionId)).toEqual(['n1'])
    // No headless rows → same array back (allocation-light identity).
    const only = [normal]
    expect(withoutHeadless(only)).toBe(only)
  })

  it('sessionsForWorktree never lists a headless session (exact and containment)', () => {
    expect(sessionsForWorktree([normal, headless], '/w')).toEqual([normal])
    expect(sessionsForWorktree([normal, headless], '/w', ['/w'])).toEqual([normal])
  })

  it('partitionWorkItems skips headless sessions in every bucket', () => {
    const workingHeadless = meta({
      sessionId: 'h2',
      headless: true,
      agentState: { phase: 'working' } as SessionMeta['agentState'],
    })
    const part = partitionWorkItems([normal, headless, workingHeadless], new Set(['h1']))
    const ids = [...part.attention, ...part.working, ...part.pinnedPanels].map((s) => s.sessionId)
    expect(ids).not.toContain('h1')
    expect(ids).not.toContain('h2')
    expect(ids).toContain('n1')
  })

  it('sidebarSections keeps headless sessions out of worktree groups', () => {
    const repos = [
      {
        path: '/w',
        originUrl: '',
        worktrees: [],
      },
    ] as never
    const sections = sidebarSections(repos, [normal, headless], {
      panels: [],
      worktrees: [],
      repos: [],
    })
    const grouped = sections.repos.flatMap((r) => r.worktrees.flatMap((w) => w.sessions))
    expect(grouped.map((s) => s.sessionId)).toEqual(['n1'])
  })

  it('home board (withoutShells) drops headless sessions too', () => {
    expect(withoutShells([normal, headless]).map((s) => s.sessionId)).toEqual(['n1'])
  })

  it('dedupeSessionsByResume never collapses a headless session with its terminal twin', () => {
    const resume = { kind: 'claude-session', value: 'abc' } as SessionMeta['resume']
    const h = meta({ sessionId: 'h1', headless: true, resume })
    const pty = meta({ sessionId: 'p1', resume })
    expect(dedupeSessionsByResume([h, pty]).map((s) => s.sessionId)).toEqual(['h1', 'p1'])
  })
})

// Folded from home.test.ts (#619): withoutShells is the command-center's shell
// exclusion, a sibling of the headless exclusion above.
describe('withoutShells', () => {
  it('drops shell sessions from a command-center list', () => {
    const agent = meta({ sessionId: 'ag', agentKind: 'claude-code' })
    const shell = meta({ sessionId: 'sh', agentKind: 'shell' })
    expect(withoutShells([agent, shell]).map((s) => s.sessionId)).toEqual(['ag'])
  })

  it('keeps every non-shell agent kind', () => {
    const claude = meta({ sessionId: 'c', agentKind: 'claude-code' })
    const codex = meta({ sessionId: 'x', agentKind: 'codex' })
    expect(withoutShells([claude, codex]).map((s) => s.sessionId)).toEqual(['c', 'x'])
  })
})
