/**
 * POD-4574 (Mc2) — L4b with the arm owning its optimism: the writable MobX
 * pool on the `truth` feed, generated edits routed through the arm's
 * `write.edit` into the real kernel transport (the shared `ArmEditAdapter`),
 * compared after every step with its optimism-aware rebuild and, every 10
 * steps and after the last, with the F4 write oracle (coordinator ruling:
 * server truth plus the shared reference log, `shared/src/gen/write-
 * oracle.ts`) — not with the kernel's optimistic paint, which retires an
 * applied overlay as soon as the server row moved past its enqueue baseline
 * while the contract holds the pending value until the echo (a finding, not
 * a failure; counted per step as `kernelDiffers`).
 *
 * Like `gate.test.ts`, the oracle comparison carries POD-4671's one-row gap
 * (`acceptUnscannedGap`), which throws once the seat exists. Seeds × steps
 * follow `gate.test.ts` (`POD_POOL_GATE_SEEDS`, default 3;
 * `POD_POOL_GATE_STEPS`, default 200). The gate of record is 20 × 300.
 * Timeout scales the same way (5 s per seed-step).
 *
 * VOCABULARY. Generated edits set titles and mark-reads only
 * (`editFields: ['title', 'readAt']`): a pending stage moves progress
 * roll-ups, which titles-overlaid-on-the-kernel-snapshot cannot judge.
 * Pending stages flow through the same overlaid row inputs as server stages
 * (the server-stage fences prove that path), so the Mc2 gate holds titles —
 * the one editable field a row draws — to the reference display and leaves
 * stage edits to the full phase-c gate. Mark-reads ride along invisibly
 * (`SliceSnapshot` carries no `readAt`) and exercise the collapse path.
 *
 * PLANTS (coordinator addendum). Two write-path plants on fixed sequences
 * (an edit, a remote on its pending field, then the rejection / comparison):
 * - (a) the rejection restores the server row captured at edit time instead
 *   of keeping current server truth — the MobX shape of "rewinding to the
 *   stale prior" (the overlay never renders the log's rewind target, so the
 *   plant clobbers the table). Caught by the rebuild (live stale vs rebuilt
 *   server) and the oracle.
 * - (c) a remote drops the pending entry: the object takes the server value
 *   on a pending field instead of keeping the local one. Caught by the
 *   oracle (the kernel's ledger still shows the pending value); a random run
 *   carries it too.
 * (b) an echo with equal values committing again and (d) a duplicate receipt
 * applied twice are commit-count plants: equal values are invisible to a
 * snapshot comparison by construction, so their catching checks are the
 * `settle.test.tsx` count cells (proven red by mutation; see `write/NOTES.md`).
 */

import { describe, expect, it } from 'vitest'
import { createEngineLocals } from '../../../../harness/src/engine-locals'
import { oracleSnapshot } from '../../../../harness/src/oracle/index'
import { writeResult } from '../../../../harness/src/results'
import type { CheckableArm } from '../../../../shared/src/arm'
import { ArmEditAdapter } from '../../../../shared/src/gen/arm-edits'
import { gen, type Change } from '../../../../shared/src/gen/changes'
import { checkArm, describeSequence, diffSnapshots, type CheckedArm } from '../../../../shared/src/gen/check'
import { startGenRun } from '../../../../shared/src/gen/run'
import { feedStep, WriteOracle } from '../../../../shared/src/gen/write-oracle'
import type { ScenarioEngine } from '../../../../shared/src/scenarios'
import type { SliceIssue, SliceSnapshot } from '../../../../shared/src/slice-types'
import { installMobxWarnTrap } from '../mobx-trap'
import { tracked } from '../pool'
import { acceptUnscannedGap } from '../worklist/known-gaps'
import { writableMobxPoolArm, type WritableMobxPoolHandle } from './arm'
import type { PendingLog } from '../../../../shared/src/write-contract'

installMobxWarnTrap()

/** TEMPORARY diagnosis aid (removed before landing): pending-state census. */
async function census(line: string): Promise<void> {
  const { appendFileSync } = await import('node:fs')
  appendFileSync('/tmp/gate-census.txt', `${line}\n`)
}

function patchesOf(log: PendingLog, id: string): string {
  const list = log
    .pendingFor('issue', id)
    .map((e) => `${String(e.txId).slice(0, 8)}:${JSON.stringify(e.patch)}`)
  return list.length === 0 ? '-' : list.join('+')
}

