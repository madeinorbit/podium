// @vitest-environment happy-dom
/**
 * POD-4451 — MobX arm clock tests on the G2 fixture corpus (the corpus the
 * browser pages measure, seed 4443): a boundary-free +60s tick and a
 * boundary-crossing +30d jump, each through the G4 count harness with oracle
 * parity and exact commit-set accounting.
 *
 * Why the fixture and not the scenario seed: the scenario seed's defer rows
 * sit 3 days past their band edge at boot (all settled in band 2) and its
 * dep edges are inert (`issueDep` vs the `issueDeps` address the row source
 * listens on — a G3 seed/harness mismatch, reported separately), so a tick
 * there moves nothing and proves little. The fixture mints defer bands
 * ±45 d around its clock with all three bands live, plus history-faithful
 * finished sessions — the corpus where clock subscriptions actually bite.
 *
 * M2 finding F-clock: on the fixture a +60s tick re-runs 3,589 derivation
 * bodies (3,499 flat + 86 summary + 4 aggregate — counted 2026-09-21) and
 * commits 0 rows. Mechanism: every flat/summary whose row holds a finished
 * member subscribes to the coarse clock through its retention check and
 * stays subscribed forever; the +60s tick re-runs them all and every value
 * settles by equality. The jump test below is the other half: when bands DO
 * move, exactly the band-movers commit — the subscription completeness has
 * value (no stale clock rows, by construction, not by sensitivity list).
 *
 * Counts only — no walls under box load (methodology §5.7).
 */

import { describe, expect, it } from 'vitest'
import { createRowSource } from '../../shared/src/row-source'
import { buildCorpus } from '../../harness/src/fixture/index'
import { startEngineOnCorpus } from '../../shared/src/scenarios'
import type { SliceLocals, SliceSnapshot } from '../../shared/src/slice-types'
import { mountArmForCounts, runCountScenario } from '../../harness/src/count-harness'
import { snapshotFromStore } from '../../harness/src/oracle/index'
import { mobxArm } from './arm'
import type { MobXStore } from './store'
import { fixedLocals } from '../../shared/src/locals-source'

function changedRows(before: SliceSnapshot, after: SliceSnapshot): string[] {
  const out = new Set<string>()
  for (const id of new Set([...Object.keys(before.rowsById), ...Object.keys(after.rowsById)])) {
    if (JSON.stringify(before.rowsById[id] ?? null) !== JSON.stringify(after.rowsById[id] ?? null)) {
      out.add(id)
    }
  }
  return [...out].sort()
}

async function bootFixture() {
  const corpus = buildCorpus(1, 4443)
  const boot = await startEngineOnCorpus(corpus)
  const source = createRowSource(boot.engine, boot.replica, { mode: 'overlaid' })
  const locals: SliceLocals = {
    selectedIssueId: null,
    coarseNow: boot.engine.getSnapshot().coarseNow,
  }
  const mounted = mountArmForCounts(mobxArm, source.source, fixedLocals(locals))
  const store = (mounted.handle as unknown as { store: MobXStore }).store
  return { boot, source, locals, mounted, store }
}

