/**
 * A committed issue write that changes where the issue's worktree is emits
 * `issue.worktreeMoved` on the bus, after the outermost commit (POD-6158, for
 * POD-6160's message routing, which re-reads the sessions under both paths).
 *
 * Set, moved and cleared through the issue write path; deleted and restored
 * through the lifecycle plans, where a deleted issue counts as having no
 * worktree. A write that does not touch the worktree emits nothing, and nor
 * does one whose enclosing span rolls back.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { EventMap } from '../../bus'
import { SessionRegistry } from '../../../relay'
import { openTestStore } from '../../../test-support/open-test-store'

describe('issue.worktreeMoved (POD-6158)', () => {
  const registries: SessionRegistry[] = []
  afterEach(async () => {
    for (const registry of registries.splice(0)) await registry.dispose()
  })

  async function build() {
    const store = await openTestStore(':memory:')
    await store.repos.addRepo('/repo', store.hostMachineId)
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    const moves: EventMap['issue.worktreeMoved'][] = []
    registry.bus.on('issue.worktreeMoved', (event) => {
      moves.push(event)
    })
    const issue = await registry.issues.crud.create({ repoPath: '/repo', title: 'Moves', startNow: false })
    const issues = registry.issues.reports.store
    const write = async (patch: { worktreePath?: string | null; title?: string }) => {
      const draft = (await issues.draft(issue.id))!
      Object.assign(draft, patch)
      await issues.persist(draft)
    }
    return { store, registry, issue, moves, write }
  }

  it('reports a worktree set, moved and cleared, and nothing for other writes', async () => {
    const { issue, moves, write } = await build()
    await write({ worktreePath: '/repo/.worktrees/a' })
    await write({ title: 'Renamed' })
    await write({ worktreePath: '/repo/.worktrees/b' })
    await write({ worktreePath: null })
    expect(moves).toEqual([
      { issueId: issue.id, previousWorktreePath: null, worktreePath: '/repo/.worktrees/a' },
      { issueId: issue.id, previousWorktreePath: '/repo/.worktrees/a', worktreePath: '/repo/.worktrees/b' },
      { issueId: issue.id, previousWorktreePath: '/repo/.worktrees/b', worktreePath: null },
    ])
  })

  it('waits for the outermost commit, and says nothing when it rolls back', async () => {
    const { store, issue, moves, write } = await build()
    await store.transact(async () => {
      await write({ worktreePath: '/repo/.worktrees/a' })
      expect(moves).toEqual([])
    })
    expect(moves).toHaveLength(1)
    await expect(store.transact(async () => {
      await write({ worktreePath: '/repo/.worktrees/b' })
      throw new Error('enclosing span failed')
    })).rejects.toThrow('enclosing span failed')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(moves).toEqual([
      { issueId: issue.id, previousWorktreePath: null, worktreePath: '/repo/.worktrees/a' },
    ])
  })

  it('treats a deleted issue as having no worktree', async () => {
    const { registry, issue, moves, write } = await build()
    await write({ worktreePath: '/repo/.worktrees/a' })
    moves.length = 0
    await registry.modules.issueSessionLifecycle.deleteIssue(issue.id)
    await registry.modules.issueSessionLifecycle.restoreIssue(issue.id)
    expect(moves).toEqual([
      { issueId: issue.id, previousWorktreePath: '/repo/.worktrees/a', worktreePath: null },
      { issueId: issue.id, previousWorktreePath: null, worktreePath: '/repo/.worktrees/a' },
    ])
  })
})
