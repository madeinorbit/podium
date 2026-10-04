/**
 * POD-4446 — hand-rolled arm against the G2 fixture corpus at 1x, booted
 * through a real engine: full-snapshot parity with the legacy oracle plus
 * the rebuild oracle. This is the fixture shape the browser pages measure
 * (agent-audience nesting drops, merge-blind decisions, pinned-settled
 * closed flags — all covered here).
 */

import { expect, it } from 'vitest'
import { buildCorpus } from '../../harness/src/fixture/index'
import { startEngineOnCorpus } from '../../shared/src/scenarios'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import { snapshotFromStore } from '../../harness/src/oracle/index'
import { handArm } from './arm'
import { rebuildFromScratch } from './rebuild'
import type { HandStore } from './store'
import { fixedLocals } from '@podium/client-graph/shared/locals-source'

// POD-4551 expected failure (coordinator ruling, option 1): the resume-twin tie root (i286 at 1x) collapses in the runtime (runtime.ts:465 and :1172 via dedupeSessions) and this retired round-two arm never collapses, so it shows the stale ask. Delete with the round-two code (Ma1/Ha1); never copy onto a round-three arm.
it.fails('fixture corpus at 1x: parity with the legacy oracle, rebuild oracle green', async () => {
  const corpus = buildCorpus(1, 4443)
  const boot = await startEngineOnCorpus(corpus)
  try {
    const source = createRowSource(boot.engine, boot.replica, { mode: 'overlaid' })
    const locals = {
      selectedIssueId: null as string | null,
      coarseNow: boot.engine.access.coarseNow,
    }
    const handle = handArm.create(source.source, fixedLocals(locals).source)
    const store = (handle as unknown as { store: HandStore }).store
    const mine = handle.snapshot()
    const expected = snapshotFromStore(boot.engine.access, locals)
    expect(Object.keys(mine.rowsById).length).toBeGreaterThan(0)
    expect(mine).toEqual(expected)
    const rebuilt = rebuildFromScratch({
      issues: store.issues,
      sessions: store.sessions,
      worktrees: store.worktrees,
      selection: { selectedIssueId: null, selectedIssueWasFolded: false },
      now: store.locals.coarseNow,
    })
    expect(handle.snapshot()).toEqual(rebuilt.snapshot)
    handle.dispose()
    source.dispose()
  } finally {
    boot.engine.destroy()
  }
}, 120_000)
