/**
 * POD-4574 (Mc2) — L4b with the arm owning its optimism: the writable MobX
 * pool on the `truth` feed, generated edits routed through the arm's
 * `write.edit` into the real kernel transport (the shared `ArmEditAdapter`),
 * compared after every step with its optimism-aware rebuild and, every 10
 * steps and after the last, with the F4 write oracle (coordinator ruling:
 * server truth plus the shared reference log for every row, whatever the
 * kernel or the arm shows, `shared/src/gen/write-oracle.ts`). Kernel-fold
 * differences (an applied overlay retired on moved-past-baseline while the
 * contract holds, or a chained overlay held past a newer server value) count
 * per check as `kernelDiffers`: findings, not failures.
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
        let oracleChecks = 0
        let oracleFailed = 0
        const result = await checkArm(gapped(arm, gap), sequence, {
          mode: 'truth',
          oracleEvery: 0,
          maxShrinkRuns: SHRINK_RUNS,
          editViaArm: adapter.editHook,
          onStep: async (step, run) => {
            adapter.pairFromStep(step.detail ?? {})
            feedStep(oracle, step, run)
            // TEMPORARY diagnosis (removed before landing): skipped steps.
            if (step.skipped !== undefined) {
              const { appendFileSync } = await import('node:fs')
              appendFileSync(
                '/tmp/skipped.txt',
                `seed ${seed} step ${step.index} ${String(step.change.kind)} skipped: ${step.skipped}\n`,
              )
            }
            const last = step.index === sequence.length - 1
            if ((step.index + 1) % 10 !== 0 && !last) return
            oracleChecks += 1
            // Settle stragglers before comparing: run.apply already quiesced,
            // but post-reload replica/store trickle (settle timers, binding
            // catch-up) can land rows in the feed after the checker's own
            // drain. Bounded quiet rounds with explicit feed drains; a real
            // divergence survives them and still fails loudly below.
            const settled = await settleStep(run)
            const h = live
            if (h === null) throw new Error('no live arm at oracle step')
            const kernel = oracleSnapshot(run.ctx.engine.getSnapshot())
            const actual = applyGap(h, run.ctx, kernel, h.snapshot(), gap)
            const expected = oracle.patchSnapshot(kernel, run.feed().source)
            if (diffSnapshots(kernel, expected) !== null) kernelDiffers += 1
            const diff = diffSnapshots(actual, expected)
            // TEMPORARY diagnosis (removed before landing): the coordinator's
            // check — legacy derivation over the FEED's server rows. If it
            // matches the kernel, the kernel converged and live+rebuild share
            // a rollup bug; if it matches live, the kernel hasn't converged
            // (harness fix with a real settle signal).
            {
              const { snapshotFromStore } = await import('../../../../harness/src/oracle/index')
              const { appendFileSync } = await import('node:fs')
              try {
                const store = run.ctx.engine.getSnapshot()
                const feedIssues = run
                  .feed()
                  .source.snapshot('issue')
                  .map((r) => r.value)
                  .filter((v) => v !== undefined)
                const feedSessions = run
                  .feed()
                  .source.snapshot('session')
                  .map((r) => r.value)
                  .filter((v) => v !== undefined)
                const fakeStore = {
                  ...store,
                  issues: feedIssues,
                  sessions: feedSessions,
                  issueProjections: [],
                  replica: undefined,
                }
                const feedOracle = snapshotFromStore(fakeStore as never, {
                  selectedIssueId: null,
                  coarseNow: (store as unknown as { coarseNow: number }).coarseNow,
                } as never)
                const r = feedOracle.rowsById['i3150'] as
                  | { progressDone?: number; progressTotal?: number }
                  | undefined
                appendFileSync(
                  '/tmp/feed-oracle.txt',
                  `seed ${seed} step ${step.index}: feedOracle=${r === undefined ? 'absent' : `${r.progressDone}/${r.progressTotal}`}\n`,
                )
              } catch (error) {
                appendFileSync(
                  '/tmp/feed-oracle.txt',
                  `seed ${seed} step ${step.index}: ERROR ${error instanceof Error ? error.message : String(error)}\n`,
                )
              }
            }
            // TEMPORARY diagnosis (removed before landing): lane counts.
            {
              const { appendFileSync } = await import('node:fs')
              appendFileSync(
                '/tmp/lanes.txt',
                `seed ${seed} step ${step.index}: feedWorktrees=${run.feed().source.snapshot('worktree').length}\n`,
              )
            }
            // TEMPORARY diagnosis (removed before landing): full session
            // value diff feed-vs-store on divergence.
            if (diff !== null && firstDiff === null) {
              const feedSess = new Map(
                run
                  .feed()
                  .source.snapshot('session')
                  .map((r) => [r.id, r.value as Record<string, unknown> | undefined]),
              )
              const storeSess = new Map(
                (
                  (run.ctx.engine.getSnapshot() as unknown as { sessions?: Record<string, unknown>[] }).sessions ?? []
                ).map((s) => [String(s['sessionId'] ?? s['id']), s]),
              )
              const sessDiffs: string[] = []
              for (const [id, f] of feedSess) {
                const s = storeSess.get(id)
                if (s === undefined) {
                  sessDiffs.push(`${id}:feed-only`)
                  continue
                }
                const phaseOf = (v: Record<string, unknown> | undefined): unknown =>
                  (v?.['agentState'] as Record<string, unknown> | undefined)?.['phase'] ?? null
                const offerOf = (v: Record<string, unknown> | undefined): unknown =>
                  v?.['offer'] === undefined ? null : 'offer'
                const pairs: [string, unknown, unknown][] = [
                  ['issueId', f?.['issueId'], s['issueId']],
                  ['archived', f?.['archived'], s['archived']],
                  ['status', f?.['status'], s['status']],
                  ['stoppedAt', f?.['stoppedAt'] ?? null, s['stoppedAt'] ?? null],
                  ['phase', phaseOf(f), phaseOf(s)],
                  ['offer', offerOf(f), offerOf(s)],
                ]
                const df = pairs
                  .filter(([, a, b]) => JSON.stringify(a) !== JSON.stringify(b))
                  .map(([k, a, b]) => `${k}:feed=${JSON.stringify(a)} store=${JSON.stringify(b)}`)
                if (df.length > 0) sessDiffs.push(`${id}:(${df.join(',')})`)
                if (sessDiffs.length >= 12) break
              }
              for (const id of storeSess.keys()) {
                if (!feedSess.has(id)) sessDiffs.push(`${id}:store-only`)
                if (sessDiffs.length >= 14) break
              }
              const { appendFileSync } = await import('node:fs')
              appendFileSync('/tmp/sessdiff.txt', `seed ${seed} step ${step.index}:\n${sessDiffs.join('\n')}\n`)
            }
            if (diff !== null) {
              oracleFailed += 1
            }
            // TEMPORARY diagnosis (removed before landing): plain pool rebuilt
            // from the same feed snapshot — same data, no write layer.
            if (diff !== null && firstDiff === null) {
              const { createReplaySource } = await import('../../../../harness/src/count-harness')
              const { DISABLED_READ_FENCE } = await import('../../../../shared/src/instrument/reads')
              const { mobxPoolArm: plainArm } = await import('../arm')
              const { fixedLocals } = await import('../../../../shared/src/locals-source')
              const replay = createReplaySource({
                issues: run.feed().source.snapshot('issue'),
                sessions: run.feed().source.snapshot('session'),
                worktrees: run.feed().source.snapshot('worktree'),
              })
              const plain = plainArm.create(
                replay.source,
                fixedLocals({
                  selectedIssueId: null,
                  coarseNow: (run.ctx.engine.getSnapshot() as unknown as { coarseNow: number }).coarseNow,
                }).source,
                DISABLED_READ_FENCE,
              )
              const r = plain.snapshot().rowsById['i3150'] as
                | { progressDone?: number; progressTotal?: number }
                | undefined
              const { appendFileSync } = await import('node:fs')
              appendFileSync(
                '/tmp/plain-fresh.txt',
                `seed ${seed} step ${step.index}: plainFresh=${r === undefined ? 'absent' : `${r.progressDone}/${r.progressTotal}`}\n`,
              )
              plain.dispose()
              // TEMPORARY: residency registry state for i3156 (a table(?)
              // cold row): known? coldRow value?
              const { runInAction: ria2 } = await import('mobx')
              const residency = h.pool.residency
              const reg = ria2(() => {
                if (residency === null) return 'no-residency'
                const ke = residency as unknown as {
                  isCold(e: string, id: string): boolean
                }
                const knownCold = ke.isCold('issue', 'i3156')
                const coldVal = h.pool.coldRow('issue', 'i3156') as unknown
                return `isCold=${knownCold} coldRow=${coldVal === undefined ? 'undef' : 'row'}`
              })
              appendFileSync('/tmp/plain-fresh.txt', `residency i3156: ${reg}\n`)
              // TEMPORARY diagnosis (removed before landing): source.row vs
              // snapshot for the cold row the pool cannot materialize.
              const src = run.feed().source
              const byId = src.snapshot('issue').find((r) => r.id === 'i3156')?.value as
                | Record<string, unknown>
                | undefined
              let one: string
              try {
                const v = src.row === undefined ? 'no-row-fn' : src.row('issue', 'i3156')
                one = v === undefined ? 'undef' : String((v as Record<string, unknown>)['stage'])
              } catch (error) {
                one = `throws:${error instanceof Error ? error.message : String(error)}`
              }
              appendFileSync(
                '/tmp/plain-fresh.txt',
                `rowfn i3156: snapshot=${byId === undefined ? 'absent' : String(byId['stage'])} row()=${one}\n`,
              )
            }
            if (diff !== null && firstDiff === null) {
              // TEMPORARY diagnosis (removed before landing): spinOff fields
              // + pool spinOffs size across the closure of the first row.
              const m2 = /row (i[a-zA-Z0-9-]+): progressDone/.exec(diff)
              let extra2 = ''
              if (m2) {
                const target = m2[1] as string
                const feedRows = new Map(
                  run
                    .feed()
                    .source.snapshot('issue')
                    .map((r) => [r.id, r.value as Record<string, unknown> | undefined]),
                )
                const seen = new Set<string>([target])
                const queue = [target]
                const lines: string[] = []
                while (queue.length > 0 && lines.length < 30) {
                  const cur = queue.shift() as string
                  for (const [id, v] of feedRows) {
                    if (v !== undefined && (v['parentId'] as string | null) === cur && !seen.has(id)) {
                      seen.add(id)
                      queue.push(id)
                      const so = runInAction(
                        () => [...h.pool.relations.many('issue', id, 'spinOffs' as never)].length,
                      )
                      lines.push(
                        `${id}:df=${String(v['discoveredFrom'] ?? '-')}/so=${so}/st=${String(v['stage'])}`,
                      )
                    }
                  }
                }
                extra2 = `\nspinOffs:\n${lines.join('\n')}`
                // TEMPORARY diagnosis (removed before landing): seatIds +
                // openOwn per closure row with spinOffs.
                const seatLines: string[] = []
                for (const [id] of feedRows) {
                  const so = runInAction(
                    () => [...h.pool.relations.many('issue', id, 'spinOffs' as never)].length,
                  )
                  if (so === 0) continue
                  const st = runInAction(() => {
                    const n = h.pool.worklist.issue(id) as unknown as
                      | {
                        sessionIds: readonly string[]
                        rollup: { loading: boolean } | undefined
                      }
                      | undefined
                    if (n === undefined) return null
                    const seats = [...n.sessionIds]
                    const open: string[] = []
                    for (const s of seats) {
                      const r = h.pool.worklist.session(s) as unknown as
                        | { retention: { issueId: string | null; archived: boolean; exited: boolean } | null }
                        | undefined
                      const ret = r?.retention ?? null
                      open.push(`${s}:${ret === null ? 'null' : `${String(ret.issueId)}/${ret.archived ? 'A' : 'a'}${ret.exited ? 'E' : 'e'}`}`)
                    }
                    return `seats=[${open.join(',')}]`
                  })
                  seatLines.push(`${id}:so=${so} ${st ?? 'no-node'}`)
                  if (seatLines.length >= 20) break
                }
                extra2 += `\nseats:\n${seatLines.join('\n')}`
              }
              firstDiff =
                `seed ${seed}: step ${step.index} diverged from the write oracle ` +
                `(${JSON.stringify(step.change)}, settled=${settled}):\n${diff}${extra2}`
            }
          },
        })
        if (!result.ok) {
          throw new Error(
            `seed ${seed}: step ${result.step} diverged from the ${result.against}:\n${result.diff}\n` +
              `shrunk (${result.shrunk.length} changes):\n${describeSequence(result.shrunk)}\n` +
              `counts=${JSON.stringify(result.counts)}`,
          )
        }
        if (firstDiff !== null) {
          throw new Error(`${firstDiff}\noracle checks failed ${oracleFailed}/${oracleChecks}`)
        }
        cells.push({
          seed,
          steps: STEPS,
          counts: result.counts,
          gapApplied: gap.applied,
          oracleChecks,
          oracleFailed,
          kernelDiffers,
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
