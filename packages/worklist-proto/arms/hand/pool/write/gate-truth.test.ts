/**
 * POD-4587 (Hc2) — L4b with the arm owning its optimism: the writable hand
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
 * Like `gate.test.ts`, the oracle comparison carries no gap (POD-4671 fixed:
 * the union roots seat the orphan). Seeds × steps follow `gate.test.ts`
 * (`POD_POOL_GATE_SEEDS`, default 3; `POD_POOL_GATE_STEPS`, default 200).
 * The gate of record is 20 × 300. Timeout scales the same way (5 s per seed-step).
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
 * (the server-stage fences prove that path), so the Hc2 gate holds titles —
 * the one editable field a row draws — to the reference display and leaves
 * stage edits to the full phase-c gate. Mark-reads ride along invisibly
 * (`SliceSnapshot` carries no `readAt`) and exercise the collapse path.
 *
 * HAND NOTES. The hand arm needs no per-level overlay work in the gate: its
 * pending display is overlaid at the row-reader boundary (`pool.inputs.issue`
 * and `pool.visibleInputs.issueRow`, the two doors every part reads through,
 * including `standing`'s `issueRow` read of `readAt`), its rebuild overlays
 * the feed snapshot before deriving, and its bootstrap re-applies from the
 * feed source so reload priors agree exactly. Supersede steps press arm
 * mark-reads per handle and ride `feedStep` as intents like every other
 * generated edit.
 *
 * PLANTS (coordinator addendum, mirroring Mc2). Fixed sequences plus the
 * gate's own rows:
 * - (a) the rejection restores the server row captured at edit time instead
 *   of keeping current server truth — the hand shape of "rewinding to the
 *   stale prior" (the overlay never renders the log's rewind target, so the
 *   plant clobbers the table with the edit-time row, as the MobX one does).
 *   Caught by the rebuild (live stale vs rebuilt server) and the oracle.
 * - (c) a remote drops the pending entry: the object takes the server value
 *   on a pending field instead of keeping the local one. Caught by the
 *   oracle; a random run carries it too.
 * - (i) visibility ignores the pending readAt (the overlaid `issueRow` door
 *   replaced with the raw table read): the reopened decay window stays shut
 *   live while the rebuild shows it.
 * - (ii) a phantom pending read the kernel, feed and reference log never
 *   learn: both arm derivations show it (common-mode) while the shared
 *   oracle hides it.
 * - (iii) remotes held until receipt (the old onStep-sync skew moved into
 *   an arm): fixed edit → remote → accept sequences pin the mechanism.
 * (b) an echo with equal values committing again and (d) a duplicate receipt
 * applied twice are commit-count plants: equal values are invisible to a
 * snapshot comparison by construction, so their catching checks are the
 * `settle.test.tsx` count cells (proven red by mutation; see `write/NOTES.md`).
 *
 * DETERMINISM. Mark-read stamps come from the engine coarse clock per step
 * (runStamp), and settleStep waits on real signals only (macrotask yield +
 * feed flush + settleLoads/pendingLoads, InstrumentError on stuck loads);
 * no Date.now, no wall-clock cap. Same seed gives byte-identical rows.
 */

import { describe, expect, it } from 'vitest'
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
import {
  harnessWritableHandPoolArm,
  type HarnessWritableHandPoolHandle,
} from '../../../../harness/src/adapters/hand-pool'

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

/** The test instrument itself cannot settle (never the arm under test). */
class InstrumentError extends Error {}

/**
 * Settle stragglers before an oracle comparison: run.apply already quiesced,
 * but post-reload replica/store trickle (settle timers, binding catch-up,
 * dep edges riding issue writes) can land rows in the feed after the
 * checker's own drain, leaving pool tables behind the feed snapshot the
 * rebuild reads. One macrotask lets scheduled trickle arrive (a scheduling
 * primitive, not a wait heuristic); then the feed's own drain and the arm's
 * load hooks do the rest, each reporting directly: flush() delivers pending
 * feed signals synchronously, settleLoads() lands every queued load,
 * pendingLoads() says what is left. A load still pending after it was
 * landed is a stuck instrument, not a slow one — THROW (InstrumentError)
 * instead of continuing on stale state. No wall-clock cap, no quiet-round
 * heuristic, no round count. A real divergence is stable and still fails
 * loudly below.
 */
