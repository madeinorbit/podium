import { Buffer } from 'node:buffer'
import type { GitRepositoryWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  conciergeLabel,
  conciergeRepoPath,
  conciergeThreadId,
  resolveConciergeRepo,
} from './concierge'

// ---------------------------------------------------------------------------
// The concierge + button's derive/label logic (issue #65). The thread id MUST
// byte-match the server's `concierge_<base64url(repoPath)>` (superagent.ts) —
// the web binds the panel to the thread before it exists server-side, so an
// encoding drift would open a phantom thread next to the real one.
// ---------------------------------------------------------------------------

const repo = (path: string, worktrees: { path: string; branch?: string }[] = []) =>
  ({ path, kind: 'repository', worktrees }) as GitRepositoryWire

const session = (sessionId: string, cwd: string) => ({ sessionId, cwd }) as SessionMeta

describe('conciergeThreadId', () => {
  it('matches the server encoding (Buffer base64url) including non-ASCII + URL-unsafe bytes', () => {
    for (const p of ['/home/me/src/podium', '/tmp/répo — ünïcode', '/a/b?c>d', '/x'.repeat(40)]) {
      expect(conciergeThreadId(p)).toBe(`concierge_${Buffer.from(p, 'utf8').toString('base64url')}`)
    }
  })

  it('round-trips through conciergeRepoPath', () => {
    const p = '/home/me/src/podium'
    expect(conciergeRepoPath(conciergeThreadId(p))).toBe(p)
  })

  it('conciergeRepoPath rejects non-concierge and malformed ids', () => {
    expect(conciergeRepoPath('global')).toBeUndefined()
    expect(conciergeRepoPath('btw_abc')).toBeUndefined()
    expect(conciergeRepoPath('concierge_!!!not-base64!!!')).toBeUndefined()
  })
})

describe('conciergeLabel', () => {
  it('renders "Concierge — <repo basename>"', () => {
    expect(conciergeLabel('/home/me/src/podium')).toBe('Concierge — podium')
    expect(conciergeLabel('/podium')).toBe('Concierge — podium')
  })
})

describe('resolveConciergeRepo', () => {
  const repos = [
    repo('/src/alpha', [{ path: '/src/alpha/.worktrees/feat', branch: 'feat' }]),
    repo('/src/beta'),
  ]

  it('prefers the selected worktree, mapping a linked worktree to its repo root', () => {
    const r = resolveConciergeRepo({
      repos,
      selectedWorktree: '/src/alpha/.worktrees/feat',
      sessions: [],
      paneA: null,
    })
    expect(r).toEqual({ kind: 'repo', repoPath: '/src/alpha' })
  })

  it("falls back to the focused session's cwd when no worktree is selected", () => {
    const r = resolveConciergeRepo({
      repos,
      selectedWorktree: null,
      sessions: [session('s1', '/src/beta')],
      paneA: 's1',
    })
    expect(r).toEqual({ kind: 'repo', repoPath: '/src/beta' })
  })

  it('uses the only repo when exactly one is registered', () => {
    const r = resolveConciergeRepo({
      repos: [repo('/src/solo')],
      selectedWorktree: null,
      sessions: [],
      paneA: null,
    })
    expect(r).toEqual({ kind: 'repo', repoPath: '/src/solo' })
  })

  it('returns the candidate list when several repos and no context', () => {
    const r = resolveConciergeRepo({ repos, selectedWorktree: null, sessions: [], paneA: null })
    expect(r.kind).toBe('pick')
    if (r.kind === 'pick') {
      expect(r.candidates.map((c) => c.path).sort()).toEqual(['/src/alpha', '/src/beta'])
    }
  })

  it('returns none with no repos', () => {
    expect(
      resolveConciergeRepo({ repos: [], selectedWorktree: null, sessions: [], paneA: null }),
    ).toEqual({ kind: 'none' })
  })

  it('ignores a selected worktree that maps to no known repo (falls through)', () => {
    const r = resolveConciergeRepo({
      repos: [repo('/src/solo')],
      selectedWorktree: '/gone/path',
      sessions: [],
      paneA: null,
    })
    expect(r).toEqual({ kind: 'repo', repoPath: '/src/solo' })
  })
})
