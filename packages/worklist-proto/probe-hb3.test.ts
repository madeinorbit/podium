// @vitest-environment happy-dom
import { writeFileSync } from 'node:fs'
import { act } from 'react'
import { expect, it } from 'vitest'
import { mountArmForCounts } from './harness/src/count-harness'
import { openFenceFeeds } from './harness/src/fence-scenarios'
import type { CheckableArm } from './shared/src/arm'
import { startScenarioEngine, upsert } from './shared/src/scenarios'
import { handPoolArm, type HandPoolHandle } from './arms/hand/pool/arm'

const arm: CheckableArm = {
  create: (source, locals, reads) =>
    handPoolArm.create(source, locals, reads, { schedule: () => () => {} }),
}

it('probe phase reads', async () => {
  const out: string[] = []
  const ctx = await startScenarioEngine(1)
  const target = ctx.targets.phaseSessionId
  const feeds = openFenceFeeds(ctx, 'overlaid')
  const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
  const handle = mounted.handle as HandPoolHandle
  const pool = handle.pool
  try {
    let rounds = 0
    while (pool.residency?.hasQueued() && rounds < 100) {
      act(() => { pool.drainLoads() })
      rounds += 1
    }
    let holder = ''
    for (const id of pool.worklist.order()) {
      if (pool.visibleInputs.issue(id)?.memberIds.includes(target)) { holder = id; break }
    }
    const row = pool.visibleInputs.issueRow(holder) as any
    out.push(`holder=${holder} draft=${row?.draft} title=${JSON.stringify(row?.title)} stage=${row?.stage}`)
    out.push(`memberIds=${pool.visibleInputs.issue(holder)?.memberIds.join(',')}`)
    out.push(`seatIds=${pool.visibleInputs.issue(holder)?.seatIds.join(',')}`)
    for (const id of pool.worklist.order()) pool.view(id)
    const before = { ...pool.stats.counters }
    mounted.reads.reset()
    const current = ctx.cache.read('session', target)?.value as any
    upsert(ctx, 'session', target, { ...current, agentState: { phase: 'idle', since: ctx.stamp() }, lastActiveAt: ctx.stamp() })
    await new Promise((r) => setTimeout(r, ctx.settleMs))
    feeds.flush()
    await act(async () => {})
    const stats = mounted.reads.stats()
    out.push(`reads rows=${stats.rows} byEntity=${JSON.stringify(stats.byEntity)} accesses=${JSON.stringify(stats.accesses)}`)
    const after = { ...pool.stats.counters }
    out.push(`tableWrites=${after.tableWrites - before.tableWrites} cellRuns=${after.cellRuns - before.cellRuns} cellsChanged=${after.cellsChanged - before.cellsChanged}`)
    writeFileSync('/tmp/probe-hb3-out.txt', out.join('\n'))
    expect(true).toBe(true)
  } finally {
    mounted.unmount()
    feeds.dispose()
    ctx.engine.destroy()
  }
}, 300000)
