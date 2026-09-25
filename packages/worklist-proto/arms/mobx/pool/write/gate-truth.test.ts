/**
 * POD-4574 (Mc2) — L4b with the arm owning its optimism: the writable MobX
 * pool on the `truth` feed, generated edits routed through the arm's
 * `write.edit` into the real kernel transport (the shared `ArmEditAdapter`),
 * compared after every step with its optimism-aware rebuild and, every 10
 * steps and after the last, with the shared write oracle (coordinator
 * ruling, option b: the WHOLE expected snapshot from server truth plus the
 * shared reference log, `shared/src/gen/write-oracle.ts`). The kernel's own
 * fold is never expected values: kernel-fold differences (an applied overlay
 * retired on moved-past-baseline while the contract holds, or a chained
 * overlay held past a newer server value) count per check as `kernelDiffers`:
 * findings, not failures.
 *
 * Like `gate.test.ts`, the oracle comparison carries POD-4671's one-row gap
 * (`acceptUnscannedGap`), which throws once the seat exists. Seeds × steps
 * follow `gate.test.ts` (`POD_POOL_GATE_SEEDS`, default 3;
 * `POD_POOL_GATE_STEPS`, default 200). The gate of record is 20 × 300.
 * Timeout scales the same way (5 s per seed-step).
 *
 * COMPLETE-OR-FAIL. Every seed runs to the end and lands a per-seed row in
 * the result file (steps run, ok, first failing step, change, diff, kernel
 * finding); the test fails at the end when any seed failed — never on the
 * first failing seed, which once lost the counts and left seeds unrun.
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
import { runInAction } from 'mobx'
import { createEngineLocals } from '../../../../harness/src/engine-locals'
import { oracleSnapshot } from '../../../../harness/src/oracle/index'
import { writeResult } from '../../../../harness/src/results'
import type { CheckableArm, RowSource } from '../../../../shared/src/arm'
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

installMobxWarnTrap()

const SEEDS = Array.from(
  { length: Number(process.env['POD_POOL_GATE_SEEDS'] ?? 3) },
  (_, i) => i + Number(process.env['POD_POOL_GATE_FIRST_SEED'] ?? 1),
)
const STEPS = Number(process.env['POD_POOL_GATE_STEPS'] ?? 200)
const GATE_TIMEOUT_MS = Number(
  process.env['POD_POOL_GATE_TIMEOUT_MS'] ?? Math.max(1_500_000, SEEDS.length * STEPS * 5_000),
)
const SHRINK_RUNS = Number(process.env['POD_POOL_GATE_SHRINK_RUNS'] ?? 200)

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Settle stragglers before an oracle comparison: run.apply already quiesced,
 * but post-reload replica/store trickle (settle timers, binding catch-up,
 * dep edges riding issue writes) can land rows in the feed after the
 * checker's own drain, leaving pool tables behind the feed snapshot the
 * rebuild reads — or the store behind the feed. Bounded content-stable
 * rounds with explicit feed drains; returns the rounds taken. A real
 * divergence is stable and still fails loudly below — this waits for data
 * delivery only (all arm logic is synchronous), so it cannot mask an arm
 * bug. Filed as a harness gap for L4a (quiesce sufficiency on reload).
 */
async function settleStep(run: {
  feed(): { flush(): unknown; source: RowSource }
  ctx: ScenarioEngine
}): Promise<number> {
  const signature = (): string => {
    const parts: string[] = []
    for (const kind of ['issue', 'session', 'worktree'] as const) {
      const rows = run.feed().source.snapshot(kind)
      let maxStamp = 0
      for (const row of rows) {
        const v = row.value as Record<string, unknown> | undefined
        for (const key of ['updatedAt', 'lastActiveAt'] as const) {
          const t = v === undefined ? 0 : Date.parse(String(v[key] ?? 0)) || 0
          if (t > maxStamp) maxStamp = t
        }
      }
      parts.push(`${kind}:${rows.length}:${maxStamp}`)
    }
    return parts.join('|')
  }
  let quiet = 0
  let rounds = 0
  let last = ''
  const start = Date.now()
  while (rounds < 100 && quiet < 3 && Date.now() - start < 3000) {
    await macrotask()
    run.feed().flush()
    const sig = signature()
    if (sig === last) quiet += 1
    else quiet = 0
    last = sig
    rounds += 1
  }
  return rounds
}

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
 * A hidden decayed issue on a fresh run: a server readAt the live set does
 * not show, present in the pool tables (so a generated edit accepts it).
 * Throws when the corpus carries none — the visibility plants need the shape.
 */