async function settleStep(
  run: {
    feed(): { flush(): unknown; source: RowSource }
    ctx: ScenarioEngine
  },
  handle: HarnessWritableHandPoolHandle,
): Promise<void> {
  await macrotask()
  run.feed().flush()
  await handle.settleLoads?.()
  run.feed().flush()
  const pending = handle.pendingLoads?.() ?? 0
  if (pending > 0) {
    throw new InstrumentError(
      `arm loads never settled (pendingLoads=${pending}): refusing to compare on stale state`,
    )
  }
}

/**
 * The writable arm over the adapter's transport, stashing the live write API
 * on every create so generated edits go through the current arm (a `refresh`
 * disposes the arm and creates a new one over the new engine). The reference
 * oracle watches the same feed from the same create call — the same delivery
 * stream, installed before the step's apply starts, dropped on dispose — so
 * both logs resolve every entry from identically ordered observations.
 */
function armWithAdapter(
  adapter: ArmEditAdapter,
  oracle?: WriteOracle,
  plant?: (handle: HarnessWritableHandPoolHandle) => void,
): CheckedArm {
  return (ctx: ScenarioEngine) => {
    const inner = harnessWritableHandPoolArm(adapter.transport(ctx))
    return {
      create: (source, locals, reads) => {
        const handle = inner.create(source, locals, reads) as HarnessWritableHandPoolHandle
        adapter.currentEdit = (id, patch) => handle.write.edit('issue', id, patch)
        const unwatch = oracle?.watch(ctx, source)
        plant?.(handle)
        if (unwatch === undefined) return handle
        const originalDispose = handle.dispose.bind(handle)
        return {
          ...handle,
          dispose: () => {
            unwatch()
            originalDispose()
          },
        }
      },
    } as CheckableArm
  }
}

/**
 * Plant (iii): the arm observes remotes late — every remote for a row with
 * an unreceipted pending entry is held until THAT row's receipt arrives, so
 * the accept's `ackBase` is stale and the released remote overtakes exactly
 * like the old onStep-sync oracle's skew did. Other rows' outcomes never
 * flush a held remote (a global flush would release everything early and
 * blunt the plant); dispose flushes the tail.
 */
function lateRemoteUntilAccept(handle: HarnessWritableHandPoolHandle): void {
  const write = handle.write
  const held = new Map<string, { kind: 'issue'; id: string; values: { title: string; stage: string; readAt: string | null } }>()
  const acked = new Set<string>()
  const remote = write.handleRemote.bind(write)
  write.handleRemote = (kind, id, values) => {
    if (kind === 'issue') {
      const pending = write.log.pendingFor(kind, id)
      if (pending.length > 0 && !pending.some((e) => acked.has(String(e.txId)))) {
        held.set(id, { kind, id, values: values as { title: string; stage: string; readAt: string | null } })
        return
      }
    }
    remote(kind, id, values)
  }
  // Release exactly the rows whose pending entry the outcome answers: the
  // remote then lands post-receipt against a stale ackBase and overtakes.
  const flushFor = (txId: unknown): void => {
    for (const [id, h] of [...held]) {
      const pending = write.log.pendingFor(h.kind, h.id)
      if (pending.some((e) => String(e.txId) === String(txId))) {
        held.delete(id)
        remote(h.kind, h.id, h.values as never)
      }
    }
  }
  // Release held remotes whose entries are gone (rejected, superseded):
  // server tracking must catch up once nothing is pending.
  const releaseOrphaned = (): void => {
    for (const [id, h] of [...held]) {
      if (write.log.pendingFor(h.kind, h.id).length === 0) {
        held.delete(id)
        remote(h.kind, h.id, h.values as never)
      }
    }
  }
  const flushAll = (): void => {
    if (held.size === 0) return
    const due = [...held.values()]
    held.clear()
    for (const h of due) remote(h.kind, h.id, h.values as never)
  }
  const accepted = write.handleAccepted.bind(write)
  write.handleAccepted = (txId) => {
    accepted(txId)
    acked.add(String(txId))
    flushFor(txId)
    releaseOrphaned()
  }
  const reject = write.reject.bind(write)
  write.reject = (rejection) => {
    reject(rejection)
    flushFor((rejection as { txId: unknown }).txId)
    releaseOrphaned()
  }
  const superseded = write.handleSuperseded.bind(write)
  write.handleSuperseded = (txId) => {
    superseded(txId)
    flushFor(txId)
    releaseOrphaned()
  }
  const dispose = write.dispose.bind(write)
  write.dispose = () => {
    flushAll()
    dispose()
  }
}

