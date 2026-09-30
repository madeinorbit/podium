/**
 * POD-4586 (Hc1) — L4b with the write layer attached: the existing
 * correctness gate still passes with optimism wired in but idle, and its
 * removal-deaf plant still fails every seed.
 *
 * The layer holds no pending edit during these runs (no arm-side edit is
 * made), so the pool answers server truth exactly as `handPoolArm` does; the
 * overlay wrappers return the server objects unchanged. The feed stays
 * `overlaid` (the roster's mode for a pool that does not yet own optimism):
 * the generator's kernel-side edits arrive folded, as the oracle sees them.
 * Hc2 (c2) moves this run to `truth` with arm-side edits.
 *
 * Like `gate.test.ts`, rebuild-only (`oracleEvery: 0`). Seeds × steps
 * follow `gate.test.ts` (`POD_POOL_GATE_SEEDS`, default 3;
 * `POD_POOL_GATE_STEPS`, default 200). Timeout scales the same way.
 */

import { describe, expect, it } from 'vitest'
import { writeResult } from '../../../../harness/src/results'
import type { CheckableArm, RowSource } from '../../../../shared/src/arm'
import { gen } from '../../../../shared/src/gen/changes'
import { checkArm } from '../../../../shared/src/gen/check'
import type { SliceIssue } from '../../../../shared/src/slice-types'
import type { KernelCommand, TxId, WriteTransport } from '../../../../shared/src/write-contract'
import {
  harnessWritableHandPoolArm,
  type HarnessWritableHandPoolHandle,
} from '../../../../harness/src/adapters/hand-pool'

const SEEDS = Array.from(
  { length: Number(process.env['POD_POOL_GATE_SEEDS'] ?? 3) },
  (_, i) => i + 1,
)
const STEPS = Number(process.env['POD_POOL_GATE_STEPS'] ?? 200)
const GATE_TIMEOUT_MS = Math.max(1_500_000, SEEDS.length * STEPS * 2_500)

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

describe('L4b with optimistic edits enabled (write layer attached, idle)', () => {
  it(
    'passes every seed against the rebuild',
    async () => {
      const cells = []
      for (const seed of SEEDS) {
        const transport = fakeTransport()
        const arm = harnessWritableHandPoolArm(transport)
        const sequence = gen(seed, STEPS)
        const result = await checkArm(arm, sequence, { oracleEvery: 0 })
        if (!result.ok) {
          throw new Error(
            `seed ${seed}: step ${result.step} diverged from the ${result.against}:\n${result.diff}`,
          )
        }
        expect(transport.sent).toEqual([])
        cells.push({ seed, steps: STEPS, counts: result.counts })
      }
      writeResult(`hand-write-gate-1x-${SEEDS.length}x${STEPS}`, { seeds: SEEDS, steps: STEPS, cells })
    },
    GATE_TIMEOUT_MS,
  )

  it(
    'the removal-deaf plant fails every seed with the layer attached',
    async () => {
      let failures = 0
      for (const seed of SEEDS) {
        const transport = fakeTransport()
        const writable = harnessWritableHandPoolArm(transport)
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

  it(
    'the rewind-to-current plant fails every seed',
    async () => {
      // Non-vacuity first: an arm-side edit with a TRUE reject converges
      // inside the gate (seed 1), so a divergence below is the plant's.
      {
        const transport = fakeTransport()
        const result = await checkArm(editedArm(transport, false), gen(1, STEPS), {
          oracleEvery: 0,
          shrink: false,
        })
        if (!result.ok) {
          throw new Error(
            `clean edit+reject diverged (seed 1, step ${result.step}) from the ${result.against}:\n${result.diff}`,
          )
        }
        // No send count asserted here: gen sequences reload, and each reload
        // re-creates the arm (runCheck `create()`), which edits again. The
        // edit tests pin the one-edit-one-send shape exactly.
      }
      let caught = 0
      for (const seed of SEEDS) {
        const transport = fakeTransport()
        const result = await checkArm(editedArm(transport, true), gen(seed, STEPS), {
          oracleEvery: 0,
          shrink: false,
        })
        if (!result.ok) caught += 1
      }
      expect(caught).toBe(SEEDS.length)
    },
    GATE_TIMEOUT_MS,
  )
})

/**
 * Write-specific plant: rewind to the CURRENT display instead of the kept
 * prior. The arm bootstraps, makes one arm-side title edit on the first
 * visible row, then rejects it. Clean (`plant: false`) rewinds through the
 * log to the kept prior and the gate passes; planted (`plant: true`) drops
 * the log entry without refreshing the overlay, so the stale pending title
 * stays painted with an empty log and the very first rebuild comparison
 * diverges. A title moves no relation and no rank, so the diff is that row's
 * title alone.
 */
const PLANTED_TITLE = 'Planted write-path title'

function editedArm(
  transport: WriteTransport & { readonly sent: { txId: TxId; command: KernelCommand }[] },
  plant: boolean,
): CheckableArm {
  const inner = harnessWritableHandPoolArm(transport)
  return {
    create: (source, locals, reads) => {
      const handle = inner.create(source, locals, reads) as HarnessWritableHandPoolHandle
      const ids = Object.keys(handle.snapshot().rowsById).sort()
      const id = ids.find((candidate) => {
        const title = (handle.pool.inputs.issue(candidate) as SliceIssue | undefined)?.title
        return title !== undefined && title !== PLANTED_TITLE
      })
      if (id === undefined) throw new Error('[plant] no editable visible row at bootstrap')
      const tx = handle.write.edit('issue', id, { title: PLANTED_TITLE })
      if (plant) handle.write.log.reject({ txId: tx, error: { message: 'refused', parked: false } })
      else handle.write.reject({ txId: tx, error: { message: 'refused', parked: false } })
      return handle
    },
  }
}
