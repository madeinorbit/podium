import { describe, expect, it } from 'vitest'
import { snapshotFromStore } from '../../../../harness/src/oracle/index'
import { engineLocals, openFenceFeeds } from '../../../../harness/src/fence-scenarios'
import { startScenarioEngine } from '../../../../shared/src/scenarios'

describe('draft title source', () => {
  it('dumps i3059/i1405 across feed, store and oracle', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    try {
      const { appendFileSync } = await import('node:fs')
      const store = ctx.engine.getSnapshot()
      const snap = snapshotFromStore(store, engineLocals(ctx))
      for (const id of ['i3059', 'i1405']) {
        const feedRow = feeds.rows.source.snapshot('issue').find((r) => r.id === id)?.value as
          | Record<string, unknown>
          | undefined
        const storeRow = (store.issues as unknown as Record<string, unknown>[]).find(
          (r) => (r as { id?: string }).id === id,
        ) as Record<string, unknown> | undefined
        appendFileSync(
          '/tmp/draft-title.txt',
          `${id} feed=${JSON.stringify(feedRow === undefined ? null : { draft: feedRow['draft'], title: feedRow['title'] })} ` +
            `store=${JSON.stringify(storeRow === undefined ? null : { draft: storeRow['draft'], title: storeRow['title'] })} ` +
            `oracle=${JSON.stringify(snap.rowsById[id]?.title)}\n`,
        )
      }
    } finally {
      feeds.dispose()
      ctx.engine.destroy()
    }
    expect(true).toBe(true)
  })
})
