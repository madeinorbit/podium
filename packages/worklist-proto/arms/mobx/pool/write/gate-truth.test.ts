/**
 * POD-4574 (Mc2) — L4b with the arm owning its optimism: the writable MobX
 * pool on the `truth` feed, generated edits routed through the arm's
 * `write.edit` into the real kernel transport (the shared `ArmEditAdapter`),
 * compared after every step with its optimism-aware rebuild and with the
 * overlaid oracle (the legacy's optimistic paint).
 *
 * Like `gate.test.ts`, the oracle comparison carries POD-4671's one-row gap
 * (`acceptUnscannedGap`), which throws once the seat exists. Seeds × steps
 * follow `gate.test.ts` (`POD_POOL_GATE_SEEDS`, default 3;
 * `POD_POOL_GATE_STEPS`, default 200). The gate of record is 20 × 300.
 * Timeout scales the same way (5 s per seed-step).
 *
 * PLANTS (coordinator addendum). Two write-path plants, each failing every
 * seed:
 * - (a) a remote never reaches the log: rejecting rewinds to the stale prior
 *   instead of the server value the log should have kept. Caught by the
 *   rebuild (live stale vs rebuilt server) and the oracle.
 * - (c) a remote drops the pending entry: the object takes the server value
 *   on a pending field instead of keeping the local one. Caught by the
 *   oracle (the kernel's ledger still shows the pending value).
 * (b) an echo with equal values committing again and (d) a duplicate receipt
 * applied twice are commit-count plants: equal values are invisible to a
 * snapshot comparison by construction, so their catching checks are the
 * `settle.test.tsx` count cells (proven red by mutation; see `write/NOTES.md`).
 */

import { describe, expect, it } from 'vitest'
import { oracleSnapshot } from '../../../../harness/src/oracle/index'
import { writeResult } from '../../../../harness/src/results'
import type { CheckableArm } from '../../../../shared/src/arm'
import { ArmEditAdapter } from '../../../../shared/src/gen/arm-edits'
import { gen } from '../../../../shared/src/gen/changes'
import { checkArm, type CheckedArm } from '../../../../shared/src/gen/check'
import type { ScenarioEngine } from '../../../../shared/src/scenarios'
import type { SliceSnapshot } from '../../../../shared/src/slice-types'
import { installMobxWarnTrap } from '../mobx-trap'
import { acceptUnscannedGap } from '../worklist/known-gaps'
import { writableMobxPoolArm, type WritableMobxPoolHandle } from './arm'

installMobxWarnTrap()

const SEEDS = Array.from(
  { length: Number(process.env['POD_POOL_GATE_SEEDS'] ?? 3) },
  (_, i) => i + 1,
)
const STEPS = Number(process.env['POD_POOL_GATE_STEPS'] ?? 200)
const GATE_TIMEOUT_MS = Math.max(1_500_000, SEEDS.length * STEPS * 5_000)

/**
 * The writable arm over the adapter's transport, stashing the live write API
 * on every create so generated edits go through the current arm (a `refresh`
 * disposes the arm and creates a new one over the new engine).
 */
function armWithAdapter(
  adapter: ArmEditAdapter,
  plant?: (handle: WritableMobxPoolHandle) => void,
): CheckedArm {
  return (ctx: ScenarioEngine) => {
    const inner = writableMobxPoolArm(adapter.transport(ctx))
    return {
      create: (source, locals, reads) => {
        const handle = inner.create(source, locals, reads) as WritableMobxPoolHandle
        adapter.currentEdit = (id, patch) => handle.write.edit('issue', id, patch)
        plant?.(handle)
        return handle
      },
    } as CheckableArm
  }
}

/** Plant (a): server values never reach the log, so a rejection rewinds stale. */
function staleRemote(handle: WritableMobxPoolHandle): void {
  handle.write.handleRemote = () => {}
}

/** Plant (c): any remote drops the pending entry, so the object takes the server value. */
function dropPendingOnRemote(handle: WritableMobxPoolHandle): void {
  const write = handle.write
  const remote = write.handleRemote.bind(write)
  write.handleRemote = (kind, id, values) => {
    remote(kind, id, values)
    for (const edit of write.log.pendingFor(kind, id)) {
      write.reject({ txId: edit.txId, error: { message: '[plant] remote drops pending', parked: false } })
    }
  }
}

/**
 * POD-4671's one-row gap patched in the snapshot and the rebuild (the same
 * wrapper as `gate.test.ts`'s `gapped`): the oracle's row taken for each row
 * `acceptUnscannedGap` names, counted in `tally.applied`.
 */
function gapped(
  arm: CheckedArm,
  tally: { applied: number },
): CheckedArm {
  return (ctx: ScenarioEngine) => ({
    create(source, locals, reads) {
      const handle = arm(ctx).create(source, locals, reads) as WritableMobxPoolHandle
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

describe('L4b with the arm owning its optimism (truth feed, arm edits)', () => {
  it(
    'passes every seed against the rebuild and the overlaid oracle',
    async () => {
      const cells = []
      for (const seed of SEEDS) {
        const adapter = new ArmEditAdapter()
        const arm = armWithAdapter(adapter)
        const sequence = gen(seed, STEPS)
        const gap = { applied: 0 }
        const result = await checkArm(gapped(arm, gap), sequence, {
          mode: 'truth',
          editViaArm: adapter.editHook,
          onStep: (step) => adapter.pairFromStep(step.detail ?? {}),
        })
        if (!result.ok) {
          throw new Error(
            `seed ${seed}: step ${result.step} diverged from the ${result.against}:\n${result.diff}`,
          )
        }
        cells.push({ seed, steps: STEPS, counts: result.counts, gapApplied: gap.applied })
      }
      writeResult(`mobx-write-truth-gate-1x-${SEEDS.length}x${STEPS}`, { seeds: SEEDS, steps: STEPS, cells })
    },
    GATE_TIMEOUT_MS,
  )

  it(
    'plant (a): a remote that never reaches the log fails every seed on rebuild or oracle',
    async () => {
      let failures = 0
      for (const seed of SEEDS) {
        const adapter = new ArmEditAdapter()
        const planted = armWithAdapter(adapter, staleRemote)
        const sequence = gen(seed, STEPS)
        const result = await checkArm(planted, sequence, {
          mode: 'truth',
          oracleEvery: 0,
          shrink: false,
          editViaArm: adapter.editHook,
          onStep: (step) => adapter.pairFromStep(step.detail ?? {}),
        })
        if (!result.ok) failures += 1
      }
      expect(failures).toBe(SEEDS.length)
    },
    GATE_TIMEOUT_MS,
  )

  it(
    'plant (c): a remote that drops pending fails every seed on the oracle',
    async () => {
      let failures = 0
      for (const seed of SEEDS) {
        const adapter = new ArmEditAdapter()
        const planted = armWithAdapter(adapter, dropPendingOnRemote)
        const sequence = gen(seed, STEPS)
        const result = await checkArm(planted, sequence, {
          mode: 'truth',
          shrink: false,
          editViaArm: adapter.editHook,
          onStep: (step) => adapter.pairFromStep(step.detail ?? {}),
        })
        if (!result.ok) failures += 1
      }
      expect(failures).toBe(SEEDS.length)
    },
    GATE_TIMEOUT_MS,
  )
})