function hiddenDecayedTarget(handle: WritableMobxPoolHandle, source: RowSource, skipId: string): string {
  const live = handle.snapshot()
  for (const record of source.snapshot('issue')) {
    const value = record.value as { readAt?: unknown } | undefined
    if (value === undefined || typeof value.readAt !== 'string' || value.readAt === '') continue
    if (record.id === skipId) continue
    if (!handle.pool.tables.issue.has(record.id)) continue
    if (record.id in live.rowsById) continue
    return record.id
  }
  throw new Error('[plant] no hidden decayed issue in the fresh corpus')
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
  oracle: WriteOracle,
): CheckedArm {
  return (ctx: ScenarioEngine) => ({
    create(source, locals, reads) {
      const resolved = typeof arm === 'function' ? arm(ctx) : arm
      const handle = resolved.create(source, locals, reads) as WritableMobxPoolHandle
      // The gap base is the same whole expected snapshot the oracle compare
      // uses below, so the known one-row exception is neutralized identically
      // on both sides of the rebuild compare.
      const base = (): SliceSnapshot =>
        oracle.expectedSnapshot(ctx.engine.getSnapshot(), source)
      return {
        ...handle,
        snapshot: () => applyGap(handle, ctx, base(), handle.snapshot(), tally),
        rebuildFromScratch: () =>
          applyGap(handle, ctx, base(), handle.rebuildFromScratch(), tally),
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
        const arm = armWithAdapter(adapter)
        const sequence = gen(seed, STEPS, {}, { editFields: ['title', 'readAt'] })
        const gap = { applied: 0 }
        let firstDiff: string | null = null
        let firstDiffStep = -1
        let firstDiffChange: string | null = null
        let firstKernelDiff: string | null = null
        let firstKernelDiffStep = -1
        let kernelDiffers = 0
        let oracleChecks = 0
        let oracleFailed = 0
        let healed = 0
        const failedSteps: number[] = []
        const result = await checkArm(gapped(arm, gap, oracle), sequence, {
          mode: 'truth',
          oracleEvery: 0,
          maxShrinkRuns: SHRINK_RUNS,
          editViaArm: adapter.editHook,
          onStep: async (step, run, handle) => {
            adapter.pairFromStep(step.detail ?? {})
            feedStep(oracle, step, run)
            const last = step.index === sequence.length - 1
            if ((step.index + 1) % 10 !== 0 && !last) return
            oracleChecks += 1
            // `handle` is the live arm after any swap: on a refresh step
            // checkArm recreates over the new feed before this runs, so the
            // fidelity compare below always reads the current arm — never a
            // disposed pre-refresh one.
            const h = handle as WritableMobxPoolHandle
            // Settle stragglers before comparing: run.apply already quiesced,
            // but post-reload replica/store trickle (settle timers, binding
            // catch-up) can land rows in the feed after the checker's own
            // drain. Bounded content-stable rounds with explicit feed drains;
            // a real divergence survives them and still fails loudly below.
            const settled = await settleStep(run)
            const compareOnce = (): {
              kernel: SliceSnapshot
              actual: SliceSnapshot
              expected: SliceSnapshot
              diff: string | null
            } => {
              const store = run.ctx.engine.getSnapshot()
              const kernel = oracleSnapshot(store)
              const expected = oracle.expectedSnapshot(store, run.feed().source)
              const actual = applyGap(h, run.ctx, expected, h.snapshot(), gap)
              return { kernel, actual, expected, diff: diffSnapshots(actual, expected) }
            }
            const first = compareOnce()
            // The kernel is the counted legacy finding, never expected
            // values: record each step it disagrees with the reference
            // display, with the first example, and write both to the note.
            const kernelDiff = diffSnapshots(first.kernel, first.expected)
            if (kernelDiff !== null) {
              kernelDiffers += 1
              if (firstKernelDiff === null) {
                firstKernelDiffStep = step.index
                firstKernelDiff =
                  `step ${step.index} kernel-vs-expected ` +
                  `(${JSON.stringify(step.change)}):\n${kernelDiff}`
              }
            }
            let diff = first.diff
            // Confirm-or-heal: the arm, the feed and the kernel converge over
            // async delivery (loads, binding catch-up, publish lag) that can
            // straddle the compare instant for exactly one check. Re-settle
            // and re-read everything fresh once; a systematic divergence
            // reproduces (all arm logic is synchronous), a delivery transient
            // heals. Healed checks are counted, never hidden.
            if (diff !== null) {
              await settleStep(run)
              const second = compareOnce()
              if (second.diff === null) {
                healed += 1
                diff = null
              } else {
                oracleFailed += 1
              }
            }
            if (diff !== null && firstDiff === null) {
              firstDiffStep = step.index
              firstDiffChange = JSON.stringify(step.change)
              firstDiff =
                `seed ${seed}: step ${step.index} diverged from the write oracle ` +
                `(${firstDiffChange}, settled=${settled}):\n${diff}`
            }
            if (diff !== null) {
              failedSteps.push(step.index)
            }
          },
        })
        // Complete-or-fail: every seed lands its row; the test fails at the
        // end when any seed failed, never mid-loop.
        if (!result.ok) {
          cells.push({
            seed,
            steps: STEPS,
            ok: false,
            against: result.against,
            failStep: result.step,
            change: result.change,
            diff:
              `seed ${seed}: step ${result.step} diverged from the ${result.against}:\n${result.diff}\n` +
              `shrunk (${result.shrunk.length} changes):\n${describeSequence(result.shrunk)}\n` +
              `counts=${JSON.stringify(result.counts)}`,
            counts: result.counts,
            gapApplied: gap.applied,
            oracleChecks,
            oracleFailed,
            kernelDiffers,
            firstKernelDiffStep,
            firstKernelDiff,
            healed,
            failedSteps,
          })
          continue
        }
        if (firstDiff !== null) {
          cells.push({
            seed,
            steps: STEPS,
            ok: false,
            against: 'oracle',
            failStep: firstDiffStep,
            change: firstDiffChange,
            diff:
              `${firstDiff}\noracle checks failed ${oracleFailed}/${oracleChecks} ` +
              `at steps [${failedSteps.join(',')}]`,
            counts: result.counts,
            gapApplied: gap.applied,
            oracleChecks,
            oracleFailed,
            kernelDiffers,
            firstKernelDiffStep,
            firstKernelDiff,
            healed,
            failedSteps,
          })
          continue
        }
        cells.push({
          seed,
          steps: STEPS,
          ok: true,
          counts: result.counts,
          gapApplied: gap.applied,
          oracleChecks,
          oracleFailed,
          kernelDiffers,
          firstKernelDiffStep,
          firstKernelDiff,
          healed,
          failedSteps,
        })
      }
      writeResult(`mobx-write-truth-gate-1x-${SEEDS.length}x${STEPS}`, { seeds: SEEDS, steps: STEPS, cells })
      const failed = cells.filter((cell) => cell.ok !== true)
      if (failed.length > 0) {
        const lines = failed.map((cell) => {
          const c = cell as { seed: number; against: unknown; failStep: unknown; diff: string }
          const firstLine = c.diff.split('\n')[0]
          return `seed ${c.seed} vs ${c.against} at step ${c.failStep}: ${firstLine}`
        })
        throw new Error(
          `truth gate failed for ${failed.length}/${cells.length} seeds:\n${lines.join('\n')}\n` +
            `(per-seed rows in the result file above)`,
        )
      }
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

  it(
    'plant (i): ignoring a pending readAt for visibility hides the reopened window',
    async () => {
      for (const planted of [false, true]) {
        const adapter = new ArmEditAdapter()
        const run = await startGenRun({ feedMode: 'truth', editViaArm: adapter.editHook })
        const feed = run.feed()
        const locals = createEngineLocals(run.ctx.engine)
        const inner = writableMobxPoolArm(adapter.transport(run.ctx))
        const handle = inner.create(feed.source, locals.source) as WritableMobxPoolHandle
        adapter.currentEdit = (id, patch) => handle.write.edit('issue', id, patch)
        // The plant: visibility reads the server-only lane, never the
        // pending cursor — the pre-fix shape (since 80e65b1ca the wrapper
        // overlays it).
        if (planted) {
          const visible = handle.pool.visibleInputs as {
            issueRead(id: string): string | null | undefined
          }
          visible.issueRead = (id: string) => handle.pool.readStates.get(id)
        }
        try {
          const id = hiddenDecayedTarget(
            handle,
            feed.source,
            run.ctx.corpus.unscannedWorktree.issueId,
          )
          const step = await run.apply({ kind: 'edit', handle: 'e1', id, patch: { readAt: true } })
          expect(step.skipped).toBeUndefined()
          adapter.pairFromStep(step.detail ?? {})
          locals.flush()
          const live = handle.snapshot()
          const rebuilt = handle.rebuildFromScratch()
          if (!planted) {
            // Clean: the pending cursor reopens the window on both sides.
            expect(id in live.rowsById).toBe(true)
            expect(id in rebuilt.rowsById).toBe(true)
            expect(diffSnapshots(live, rebuilt)).toBeNull()
          } else {
            // Planted: live hides the row while the rebuild (overlaid rows)
            // shows it — the gate's seed-1/step-6 shape.
            expect(id in live.rowsById).toBe(false)
            expect(id in rebuilt.rowsById).toBe(true)
            expect(diffSnapshots(live, rebuilt)).not.toBeNull()
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
    'plant (ii): a row visible with no pending read fails the shared oracle',
    async () => {
      for (const planted of [false, true]) {
        const adapter = new ArmEditAdapter()
        const oracle = new WriteOracle()
        const run = await startGenRun({ feedMode: 'truth', editViaArm: adapter.editHook })
        const feed = run.feed()
        const locals = createEngineLocals(run.ctx.engine)
        const inner = writableMobxPoolArm(adapter.transport(run.ctx))
        const handle = inner.create(feed.source, locals.source) as WritableMobxPoolHandle
        adapter.currentEdit = (id, patch) => handle.write.edit('issue', id, patch)
        try {
          const id = hiddenDecayedTarget(
            handle,
            feed.source,
            run.ctx.corpus.unscannedWorktree.issueId,
          )
          // The plant: a phantom fresh cursor the reference log never holds,
          // seen by both arm derivations and by nothing else.
          if (planted) {
            const fresh = new Date(Date.now()).toISOString()
            const visible = handle.pool.visibleInputs as {
              issueRead(id: string): string | null | undefined
            }
            const originalRead = visible.issueRead.bind(handle.pool.visibleInputs)
            visible.issueRead = (vid: string) => (vid === id ? fresh : originalRead(vid))
            const display = handle.write.pendingDisplay.bind(handle.write) as (
              kind: string,
              vid: string,
            ) => unknown
            handle.write.pendingDisplay = ((kind: string, vid: string) =>
              kind === 'issue' && vid === id ? { readAt: fresh } : display(kind, vid)) as unknown as typeof handle.write.pendingDisplay
          }
          await settleStep(run)
          locals.flush()
          const live = handle.snapshot()
          const rebuilt = handle.rebuildFromScratch()
          const store = run.ctx.engine.getSnapshot()
          const kernel = oracleSnapshot(store)
          const expected = oracle.expectedSnapshot(store, feed.source)
          const gapTally = { applied: 0 }
          const actual = applyGap(handle, run.ctx, expected, live, gapTally)
          if (!planted) {
            expect(id in live.rowsById).toBe(false)
            expect(id in rebuilt.rowsById).toBe(false)
            expect(id in expected.rowsById).toBe(false)
            expect(diffSnapshots(actual, expected)).toBeNull()
          } else {
            // Both arm derivations show the phantom row (common-mode), the
            // kernel hides it, and the shared oracle — nothing pending in
            // the reference log — hides it too.
            expect(id in live.rowsById).toBe(true)
            expect(id in rebuilt.rowsById).toBe(true)
            expect(diffSnapshots(live, rebuilt)).toBeNull()
            expect(id in kernel.rowsById).toBe(false)
            expect(id in expected.rowsById).toBe(false)
            const diff = diffSnapshots(actual, expected)
            expect(diff).not.toBeNull()
            expect(diff).toContain(id)
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
})
