/**
 * Price the installed virtualizer's count-change cache in Chromium, using
 * the actual pool's 1x/4x lanes. This is isolated from the arm timing bundle.
 * Counters are outside the product: stable key/size callbacks count the
 * indexes the dependency recomputes; the fixed window returns only its draw.
 */
import { Virtualizer, elementScroll, observeElementOffset, observeElementRect } from '@tanstack/react-virtual'
import { harnessMobxPoolArm, tracked } from '../src/adapters/mobx-pool'
import { createEngineLocals } from '../src/engine-locals'
import { createRowSource } from '../../shared/src/row-source'
import { startScenarioEngine, writeNewIssue } from '../../shared/src/scenarios'
import { WindowPlan } from '../../arms/mobx/pool/react/list'
import type { WorklistGroups } from '@podium/client-graph/worklist/groups'
import { pageEngineOptions } from '../web/entrylib'

interface Sample { ms: number | undefined; keyCalls: number; sizeCalls: number; count: number }
const require = (ok: boolean, message: string): void => { if (!ok) throw new Error(message) }
const summary = (samples: Sample[]) => {
  const sorted = samples.flatMap((sample) => sample.ms === undefined ? [] : [sample.ms]).sort((a, b) => a - b)
  return {
    samples: samples.length,
    ...(sorted.length === 0 ? {} : {
      medianMs: sorted[Math.floor(sorted.length / 2)],
      p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    }),
    minCount: Math.min(...samples.map((sample) => sample.count)),
    maxCount: Math.max(...samples.map((sample) => sample.count)),
    minKeyCalls: Math.min(...samples.map((sample) => sample.keyCalls)),
    maxKeyCalls: Math.max(...samples.map((sample) => sample.keyCalls)),
    minSizeCalls: Math.min(...samples.map((sample) => sample.sizeCalls)),
    maxSizeCalls: Math.max(...samples.map((sample) => sample.sizeCalls)),
  }
}

async function run(): Promise<object> {
  const params = new URLSearchParams(location.search)
  const scale = Number(params.get('scale')) as 1 | 4
  const countsOnly = params.has('counts-only')
  require(scale === 1 || scale === 4, 'scale must be 1 or 4')
  const ctx = await startScenarioEngine(scale, pageEngineOptions())
  const source = createRowSource(ctx.engine, ctx.replica, { mode: 'pooled' })
  const locals = createEngineLocals(ctx.engine)
  const handle = harnessMobxPoolArm.create(source.source, locals.source, undefined, { schedule: () => () => {} })
  try {
    const capture = (): { plan: WindowPlan; groups: WorklistGroups } => tracked(() => {
      const groups = handle.pool.groups
      const keys = groups.keys
      const pinnedIds = groups.pinnedIds
      const lanes = new Map(keys.map((key) => {
        const group = groups.group(key)
        return [key, { rowIds: group.rowIds, closedIds: group.closedIds }] as const
      }))
      // Immutable lane summaries let samples alternate the actual before
      // and after state without timing an engine write or a pool derivation.
      const stable = { keys, pinnedIds, group: (key: string) => lanes.get(key)! } as unknown as WorklistGroups
      const plan = new WindowPlan()
      plan.update(stable, keys, new Set())
      return { plan, groups: stable }
    })
    const before = capture()
    const visibleRows = before.plan.count - before.plan.segments.filter((segment) => segment.lane.title !== null).length
    require(visibleRows === 732 * scale, `wrong corpus: ${visibleRows}`)
    await writeNewIssue(ctx)
    source.flush()
    locals.flush()
    const after = capture()
    require(after.plan.count === before.plan.count + 1, 'new issue must grow the window by one row')
    let activePlan = before.plan
    let keyCalls = 0, sizeCalls = 0
    const getItemKey = (index: number): string => { keyCalls += 1; return activePlan.getItemKey(index) }
    const estimateSize = (index: number): number => { sizeCalls += 1; return activePlan.estimateSize(index) }
    const options = (count: number) => ({ count, getItemKey, estimateSize,
      getScrollElement: () => document.body, scrollToFn: elementScroll,
      observeElementOffset, observeElementRect })
    const virtualizer = new Virtualizer(options(activePlan.count))
    virtualizer.getTotalSize()
    const cache: Sample[] = [], fixed: Sample[] = []
    const stablePlan = new WindowPlan()
    let fixedKeyCalls = 0, fixedSizeCalls = 0
    const fixedKey = stablePlan.getItemKey, fixedSize = stablePlan.estimateSize
    Object.defineProperty(stablePlan, 'getItemKey', {
      value: (index: number): string => { fixedKeyCalls += 1; return fixedKey(index) },
    })
    Object.defineProperty(stablePlan, 'estimateSize', {
      value: (index: number): number => { fixedSizeCalls += 1; return fixedSize(index) },
    })
    for (let sample = 0; sample < 120; sample += 1) {
      const current = sample % 2 === 0 ? after : before
      activePlan = current.plan
      keyCalls = 0; sizeCalls = 0
      virtualizer.setOptions(options(activePlan.count))
      const started = countsOnly ? 0 : performance.now()
      const total = virtualizer.getTotalSize()
      const ms = countsOnly ? undefined : performance.now() - started
      require(total === activePlan.height, 'virtualizer total does not match fixed geometry')
      require(keyCalls === activePlan.count && sizeCalls === activePlan.count,
        `measurement counter blind: keys=${keyCalls} sizes=${sizeCalls} count=${activePlan.count}`)
      fixedKeyCalls = 0; fixedSizeCalls = 0
      const fixedStarted = countsOnly ? 0 : performance.now()
      stablePlan.update(current.groups, current.groups.keys, new Set())
      const entries = stablePlan.window(0, 5800)
      const fixedMs = countsOnly ? undefined : performance.now() - fixedStarted
      require(entries.length > 0 && entries.length < Math.ceil(5800 / 40) + 11,
        `fixed window is not bounded: ${entries.length}`)
      require(fixedKeyCalls === entries.length && fixedSizeCalls === entries.length,
        `fixed window walked offscreen indexes: keys=${fixedKeyCalls} sizes=${fixedSizeCalls} drawn=${entries.length}`)
      // Discard JIT warm-up; both alternatives use the same key/size lookup.
      if (sample >= 20) {
        cache.push({ ms, keyCalls, sizeCalls, count: activePlan.count })
        fixed.push({ ms: fixedMs, keyCalls: fixedKeyCalls, sizeCalls: fixedSizeCalls, count: stablePlan.count })
      }
    }
    return { scale, visibleRows, virtualizer: summary(cache), fixedWindow: summary(fixed) }
  } finally {
    handle.dispose(); source.dispose(); locals.dispose(); ctx.engine.destroy()
  }
}

void run().then((result) => {
  ;(window as unknown as { windowCost: object }).windowCost = result
}, (error: unknown) => {
  ;(window as unknown as { windowCost: object }).windowCost = { error: String(error) }
})
