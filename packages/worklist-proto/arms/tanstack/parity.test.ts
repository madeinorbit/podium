// Temporary parity diff printer. DELETE.
import { expect, it } from 'vitest'
import { buildCorpus } from '../../harness/src/fixture/index'
import { startEngineFromCorpus } from '../../harness/src/engine-bootstrap'
import { createRowSource } from '../../shared/src/row-source'
import { snapshotFromStore } from '../../harness/src/oracle/index'
import { tanstackArm } from './arm'
import type { TanStackStore } from './store'

it('print all parity diffs', async () => {
  const corpus = buildCorpus(1, 4443)
  const boot = await startEngineFromCorpus(corpus)
  try {
    const source = createRowSource(boot.engine, boot.replica)
    const locals = {
      selectedIssueId: null as string | null,
      coarseNow: boot.engine.getSnapshot().coarseNow,
    }
    const handle = tanstackArm.create(source.source, locals)
    try {
      const mine = handle.snapshot()
      const expected = snapshotFromStore(boot.engine.getSnapshot(), locals)
      const mineIds = Object.keys(mine.rowsById).sort()
      const expIds = Object.keys(expected.rowsById).sort()
      console.info(`[parity] mine=${mineIds.length} expected=${expIds.length}`)
      console.info(`[parity] missing=${expIds.filter((id) => !mineIds.includes(id)).slice(0, 10)}`)
      console.info(`[parity] extra=${mineIds.filter((id) => !expIds.includes(id)).slice(0, 10)}`)
      let shown = 0
      for (const id of expIds) {
        const a = mine.rowsById[id]
        const b = expected.rowsById[id]
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          console.info(`[parity] ${id}:\n  mine=${JSON.stringify(a)}\n  exp =${JSON.stringify(b)}`)
          shown += 1
          if (shown >= 8) break
        }
      }
      if (JSON.stringify(mine.order) !== JSON.stringify(expected.order)) {
        console.info('[parity] ORDER DIFFERS')
      }
      const store = (handle as unknown as { store: TanStackStore }).store
      console.info(`[parity] runs=${JSON.stringify(store.runs.changes)}`)
    } finally {
      handle.dispose()
    }
    source.dispose()
  } finally {
    boot.engine.destroy()
  }
}, 120_000)
