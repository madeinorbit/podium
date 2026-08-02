import { asSessionId, type GitRepositoryWire, type SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { PinState } from '../../types'
import { EMPTY_PINS, lastUsedMaps, sidebarSections } from './nav'
import { groupSessionsByParent, partitionWorkItems } from './session-groups'

// ---------------------------------------------------------------------------
// POD-330 — the worklist's navigation structure over a PARTIAL world.
//
// Per-user state (pins) is replicated and survives independently of the entities
// it points at, so under the scoped feed a pin routinely outlives its target's
// VISIBILITY: the worktree is on a machine this principal may no longer see. It
// still exists; the pin is still correct; the row must simply not render, and
// must not render as deleted or as a placeholder implying the user can act on
// it. The same applies to a spawn parent that leaves the replica.
// ---------------------------------------------------------------------------

function session(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: asSessionId(id),
    agentKind: 'claude-code',
    title: id,
    cwd: '/repo/a',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    busy: false,
    readAt: null,
    unread: false,
    ...over,
  } as unknown as SessionMeta
}

function repo(path: string, worktrees: string[] = []): GitRepositoryWire {
  return {
    path,
    name: path.split('/').pop() ?? path,
    branch: 'main',
    worktrees: worktrees.map((w) => ({ path: w, name: w.split('/').pop() ?? w, branch: 'wt' })),
  } as unknown as GitRepositoryWire
}

const NOW = Date.parse('2026-07-06T12:00:00.000Z')

describe('sidebarSections over a partial world', () => {
  const repos = [repo('/repo/a', ['/repo/a/wt-1'])]

  it('renders the visible tree', () => {
    const sections = sidebarSections(repos, [session('s1', { cwd: '/repo/a/wt-1' })], EMPTY_PINS, NOW)
    expect(sections.repos.map((r) => r.path)).toEqual(['/repo/a'])
    // reposToViews lists the repo's own checkout alongside its linked worktrees.
    expect(sections.repos[0]?.worktrees.map((w) => w.path)).toEqual(['/repo/a', '/repo/a/wt-1'])
    expect(
      sections.repos[0]?.worktrees.find((w) => w.path === '/repo/a/wt-1')?.sessions.map((s) => s.sessionId),
    ).toEqual(['s1'])
  })

  it('never shows a shell in the tree — shells belong to the tab strip', () => {
    const sections = sidebarSections(
      repos,
      [session('sh', { cwd: '/repo/a/wt-1', agentKind: 'shell' }), session('s1', { cwd: '/repo/a/wt-1' })],
      EMPTY_PINS,
      NOW,
    )
    const wt = sections.repos[0]?.worktrees.find((w) => w.path === '/repo/a/wt-1')
    expect(wt?.sessions.map((s) => s.sessionId)).toEqual(['s1'])
  })

  it('a pin naming a worktree this principal cannot SEE renders no row and no placeholder', () => {
    const pins: PinState = { panels: [], worktrees: ['/repo/invisible/wt'], repos: ['/repo/invisible'] }
    const sections = sidebarSections(repos, [], pins, NOW)
    expect(sections.pinnedWorktrees).toEqual([])
    expect(sections.pinnedRepos).toEqual([])
    // And it does not leak into the ordinary tree either, as a stub or otherwise.
    expect(sections.repos.map((r) => r.path)).toEqual(['/repo/a'])
  })

  it('lifts a pinned worktree out of its repo exactly once', () => {
    const pins: PinState = { panels: [], worktrees: ['/repo/a/wt-1'], repos: [] }
    const sections = sidebarSections(repos, [], pins, NOW)
    expect(sections.pinnedWorktrees.map((w) => w.path)).toEqual(['/repo/a/wt-1'])
    // Lifted exactly once: the pinned worktree is gone from the repo's own list,
    // which still carries the repo checkout itself.
    expect(sections.repos[0]?.worktrees.map((w) => w.path)).toEqual(['/repo/a'])
  })

  it('lastUsedMaps aggregates a cwd that matches no known worktree under itself', () => {
    const sections = sidebarSections(repos, [], EMPTY_PINS, NOW)
    const { byRepo, byWorktree } = lastUsedMaps(sections, [
      session('s1', { cwd: '/repo/a/wt-1', lastActiveAt: '2026-07-05T00:00:00.000Z' }),
      session('s2', { cwd: '/somewhere/else', lastActiveAt: '2026-07-04T00:00:00.000Z' }),
    ])
    expect(byRepo.get('/repo/a')).toBe(Date.parse('2026-07-05T00:00:00.000Z'))
    expect(byRepo.get('/somewhere/else')).toBe(Date.parse('2026-07-04T00:00:00.000Z'))
    expect(byWorktree.get('/repo/a/wt-1')).toBe(Date.parse('2026-07-05T00:00:00.000Z'))
  })
})

describe('session bucketing over a partial world', () => {
  it('a spawn child whose parent is no longer VISIBLE stays top-level, not orphaned', () => {
    const child = session('c', { spawnedBy: 'session:p' })
    const groups = groupSessionsByParent([child])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.session.sessionId).toBe('c')
    expect(groups[0]?.children).toEqual([])
    // The parent id is still on the child. That is a reference, not a promise
    // that a row will appear for it.
    expect(child.spawnedBy).toBe('session:p')
  })

  it('nests the child again the moment its parent is visible', () => {
    const groups = groupSessionsByParent([session('p'), session('c', { spawnedBy: 'session:p' })])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.children.map((s) => s.sessionId)).toEqual(['c'])
  })

  it('an evicted session simply leaves the buckets — no tombstone entry', () => {
    const pinned = new Set(['a'])
    const before = partitionWorkItems([session('a'), session('b')], pinned, NOW)
    const after = partitionWorkItems([session('b')], pinned, NOW)
    expect(before.pinnedPanels.map((s) => s.sessionId)).toEqual(['a'])
    expect(after.pinnedPanels).toEqual([])
    expect([...after.attention, ...after.working].map((s) => s.sessionId)).toEqual(['b'])
  })
})