const SEEDS = Array.from(
  { length: Number(process.env['POD_POOL_GATE_SEEDS'] ?? 3) },
  (_, i) => i + Number(process.env['POD_POOL_GATE_FIRST_SEED'] ?? 1),
)
const STEPS = Number(process.env['POD_POOL_GATE_STEPS'] ?? 200)
const GATE_TIMEOUT_MS = Number(
  process.env['POD_POOL_GATE_TIMEOUT_MS'] ?? Math.max(1_500_000, SEEDS.length * STEPS * 5_000),
)
const SHRINK_RUNS = Number(process.env['POD_POOL_GATE_SHRINK_RUNS'] ?? 200)

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

/**
 * Plant (a): the rejection restores the server row captured at edit time
 * instead of keeping current server truth — the MobX shape of "rewinding to
 * the stale prior" (the overlay itself never renders the log's rewind target;
 * a stale restore has to clobber the table to show). Caught by the rebuild
 * (live stale vs rebuilt server) and the oracle.
 */
function staleRewind(handle: WritableMobxPoolHandle): void {
  const write = handle.write
  const atEdit = new Map<string, { id: string; row: SliceIssue }>()
  const edit = write.edit.bind(write)
  write.edit = ((kind, id, patch) => {
    // A tracked read (the pool's own reads go through its fenced tables
    // inside its action; the plant has neither, so it reads transiently).
    const server = tracked(() => handle.pool.tables.issue.get(id)) as SliceIssue | undefined
    const txId = edit(kind, id, patch)
    if (server !== undefined) atEdit.set(txId as string, { id, row: server })
    return txId
  }) as typeof write.edit
  const reject = write.reject.bind(write)
  write.reject = (rejection) => {
    reject(rejection)
    const stale = atEdit.get(rejection.txId as string)
    if (stale !== undefined) {
      // The mistake: put the edit-time server row back, clobbering the
      // remote value that landed while pending.
      handle.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: stale.id, value: stale.row }] })
    }
  }
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
 * POD-4671's one-row gap patched into a snapshot (the same rule as
 * `gate.test.ts`'s `gapped`): the oracle's row taken for each row
 * `acceptUnscannedGap` names, counted in `tally.applied`. A gap row carrying
 * a pending title keeps the live title: the gap is about the seat, and the
 * write oracle judges the pending display.
 */
function applyGap(
  handle: WritableMobxPoolHandle,
  ctx: ScenarioEngine,
  oracle: SliceSnapshot,
  snapshot: SliceSnapshot,
  tally: { applied: number },
): SliceSnapshot {
  const { rows } = acceptUnscannedGap(ctx.corpus, handle.pool, oracle, snapshot)
  if (rows.length === 0) return snapshot
  tally.applied += rows.length
  const rowsById = { ...snapshot.rowsById }
  for (const id of rows) {
    const patched = { ...oracle.rowsById[id]! }
    const liveTitle = snapshot.rowsById[id]?.title
    const pendingTitles = handle.write.log
      .pendingFor('issue', id)
      .map((e) => (e.patch as { title?: string }).title)
      .filter((t) => t !== undefined)
    if (pendingTitles.length > 0 && liveTitle === pendingTitles[pendingTitles.length - 1]) {
      patched.title = liveTitle as string
    }
    rowsById[id] = patched
  }
  return { ...snapshot, rowsById }
}

function gapped(
  arm: CheckedArm,
  tally: { applied: number },
): CheckedArm {
  return (ctx: ScenarioEngine) => ({
    create(source, locals, reads) {
      const resolved = typeof arm === 'function' ? arm(ctx) : arm
      const handle = resolved.create(source, locals, reads) as WritableMobxPoolHandle
      return {
        ...handle,
        snapshot: () => applyGap(handle, ctx, oracleSnapshot(ctx.engine.getSnapshot()), handle.snapshot(), tally),
        rebuildFromScratch: () =>
          applyGap(handle, ctx, oracleSnapshot(ctx.engine.getSnapshot()), handle.rebuildFromScratch(), tally),
      }
    },
  })
}