/**
 * Plant (a): the rejection restores the server row captured at edit time
 * instead of keeping current server truth — the hand shape of "rewinding to
 * the stale prior" (the overlay never renders the log's rewind target, so a
 * stale restore has to clobber the table with the edit-time row, as the
 * MobX one does). Caught by the rebuild (live stale vs rebuilt server) and
 * the oracle.
 */
function staleRewind(handle: HarnessWritableHandPoolHandle): void {
  const write = handle.write
  const atEdit = new Map<string, { id: string; row: SliceIssue }>()
  const edit = write.edit.bind(write)
  write.edit = ((kind, id, patch) => {
    // The pool's own reads go through its fenced tables; the plant reads the
    // raw table, bypassing the pending overlay, like a stale cache would.
    const server = handle.pool.tables.issue.get(id) as SliceIssue | undefined
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

/**
 * A hidden issue whose decay window a fresh read cursor reopens. Each id is
 * probed with a transport-free log entry — appended and rejected without
 * ever sending, so the kernel, the feed and the lane see nothing — and the
 * first whose rebuild shows wins. The two named ids reopened their windows
 * in the seed-1 and seed-4 gate runs; the scan behind them keeps the plant
 * working when the corpus moves. Throws when nothing does: the visibility
 * plants need a window-driven row, and a corpus without one must fail
 * loudly, not settle for a row hidden for another reason. The probe cursor
 * is the caller's run-clock stamp (never the wall clock), so reruns agree.
 */
function findWindowTarget(
  handle: HarnessWritableHandPoolHandle,
  source: RowSource,
  skipId: string,
  fresh: string,
): string {
  const live = handle.snapshot()
  const byId = new Map<string, { readAt?: unknown }>()
  for (const record of source.snapshot('issue')) {
    byId.set(record.id, (record.value ?? {}) as { readAt?: unknown })
  }
  const qualifies = (id: string): string | null => {
    if (id === skipId) return null
    const readAt = byId.get(id)?.readAt
    if (typeof readAt !== 'string' || readAt === '') return null
    if (id in live.rowsById) return null
    return readAt
  }
  const dynamic: string[] = []
  for (const id of byId.keys()) {
    if (id === 'i1380' || id === 'i1397' || dynamic.length >= 40) continue
    if (qualifies(id) !== null) dynamic.push(id)
  }
  let probes = 0
  for (const id of ['i1380', 'i1397', ...dynamic]) {
    const readAt = qualifies(id)
    if (readAt === null) continue
    probes += 1
    const txId = `probe-${probes}`
    handle.write.log.append(
      { txId, kind: 'issue', id, patch: { readAt: fresh }, prior: { readAt } } as never,
      undefined,
    )
    const shows = id in handle.rebuildFromScratch().rowsById
    handle.write.log.reject({ txId: txId as never, error: { message: '[probe] not an edit', parked: false } })
    if (shows) return id
  }
  throw new Error('[plant] no window-driven hidden issue among the candidates')
}

/** The run-clock mark-read stamp for probes and plants (never the wall clock). */
function runStamp(run: { ctx: ScenarioEngine }): string {
  return new Date(run.ctx.engine.getSnapshot().coarseNow).toISOString()
}

/** Plant (c): any remote drops the pending entry, so the object takes the server value. */
function dropPendingOnRemote(handle: HarnessWritableHandPoolHandle, exercised?: () => void): void {
  const write = handle.write
  const remote = write.handleRemote.bind(write)
  write.handleRemote = (kind, id, values) => {
    remote(kind, id, values)
    for (const edit of write.log.pendingFor(kind, id)) {
      exercised?.()
      write.reject({ txId: edit.txId, error: { message: '[plant] remote drops pending', parked: false } })
    }
  }
}

/**
 * POD-4671 fixed: no gap patch.
 */
function applyGap(
  handle: HarnessWritableHandPoolHandle,
  ctx: ScenarioEngine,
  oracle: SliceSnapshot,
  snapshot: SliceSnapshot,
  tally: { applied: number },
): SliceSnapshot {
  void handle
  void ctx
  void oracle
  void tally
  return snapshot
}

function gapped(
  arm: CheckedArm,
  tally: { applied: number },
  oracle: WriteOracle,
): CheckedArm {
  return (ctx: ScenarioEngine) => ({
    create(source, locals, reads) {
      const resolved = typeof arm === 'function' ? arm(ctx) : arm
      const handle = resolved.create(source, locals, reads) as HarnessWritableHandPoolHandle
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

/** One seed's row in the gate result file (complete-or-fail: every seed lands one). */
interface GateCell {
  seed: number
  steps: number
  ok: boolean
  against?: string
  failStep?: number
  change?: unknown
  diff?: string
  counts: unknown
  gapApplied: number
  oracleChecks: number
  oracleFailed: number
  kernelDiffers: number
  firstKernelDiffStep: number
  firstKernelDiff: string | null
  healed: number
  failedSteps: number[]
  /** The reference oracle's consumed stream events per touched row (ruling:
   *  a skew reads directly from the output). */
  oracleEvents: Record<string, string[]>
}

/**
 * One gate seed, start to finish: rebuild compare every step, oracle compare
 * every 10th, per-seed row back (never throws — the caller fails at the end
 * when any seed failed). An optional plant runs inside every arm create.
 */
async function runGateSeed(
  seed: number,
  plant?: (handle: HarnessWritableHandPoolHandle) => void,
): Promise<GateCell> {
  const adapter = new ArmEditAdapter()
  const oracle = new WriteOracle()
  const arm = armWithAdapter(adapter, oracle, plant)
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
  // checkArm re-runs the sequence (dense re-run, shrink candidates, replay)
  // through fresh GenRuns that share this adapter and oracle. Only the first
  // run is the gate's own: counting or feeding any later one would mix
  // shrink artifacts into this seed's row (steps, checks, consumed events).
  // The verdict never depends on this hook — checkArm compares internally.
  let mainRun: unknown = null
  const result = await checkArm(gapped(arm, gap, oracle), sequence, {
    mode: 'truth',
    oracleEvery: 0,
    maxShrinkRuns: SHRINK_RUNS,
    editViaArm: adapter.editHook,
    onStep: async (step, run, handle) => {
      if (mainRun === null) mainRun = run
      if (run !== mainRun) return
      adapter.pairFromStep(step.detail ?? {})
      feedStep(oracle, step, run)
      const last = step.index === sequence.length - 1
      if ((step.index + 1) % 10 !== 0 && !last) return
      oracleChecks += 1
      // `handle` is the live arm after any swap: on a refresh step
      // checkArm recreates over the new feed before this runs, so the
      // fidelity compare below always reads the current arm — never a
      // disposed pre-refresh one.
      const h = handle as HarnessWritableHandPoolHandle
      // Settle stragglers before comparing: run.apply already quiesced,
      // but post-reload replica/store trickle (settle timers, binding
      // catch-up) can land rows in the feed after the checker's own
      // drain. settleStep waits on the feed drain and the arm's load
      // hooks (throwing on a stuck instrument, never masking); a real
      // divergence survives it and still fails loudly below.
      await settleStep(run, h)
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
        await settleStep(run, h)
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
          `(${firstDiffChange}):\n${diff}`
      }
      if (diff !== null) {
        failedSteps.push(step.index)
      }
    },
  })
  const oracleEvents = oracle.consumedEvents()
  const base = {
    seed,
    steps: STEPS,
    counts: result.counts,
    gapApplied: gap.applied,
    oracleChecks,
    oracleFailed,
    kernelDiffers,
    firstKernelDiffStep,
    firstKernelDiff,
    healed,
    failedSteps,
    oracleEvents,
  }
  // Complete-or-fail: every seed lands its row; the test fails at the
  // end when any seed failed, never mid-loop.
  if (!result.ok) {
    return {
      ...base,
      ok: false,
      against: result.against,
      failStep: result.step,
      change: result.change,
      diff:
        `seed ${seed}: step ${result.step} diverged from the ${result.against}:\n${result.diff}\n` +
        `shrunk (${result.shrunk.length} changes):\n${describeSequence(result.shrunk)}\n` +
        `counts=${JSON.stringify(result.counts)}`,
    }
  }
  if (firstDiff !== null) {
    return {
      ...base,
      ok: false,
      against: 'oracle',
      failStep: firstDiffStep,
      change: firstDiffChange,
      diff:
        `${firstDiff}\noracle checks failed ${oracleFailed}/${oracleChecks} ` +
        `at steps [${failedSteps.join(',')}]`,
    }
  }
  return { ...base, ok: true }
}

describe('L4b with the arm owning its optimism (truth feed, arm edits)', () => {
  it(
    'passes every seed against the rebuild and the write oracle',
    async () => {
      const cells: GateCell[] = []
      for (const seed of SEEDS) cells.push(await runGateSeed(seed))
      writeResult(`hand-write-truth-gate-1x-${SEEDS.length}x${STEPS}`, { seeds: SEEDS, steps: STEPS, cells })
      const failed = cells.filter((cell) => !cell.ok)
      if (failed.length > 0) {
        const lines = failed.map(
          (c) =>
            `seed ${c.seed} vs ${c.against ?? '?'} at step ${c.failStep ?? '?'}: ${(c.diff ?? '').split('\n')[0]}`,
        )
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
        const inner = harnessWritableHandPoolArm(adapter.transport(run.ctx))
        const handle = inner.create(feed.source, locals.source) as HarnessWritableHandPoolHandle
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
        const inner = harnessWritableHandPoolArm(adapter.transport(run.ctx))
        const handle = inner.create(feed.source, locals.source) as HarnessWritableHandPoolHandle
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
      // POD-4671: compare every step, not every 10th. A dropped pending is
      // transient (the server acks and clears it); the seating gap used to
      // fail every seed persistently and masked cadence weakness. With the
      // orphan seated, the plant must catch the transient itself to stay
      // strong — never weaken the 3/3 expectation.
      //
      // POD-4741 (seed 7, same as the MobX arm's POD-5002): every seed starts
      // with a forced title edit plus a conflicting remote title while
      // pending (`forcePendingRemote`), so the plant is EXERCISED on a visible
      // row in every seed; the run must then be CAUGHT by the oracle.
      let failures = 0
      const cells: {
        seed: number
        exercised: number
        caught: boolean
        against: string | null
        steps: number
        diff: string | null
      }[] = []
      for (const seed of SEEDS) {
        let exercised = 0
        const adapter = new ArmEditAdapter()
        const oracle = new WriteOracle()
        const planted = armWithAdapter(adapter, oracle, (handle) =>
          dropPendingOnRemote(handle, () => {
            exercised += 1
          }),
        )
        const sequence = gen(seed, STEPS, {}, { forcePendingRemote: true })
        const result = await checkArm(planted, sequence, {
          mode: 'truth',
          shrink: false,
          oracleEvery: 1,
          editViaArm: adapter.editHook,
          onStep: (step, run) => {
            adapter.pairFromStep(step.detail ?? {})
            feedStep(oracle, step, run)
          },
        })
        cells.push({
          seed,
          exercised,
          caught: !result.ok,
          against: result.ok ? null : result.against,
          steps: result.counts.steps,
          diff: result.ok ? null : result.diff,
        })
        if (!result.ok) failures += 1
      }
      writeResult(`hand-write-truth-plant-c-${SEEDS.length}x${STEPS}`, { cells })
      for (const cell of cells) {
        console.info(`[plant (c)] seed ${cell.seed}: exercised=${cell.exercised}, caught=${cell.caught}`)
        expect(cell.exercised, `seed ${cell.seed}: plant (c) was EXERCISED`).toBeGreaterThan(0)
        expect(cell.caught, `seed ${cell.seed}: plant (c) was caught`).toBe(true)
        expect(cell.against, `seed ${cell.seed}: caught by the oracle`).toBe('oracle')
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
        const inner = harnessWritableHandPoolArm(adapter.transport(run.ctx))
        const handle = inner.create(feed.source, locals.source) as HarnessWritableHandPoolHandle
        adapter.currentEdit = (id, patch) => handle.write.edit('issue', id, patch)
        // The plant: visibility reads the server-only row, never the
        // pending display — the hand shape of the pre-fix MobX lane (their
        // wrapper now overlays the pending cursor; here the overlaid
        // `issueRow` door is replaced with the raw table read).
        if (planted) {
          const visible = handle.pool.visibleInputs as {
            issueRow(id: string): SliceIssue | undefined
          }
          const tables = handle.pool.tables
          visible.issueRow = (id: string) => tables.issue.get(id) as SliceIssue | undefined
        }
        try {
          const id = findWindowTarget(handle, feed.source, run.ctx.corpus.unscannedWorktree.issueId, runStamp(run))
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
            // shows it — the gate's hidden-window shape.
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
        const inner = harnessWritableHandPoolArm(adapter.transport(run.ctx))
        const handle = inner.create(feed.source, locals.source) as HarnessWritableHandPoolHandle
        adapter.currentEdit = (id, patch) => handle.write.edit('issue', id, patch)
        try {
          const id = findWindowTarget(handle, feed.source, run.ctx.corpus.unscannedWorktree.issueId, runStamp(run))
          // The plant: a mark-read the arm logs but never sends — the
          // kernel, the feed and the reference log never learn it, yet both
          // arm derivations paint it through the real overlay path.
          if (planted) {
            const fresh = runStamp(run)
            const feedRow = feed.source.snapshot('issue').find((r) => r.id === id)
            const server = feedRow?.value as
              | { title: string; stage: string; readAt: string | null }
              | undefined
            if (server === undefined) throw new Error('[plant] target left the feed')
            handle.write.log.append(
              {
                txId: 'phantom-tx',
                kind: 'issue',
                id,
                patch: { readAt: fresh },
                prior: { readAt: server.readAt ?? null },
              } as never,
              undefined,
            )
            handle.write.handleRemote('issue', id, {
              title: server.title,
              stage: server.stage,
              readAt: server.readAt ?? null,
            } as never)
          }
          await settleStep(run, handle)
          locals.flush()
          // A real edit would materialise a cold row (ensureResident); the
          // phantom performs none, so hydrate the same way — otherwise the
          // live set lacks the row for loading reasons, not verdict reasons.
          {
            const residency = handle.pool.residency
            if (residency !== null && !handle.pool.tables.issue.has(id)) {
              if (residency.isCold('issue', id)) {
                residency.request('issue', id)
                handle.pool.hydrate()
              }
            }
          }
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

  it(
    'plant (iii): remotes held until receipt fail like the skew steps',
    async () => {
      // The old onStep-sync oracle's skew moved into an arm: remotes for a
      // row with an unreceipted pending entry arrive one receipt late, so the
      // accept's ackBase is stale and the released remote overtakes. The
      // timely reference oracle holds Mine; the planted arm drops it. Fixed
      // edit → remote → accept sequences on the skew rows the shakedown
      // found (seed 1@119 i3012, seed 2@139 i1014, seed 3@9 i4560) — no echo
      // step, so no echo-confirm race can heal either side; every
      // intermediate state is pinned after a quiesce. (A random-seeds
      // version of this plant proved flaky: an echo landing between the
      // accept and the check confirms both sides and converges. Fixed
      // sequences pin the mechanism deterministically.)
      const targets = ['i3012', 'i1014', 'i4560']
      for (const planted of [false, true]) {
        const adapter = new ArmEditAdapter()
        const oracle = new WriteOracle()
        const run = await startGenRun({ feedMode: 'truth', editViaArm: adapter.editHook })
        const feed = run.feed()
        const locals = createEngineLocals(run.ctx.engine)
        const inner = harnessWritableHandPoolArm(adapter.transport(run.ctx))
        const handle = inner.create(feed.source, locals.source) as HarnessWritableHandPoolHandle
        adapter.currentEdit = (id, patch) => handle.write.edit('issue', id, patch)
        const unwatch = oracle.watch(run.ctx, feed.source)
        if (planted) lateRemoteUntilAccept(handle)
        try {
          for (const [index, id] of targets.entries()) {
            const e = `e${index + 1}`
            const mine = `Mine ${e} fixed title`
            const theirs = `Theirs ${e} fixed title`
            let step = await run.apply({ kind: 'edit', handle: e, id, patch: { title: mine } })
            expect(step.skipped).toBeUndefined()
            adapter.pairFromStep(step.detail ?? {})
            feedStep(oracle, step, run)
            await settleStep(run, handle)
            expect(handle.write.log.pendingFor('issue', id).length).toBe(1)
            expect(oracle.log.pendingFor('issue', id).length).toBe(1)
            step = await run.apply({ kind: 'remoteOnPending', handle: e, value: theirs })
            expect(step.skipped).toBeUndefined()
            adapter.pairFromStep(step.detail ?? {})
            feedStep(oracle, step, run)
            await settleStep(run, handle)
            expect(handle.write.log.pendingFor('issue', id).length).toBe(1)
            expect(oracle.log.pendingFor('issue', id).length).toBe(1)
            step = await run.apply({ kind: 'accept', handle: e })
            expect(step.skipped).toBeUndefined()
            adapter.pairFromStep(step.detail ?? {})
            feedStep(oracle, step, run)
            await settleStep(run, handle)
            locals.flush()
            const liveTitle = handle.snapshot().rowsById[id]?.title
            const store = run.ctx.engine.getSnapshot()
            const expectedTitle = oracle.expectedSnapshot(store, feed.source).rowsById[id]?.title
            if (!planted) {
              // Clean: both sides saw the remote before the receipt and hold.
              expect(handle.write.log.pendingFor('issue', id).length).toBe(1)
              expect(oracle.log.pendingFor('issue', id).length).toBe(1)
              expect(liveTitle).toBe(mine)
              expect(expectedTitle).toBe(mine)
            } else {
              // Planted: the released remote overtakes against the stale
              // ackBase and drops the arm entry; the oracle holds.
              expect(handle.write.log.pendingFor('issue', id).length).toBe(0)
              expect(oracle.log.pendingFor('issue', id).length).toBe(1)
              expect(liveTitle).toBe(theirs)
              expect(expectedTitle).toBe(mine)
            }
          }
        } finally {
          unwatch()
          handle.dispose()
          locals.dispose()
          run.dispose()
        }
      }
    },
    300_000,
  )
})