describe('mobx arm clock on the fixture corpus', () => {
  // POD-4551 expected failure (coordinator ruling, option 1): the resume-twin tie root (i286 at 1x) collapses in the runtime (runtime.ts:465 and :1172 via dedupeSessions) and this retired round-two arm never collapses, so it shows the stale ask. Delete with the round-two code (Ma1/Ha1); never copy onto a round-three arm.
  it.fails('+60s tick: nothing commits, parity green, settled re-runs counted', async () => {
    const { boot, source, locals, mounted, store } = await bootFixture()
    try {
      const atMount = mounted.handle.snapshot()
      expect(Object.keys(atMount.rowsById).length).toBe(211)
      expect(atMount).toEqual(snapshotFromStore(boot.engine.getSnapshot(), locals))
      const tickTo = store.locals.coarseNow + 60_000
      const tickLocals: SliceLocals = { ...locals, coarseNow: tickTo }
      const result = await runCountScenario(mounted, {
        scenario: 'clockTick',
        methodology: '#8',
        apply: async () => {
          store.setCoarseNow(tickTo)
          source.flush()
        },
        expected: () => snapshotFromStore(boot.engine.getSnapshot(), tickLocals),
      })
      console.info(
        `[mobx-clock] tick visible=${result.visibleRows} committed=${result.rowsCommitted} ` +
          `stats=${JSON.stringify(result.stats)} parity=${result.parity}`,
      )
      expect(result.parity, result.parityDiff ?? '').toBe(true)
      expect(result.rowsCommitted).toBe(0)
      expect(result.stats.rowsDerived).toBe(0)
      expect(result.stats.notifications).toBe(0)
      // Pins finding F-clock: the settled-subscriber set on this corpus.
      // Update deliberately if clock subscriptions change (a smaller number
      // wants the quantization note in POD-4451-m2 §4; a larger one wants an
      // explanation of what newly subscribes).
      expect(result.stats.rollupsDerived).toBe(3589)
    } finally {
      mounted.unmount()
      source.dispose()
      boot.engine.destroy()
    }
  }, 300_000)

  // POD-4551 expected failure (coordinator ruling, option 1): the resume-twin tie root (i286 at 1x) collapses in the runtime (runtime.ts:465 and :1172 via dedupeSessions) and this retired round-two arm never collapses, so it shows the stale ask. Delete with the round-two code (Ma1/Ha1); never copy onto a round-three arm.
  it.fails('+60d jump: exactly the band-movers commit, parity green', async () => {
    const { boot, source, locals, mounted, store } = await bootFixture()
    try {
      const before = snapshotFromStore(boot.engine.getSnapshot(), locals)
      // +60d is the smallest probed forward jump that moves oracle rows on
      // this corpus at wall-clock boot (14 rows: defer-band flippers plus
      // order fallout — probed 2026-09-21; smaller forward jumps move
      // nothing because the fixture's bands were minted around FIXED_NOW).
      const jumpTo = store.locals.coarseNow + 60 * 24 * 60 * 60 * 1000
      const jumpLocals: SliceLocals = { ...locals, coarseNow: jumpTo }
      const result = await runCountScenario(mounted, {
        scenario: 'clockJump60d',
        methodology: '#8 suppl.',
        apply: async () => {
          store.setCoarseNow(jumpTo)
          source.flush()
        },
        expected: () => snapshotFromStore(boot.engine.getSnapshot(), jumpLocals),
      })
      const after = snapshotFromStore(boot.engine.getSnapshot(), jumpLocals)
      const changed = changedRows(before, after)
      const committed = Object.keys(result.commitsByRow).sort()
      const over = committed.filter((id) => !changed.includes(id))
      // Mounts/unmounts are excluded from commits by RowShell design, so the
      // exact commit set is: changed rows still visible on both sides.
      const stillVisible = changed.filter(
        (id) => before.rowsById[id] !== undefined && after.rowsById[id] !== undefined,
      )
      const under = stillVisible.filter((id) => !committed.includes(id))
      console.info(
        `[mobx-clock] jump visible=${result.visibleRows} committed=${result.rowsCommitted} ` +
          `oracleChanged=${changed.length} stillVisibleChanged=${stillVisible.length} ` +
          `over=[${over.slice(0, 5).join(',')}] under=[${under.slice(0, 5).join(',')}] ` +
          `stats=${JSON.stringify(result.stats)} parity=${result.parity}`,
      )
      expect(result.parity, result.parityDiff ?? '').toBe(true)
      expect(changed.length, 'jump must move bands (else the test is vacuous)').toBeGreaterThan(0)
      expect(over, 'every committed row must be oracle-changed').toEqual([])
      expect(under, 'every still-visible changed row must commit (no stale rows)').toEqual([])
    } finally {
      mounted.unmount()
      source.dispose()
      boot.engine.destroy()
    }
  }, 300_000)
})
