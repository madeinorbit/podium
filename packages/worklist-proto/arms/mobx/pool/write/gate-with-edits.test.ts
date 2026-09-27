/**
 * POD-4573 (Mc1) — L4b with the write layer attached: the existing
 * correctness gate still passes with optimism wired in but idle, and its
 * removal-deaf plant still fails every seed.
 *
 * The layer holds no pending edit during these runs (no arm-side edit is
 * made), so the pool answers server truth exactly as `mobxPoolArm` does; the
 * overlay wrappers return the server objects unchanged. The feed stays
 * `overlaid` (the roster's mode for a pool that does not yet own optimism):
 * the generator's kernel-side edits arrive folded, as the oracle sees them.
 * Mc2 (c2) moves this run to `truth` with arm-side edits.
 *
 * Like `gate.test.ts`, the oracle comparison carries no gap (POD-4671 fixed).
 * Seeds × steps follow `gate.test.ts` (`POD_POOL_GATE_SEEDS`, default 3;
 * `POD_POOL_GATE_STEPS`, default 200). Timeout scales the same way (5 s per
 * seed-step).
 */

import { describe, expect, it } from 'vitest'
import { oracleSnapshot } from '../../../../harness/src/oracle/index'
import { writeResult } from '../../../../harness/src/results'
import type { CheckableArm, RowSource } from '../../../../shared/src/arm'
import { gen } from '../../../../shared/src/gen/changes'
import { checkArm, type CheckedArm } from '../../../../shared/src/gen/check'
import type { ScenarioEngine } from '../../../../shared/src/scenarios'
import type { SliceSnapshot } from '../../../../shared/src/slice-types'
import type { KernelCommand, TxId, WriteTransport } from '../../../../shared/src/write-contract'
import { installMobxWarnTrap } from '../mobx-trap'

import { writableMobxPoolArm, type WritableMobxPoolHandle } from './arm'

installMobxWarnTrap()

const SEEDS = Array.from(
  { length: Number(process.env['POD_POOL_GATE_SEEDS'] ?? 3) },
  (_, i) => i + 1,
)
const STEPS = Number(process.env['POD_POOL_GATE_STEPS'] ?? 200)
const GATE_TIMEOUT_MS = Math.max(1_500_000, SEEDS.length * STEPS * 5_000)

function fakeTransport(): WriteTransport & {
  readonly sent: { txId: TxId; command: KernelCommand }[]
} {
  const sent: { txId: TxId; command: KernelCommand }[] = []
  return {
    sent,
    send(txId, command) {
      sent.push({ txId, command })
    },
    subscribe() {
      return () => {}
    },
    pending() {
      return []
    },
  }
}

/** The removal-deaf plant, over the writable arm: removals never reach the pool. */
function deafToRemovals(source: RowSource): RowSource {
  return {
    snapshot: (kind) => source.snapshot(kind),
    ...(source.row === undefined ? {} : { row: source.row.bind(source) }),
    subscribe: (listener) =>
      source.subscribe((event) =>
        listener({ ...event, rows: event.rows.filter((row) => row.value !== undefined) }),
      ),
  }
}

/**
 * POD-4671 fixed: no gap patch (the same wrapper as `gate.test.ts`'s `gapped`).
 */
function gapped(
  arm: CheckableArm,
  tally: { applied: number },
): CheckedArm {
  void tally
  return arm
}

describe('L4b with optimistic edits enabled (write layer attached, idle)', () => {
  it(
    'passes every seed against the rebuild and the oracle',
    async () => {
      const cells = []
      for (const seed of SEEDS) {
        const transport = fakeTransport()
        const arm = writableMobxPoolArm(transport)
        const sequence = gen(seed, STEPS)
        const gap = { applied: 0 }
        const result = await checkArm(gapped(arm, gap), sequence)
        if (!result.ok) {
          throw new Error(
            `seed ${seed}: step ${result.step} diverged from the ${result.against}:\n${result.diff}`,
          )
        }
        expect(transport.sent).toEqual([])
        cells.push({ seed, steps: STEPS, counts: result.counts, gapApplied: gap.applied })
      }
      writeResult(`mobx-write-gate-1x-${SEEDS.length}x${STEPS}`, { seeds: SEEDS, steps: STEPS, cells })
    },
    GATE_TIMEOUT_MS,
  )

  it(
    'the removal-deaf plant fails every seed with the layer attached',
    async () => {
      let failures = 0
      for (const seed of SEEDS) {
        const transport = fakeTransport()
        const writable = writableMobxPoolArm(transport)
        const planted: CheckableArm = {
          create: (source, locals, reads) =>
            writable.create(deafToRemovals(source), locals, reads) as never,
        }
        const sequence = gen(seed, STEPS)
        const result = await checkArm(planted, sequence, { oracleEvery: 0, shrink: false })
        if (!result.ok) failures += 1
      }
      expect(failures).toBe(SEEDS.length)
    },
    GATE_TIMEOUT_MS,
  )
})
