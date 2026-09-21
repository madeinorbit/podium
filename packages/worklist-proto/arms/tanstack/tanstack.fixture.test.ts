// @vitest-environment happy-dom
/**
 * POD-4448 — TanStack arm against the G2 fixture corpus at 1x, booted
 * through a real engine: full-snapshot parity with the legacy oracle.
 */

import { expect, it } from 'vitest'
import { buildCorpus } from '../../harness/src/fixture/index'
import { startEngineFromCorpus } from '../../harness/src/engine-bootstrap'
import { createRowSource } from '../../shared/src/row-source'
import { snapshotFromStore } from '../../harness/src/oracle/index'
import { tanstackArm } from './arm'

it('fixture corpus at 1x: parity with the legacy oracle', async () => {
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
      expect(Object.keys(mine.rowsById).length).toBeGreaterThan(0)
      expect(mine).toEqual(expected)
    } finally {
      handle.dispose()
    }
    source.dispose()
  } finally {
    boot.engine.destroy()
  }
}, 120_000)
