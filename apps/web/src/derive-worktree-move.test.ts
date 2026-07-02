import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { planWorktreeMoves } from './derive'

const ROOTS = ['/repo', '/repo/.worktrees/feat']
const at = (id: string, cwd: string): SessionMeta =>
  ({ sessionId: id, cwd, archived: false }) as unknown as SessionMeta

describe('planWorktreeMoves', () => {
  it('follows when a visible-pane session moves out of the selected worktree', () => {
    const plan = planWorktreeMoves({
      prevCwds: { s1: '/repo' },
      sessions: [at('s1', '/repo/.worktrees/feat')],
      worktreePaths: ROOTS,
      selectedWorktree: '/repo',
      visiblePanes: ['s1'],
    })
    expect(plan.follow).toBe('/repo/.worktrees/feat')
    expect(plan.moved).toEqual([])
  })

  it('reports a background move as a toast, not a follow', () => {
    const plan = planWorktreeMoves({
      prevCwds: { s1: '/repo' },
      sessions: [at('s1', '/repo/.worktrees/feat')],
      worktreePaths: ROOTS,
      selectedWorktree: '/repo',
      visiblePanes: [], // not in a pane
    })
    expect(plan.follow).toBeNull()
    expect(plan.moved).toEqual([
      { sessionId: 's1', from: '/repo', to: '/repo/.worktrees/feat' },
    ])
  })

  it('a subdirectory cd within the same worktree is neither a follow nor a move', () => {
    const plan = planWorktreeMoves({
      prevCwds: { s1: '/repo' },
      sessions: [at('s1', '/repo/packages/web')],
      worktreePaths: ROOTS,
      selectedWorktree: '/repo',
      visiblePanes: ['s1'],
    })
    expect(plan.follow).toBeNull()
    expect(plan.moved).toEqual([])
  })

  it('first sight of a session (no previous cwd) is not a move', () => {
    const plan = planWorktreeMoves({
      prevCwds: {},
      sessions: [at('s1', '/repo/.worktrees/feat')],
      worktreePaths: ROOTS,
      selectedWorktree: '/repo',
      visiblePanes: ['s1'],
    })
    expect(plan.follow).toBeNull()
    expect(plan.moved).toEqual([])
  })

  it('does not follow a pane session that was not in the selected worktree', () => {
    // Pane session belonged elsewhere already — its move shouldn't yank the view.
    const plan = planWorktreeMoves({
      prevCwds: { s1: '/repo/.worktrees/feat' },
      sessions: [at('s1', '/repo')],
      worktreePaths: ROOTS,
      selectedWorktree: '/other',
      visiblePanes: ['s1'],
    })
    expect(plan.follow).toBeNull()
    expect(plan.moved).toEqual([{ sessionId: 's1', from: '/repo/.worktrees/feat', to: '/repo' }])
  })

  it('a move to an unknown (unscanned) directory reports to=null and never follows', () => {
    const plan = planWorktreeMoves({
      prevCwds: { s1: '/repo' },
      sessions: [at('s1', '/tmp/elsewhere')],
      worktreePaths: ROOTS,
      selectedWorktree: '/repo',
      visiblePanes: ['s1'],
    })
    expect(plan.follow).toBeNull()
    expect(plan.moved).toEqual([{ sessionId: 's1', from: '/repo', to: null }])
  })
})
