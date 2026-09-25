import { describe, expect, it } from 'vitest'
import { oracleSnapshot } from '../../../../harness/src/oracle/index'
import type { CheckableArm } from '../../../../shared/src/arm'
import { gen } from '../../../../shared/src/gen/changes'
import { checkArm } from '../../../../shared/src/gen/check'
import type { ScenarioEngine } from '../../../../shared/src/scenarios'
import type { SliceSnapshot } from '../../../../shared/src/slice-types'
import { installMobxWarnTrap } from '../mobx-trap'
import { acceptUnscannedGap } from '../worklist/known-gaps'
import { mobxPoolArm, type MobxPoolHandle } from '../arm'

installMobxWarnTrap()

function gapped(arm: CheckableArm, tally: { applied: number }): CheckableArm {
  return (ctx: ScenarioEngine) => ({
    create(source, locals, reads) {
      const handle = (typeof arm === 'function' ? arm(ctx) : arm).create(source, locals, reads) as MobxPoolHandle
      const patch = (snapshot: SliceSnapshot): SliceSnapshot => {
        const oracle = oracleSnapshot(ctx.engine.getSnapshot())
        const { rows } = acceptUnscannedGap(ctx.corpus, handle.pool, oracle, snapshot)
        if (rows.length === 0) return snapshot
        tally.applied += rows.length
        const rowsById = { ...snapshot.rowsById }
        for (const id of rows) rowsById[id] = oracle.rowsById[id]!
        return { ...snapshot, rowsById }
      }
      return {
        ...handle,
        snapshot: () => patch(handle.snapshot()),
        rebuildFromScratch: () => patch(handle.rebuildFromScratch()),
      }
    },
  })
}

const NO_WRITE_VOCAB = {
  edit: 0,
  accept: 0,
  reject: 0,
  echo: 0,
  remoteOnPending: 0,
  staleRepeat: 0,
  supersede: 0,
}

describe('plain pool vs kernel oracle on seed 4', () => {
  it('runs the prefix with kernel edits', async () => {
    const sequence = gen(4, 90, {}, { editFields: ['title', 'readAt'] })
    const gap = { applied: 0 }
    const result = await checkArm(gapped(mobxPoolArm, gap), sequence, {
      mode: 'overlaid',
      oracleEvery: 1,
      shrink: false,
    })
    if (!result.ok) {
      const { appendFileSync } = await import('node:fs')
      appendFileSync('/tmp/plain-vs-kernel.txt', `against=${result.against} step=${result.step} diff:\n${result.diff}\n`)
    }
    expect(result.ok).toBe(true)
  }, 1_200_000)

  it('runs the prefix with NO write vocabulary at all', async () => {
    const sequence = gen(4, 90, NO_WRITE_VOCAB, { editFields: ['title', 'readAt'] })
    const gap = { applied: 0 }
    const result = await checkArm(gapped(mobxPoolArm, gap), sequence, {
      mode: 'overlaid',
      oracleEvery: 1,
      shrink: false,
    })
    if (!result.ok) {
      const { appendFileSync } = await import('node:fs')
      appendFileSync('/tmp/plain-vs-kernel.txt', `nowrite against=${result.against} step=${result.step} diff:\n${result.diff}\n`)
    }
    expect(result.ok).toBe(true)
  }, 1_200_000)
})
