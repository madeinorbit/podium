/**
 * POD-4447 — MobX arm against the G2 fixture corpus at 1x, booted through a
 * real engine: full-snapshot parity with the legacy oracle. This is the
 * fixture shape the browser pages measure (agent-audience nesting drops,
 * merge-blind decisions, pinned-settled closed flags — all covered here).
 */

import { expect, it } from 'vitest'
import { buildCorpus } from '../../harness/src/fixture/index'
import { startEngineOnCorpus } from '../../shared/src/scenarios'
import { createRowSource } from '../../shared/src/row-source'
import { snapshotFromStore } from '../../harness/src/oracle/index'
import { mobxArm } from './arm'

// POD-4551 coordinator ruling: expected failure. The corpus's resume-twin tie root (i286 at 1x) collapses in the runtime and the oracle (runtime.ts:465), and this retired round-two arm never implemented dedupeSessionsByResume, so it shows the stale ask.
it.fails('fixture corpus at 1x: parity with the legacy oracle', async () => {
  const corpus = buildCorpus(1, 4443)
  const boot = await startEngineOnCorpus(corpus)
  try {
    const source = createRowSource(boot.engine, boot.replica, { mode: 'overlaid' })
    const locals = {
      selectedIssueId: null as string | null,
      coarseNow: boot.engine.getSnapshot().coarseNow,
    }
    const handle = mobxArm.create(source.source, locals)
    const mine = handle.snapshot()
    const expected = snapshotFromStore(boot.engine.getSnapshot(), locals)
    expect(Object.keys(mine.rowsById).length).toBeGreaterThan(0)
    expect(mine).toEqual(expected)
    handle.dispose()
    source.dispose()
  } finally {
    boot.engine.destroy()
  }
}, 120_000)
