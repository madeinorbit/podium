import { autorun } from 'mobx'
import { lazyKeptCount } from '@podium/mobx-helpers'
import { expect, it } from 'vitest'
import { MobxPool } from './pool'
import { missionView } from './mission-view'

const stamp = '2026-10-07T12:00:00Z'
it('closing many missions leaves no private registry or retained computed in their companions', async () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  const view = missionView(pool)
  try {
    const opened = []
    for (let i = 0; i < 60; i++) {
      const id = `mission-${i}`
      pool.apply({ type: 'update', rows: [{ kind: 'issue', id, value: {
        id, seq: i + 1, title: id, stage: 'in_progress', audience: 'human', parentId: null,
        deps: [], repoPath: '/synthetic', createdAt: stamp, updatedAt: stamp,
      } }] })
      const entity = pool.issueObject(id), deck = view.deck(id), card = deck.model(id), node = view.node(id)
      expect(deck.model(id)).toBe(card)
      expect(card.entity).toBe(entity)
      expect(view.facts(id)).toBe(entity)
      const stop = autorun(() => { void card.tasks; void card.hasPayload; void node.earliestChild })
      expect(lazyKeptCount(card)).toBeGreaterThan(0)
      stop()
      pool.apply({ type: 'update', rows: [{ kind: 'issue', id, value: undefined }] })
      opened.push({ card, deck, node, entity })
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(opened.reduce((sum, item) => sum + [item.card, item.deck, item.node, item.entity]
      .reduce((count, model) => count + lazyKeptCount(model), 0), 0)).toBe(0)
    // Only the pool owns entity identities. Neither screen owner has a strong
    // id/path registry: weak companion factories cannot retain released keys.
    for (const owner of [view, ...opened.map(item => item.deck)]) {
      expect(Object.values(owner).filter(value => value instanceof Map || value instanceof Set)).toHaveLength(0)
    }
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'mission-0', value: {
      id: 'mission-0', seq: 1, title: 'Reopened', stage: 'in_progress', audience: 'human',
      parentId: null, deps: [], repoPath: '/synthetic', createdAt: stamp, updatedAt: stamp,
    } }] })
    expect(view.deck('mission-0').model('mission-0')).not.toBe(opened[0]!.card)
  } finally { view.dispose(); pool.dispose() }
})