describe('L4b with the arm owning its optimism (truth feed, arm edits)', () => {
  it(
    'passes every seed against the rebuild and the write oracle',
    async () => {
      const cells = []
      for (const seed of SEEDS) {
        const adapter = new ArmEditAdapter()
        const oracle = new WriteOracle()
        let live: WritableMobxPoolHandle | null = null
        const inner = armWithAdapter(adapter)
        const arm: CheckedArm = (ctx: ScenarioEngine) => {
          const resolved = typeof inner === 'function' ? inner(ctx) : inner
          return {
            create: (source, locals, reads) => {
              const handle = resolved.create(source, locals, reads)
              live = handle as WritableMobxPoolHandle
              return handle
            },
          }
        }
        const sequence = gen(seed, STEPS, {}, { editFields: ['title', 'readAt'] })
        const gap = { applied: 0 }
        let firstDiff: string | null = null
        let kernelDiffers = 0
        let staleSkippedTotal = 0
        let oracleChecks = 0
        const result = await checkArm(gapped(arm, gap), sequence, {
          mode: 'truth',
          oracleEvery: 0,
          editViaArm: adapter.editHook,
          onStep: async (step, run) => {
            adapter.pairFromStep(step.detail ?? {})
            feedStep(oracle, step, run)
            const last = step.index === sequence.length - 1
            if ((step.index + 1) % 10 !== 0 && !last) return
            oracleChecks += 1
            const h = live
            if (h === null) throw new Error('no live arm at oracle step')
            const kernel = oracleSnapshot(run.ctx.engine.getSnapshot())
            const actual = applyGap(h, run.ctx, kernel, h.snapshot(), gap)
            const reference = oracle.patchSnapshot(kernel, run.feed().source)
            // F4 stale-hold allowance: the kernel keeps a chained overlay the
            // reference dropped (both logs settled it on the same receipt),
            // so kernel, arm and oracle agree on server truth everywhere
            // except the kernel's stale title. Skip exactly those rows: live
            // and oracle both show the server value while the kernel shows a
            // retired one. Counted per check (the finding), never silent, and
            // incapable of masking an arm bug (any live/oracle/server
            // disagreement still compares normally).
            const serverTitles = new Map<string, string>()
            for (const record of run.feed().source.snapshot('issue')) {
              if (record.value !== undefined) {
                serverTitles.set(record.id, (record.value as { title: string }).title)
              }
            }
            const expRows = { ...reference.rowsById }
            let staleSkipped = 0
            for (const [id, liveRow] of Object.entries(actual.rowsById)) {
              const serverTitle = serverTitles.get(id)
              const expRow = expRows[id]
              if (serverTitle === undefined || expRow === undefined) continue
              if (liveRow.title !== serverTitle) continue
              if (expRow.title === serverTitle) continue
              const oracleTitles = oracle.log
                .pendingFor('issue', id)
                .map((e) => (e.patch as { title?: string }).title)
              if (oracleTitles.length > 0) continue
              expRows[id] = { ...expRow, title: liveRow.title }
              staleSkipped += 1
            }
            const expected = { ...reference, rowsById: expRows }
            {
              const ids = oracle.pendingIds()
              const parts = ids.map(
                (id) => `${id}:arm=[${patchesOf(h.write.log, id)}]oracle=[${patchesOf(oracle.log, id)}]`,
              )
              const ledger = run.ctx.engine.pendingOverlaysByRow('issues')
              await census(
                `seed ${seed} step ${step.index} ${String(step.change.kind)}: ` +
                  `armPending=${h.write.log.size} oraclePending=${oracle.log.size} ` +
                  `ledgerRows=${ledger.size} outbox=${run.ctx.engine.outbox.pending().length}/` +
                  `${run.ctx.engine.outbox.awaiting().length} :: ${parts.join(' ')}`,
              )
            }
            if (diffSnapshots(kernel, reference) !== null) kernelDiffers += 1
            staleSkippedTotal += staleSkipped
            const diff = diffSnapshots(actual, expected)
            if (diff !== null && firstDiff === null) {
              const feedSource = run.feed().source
              const store = run.ctx.engine.getSnapshot() as unknown as {
                issues?: readonly unknown[]
                sessions?: readonly unknown[]
              }
              const census =
                `feed issues/sessions=${feedSource.snapshot('issue').length}/` +
                `${feedSource.snapshot('session').length} ` +
                `store issues/sessions=${store.issues?.length ?? '?'}/${store.sessions?.length ?? '?'}`
              firstDiff =
                `seed ${seed}: step ${step.index} diverged from the write oracle ` +
                `(${JSON.stringify(step.change)}):\n${diff}\n${census}`
            }
          },
        })
        if (!result.ok) {
          throw new Error(
            `seed ${seed}: step ${result.step} diverged from the ${result.against}:\n${result.diff}\n` +
              `shrunk (${result.shrunk.length} changes):\n${describeSequence(result.shrunk)}`,
          )
        }
        if (firstDiff !== null) throw new Error(firstDiff)
        cells.push({
          seed,
          steps: STEPS,
          counts: result.counts,
          gapApplied: gap.applied,
          oracleChecks,
          kernelDiffers,
          staleSkippedTotal,
        })
      }
      writeResult(`mobx-write-truth-gate-1x-${SEEDS.length}x${STEPS}`, { seeds: SEEDS, steps: STEPS, cells })
    },
    GATE_TIMEOUT_MS,
  )

  it(
    'plant (a) on a fixed sequence: restoring the edit-time row rewinds stale',
    async () => {
      for (const planted of [false, true]) {
        const adapter = new ArmEditAdapter()
        const run = await startGenRun({ feedMode: 'truth', editViaArm: adapter.editHook })
        const feed = run.feed()
        const locals = createEngineLocals(run.ctx.engine)
        const inner = writableMobxPoolArm(adapter.transport(run.ctx))
        const handle = inner.create(feed.source, locals.source) as WritableMobxPoolHandle
        adapter.currentEdit = (id, patch) => handle.write.edit('issue', id, patch)
        if (planted) staleRewind(handle)
        try {
          const id = run.ctx.targets.visibleRootId
          const sequence: Change[] = [
            { kind: 'edit', handle: 'e1', id, patch: { title: 'Mine fixed title' } },
            { kind: 'remoteOnPending', handle: 'e1', value: 'Theirs fixed title' },
            { kind: 'reject', handle: 'e1' },
          ]
          for (const change of sequence) {
            const step = await run.apply(change)
            expect(step.skipped).toBeUndefined()
            adapter.pairFromStep(step.detail ?? {})
          }
          locals.flush()
          const live = handle.snapshot()
          const rebuilt = handle.rebuildFromScratch()
          if (!planted) {
            // Clean: the rejection reveals the remote value, and the rebuild agrees.
            expect(live.rowsById[id]?.title).toBe('Theirs fixed title')
            expect(diffSnapshots(live, rebuilt)).toBeNull()
          } else {
            // Planted: the rejection rewinds to the stale prior; the rebuild
            // (and the oracle) show the server value.
            expect(live.rowsById[id]?.title).not.toBe(rebuilt.rowsById[id]?.title)
            expect(rebuilt.rowsById[id]?.title).toBe('Theirs fixed title')
            const oracle = oracleSnapshot(run.ctx.engine.getSnapshot())
            expect(live.rowsById[id]?.title).not.toBe(oracle.rowsById[id]?.title)
          }
        } finally {
          handle.dispose()
          locals.dispose()
          run.dispose()
        }
      }
    },
    120_000,
  )

  it(
    'plant (c) on a fixed sequence: a remote that drops pending takes the server value',
    async () => {
      for (const planted of [false, true]) {
        const adapter = new ArmEditAdapter()
        const run = await startGenRun({ feedMode: 'truth', editViaArm: adapter.editHook })
        const feed = run.feed()
        const locals = createEngineLocals(run.ctx.engine)
        const inner = writableMobxPoolArm(adapter.transport(run.ctx))
        const handle = inner.create(feed.source, locals.source) as WritableMobxPoolHandle
        adapter.currentEdit = (id, patch) => handle.write.edit('issue', id, patch)
        if (planted) dropPendingOnRemote(handle)
        try {
          const id = run.ctx.targets.visibleRootId
          const sequence: Change[] = [
            { kind: 'edit', handle: 'e1', id, patch: { title: 'Mine fixed title' } },
            { kind: 'remoteOnPending', handle: 'e1', value: 'Theirs fixed title' },
          ]
          for (const change of sequence) {
            const step = await run.apply(change)
            expect(step.skipped).toBeUndefined()
            adapter.pairFromStep(step.detail ?? {})
          }
          locals.flush()
          const live = handle.snapshot()
          const oracle = oracleSnapshot(run.ctx.engine.getSnapshot())
          if (!planted) {
            // Clean: local wins while pending, on both sides of the comparison.
            expect(live.rowsById[id]?.title).toBe('Mine fixed title')
            expect(oracle.rowsById[id]?.title).toBe('Mine fixed title')
          } else {
            // Planted: the object takes the server value; the kernel's ledger
            // still shows the pending one.
            expect(live.rowsById[id]?.title).toBe('Theirs fixed title')
            expect(oracle.rowsById[id]?.title).toBe('Mine fixed title')
          }
        } finally {
          handle.dispose()
          locals.dispose()
          run.dispose()
        }
      }
    },
    120_000,
  )

  it(
    'plant (c) fails a random run on the oracle',
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
