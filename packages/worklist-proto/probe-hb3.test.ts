// @vitest-environment happy-dom
import { writeFileSync } from 'node:fs'
import { act } from 'react'
import { expect, it } from 'vitest'
import { mountArmForCounts, phaseChangeReadBudget } from './harness/src/count-harness'
import { openFenceFeeds, runFenceStep, type FenceScenario } from './harness/src/fence-scenarios'
import type { CheckableArm } from './shared/src/arm'
import { startScenarioEngine, upsert } from './shared/src/scenarios'
import { handPoolArm, type HandPoolHandle } from './arms/hand/pool/arm'
import type { HandPool } from './arms/hand/pool/pool'

const arm: CheckableArm = {
  create: (source, locals, reads) =>
    handPoolArm.create(source, locals, reads, { schedule: () => () => {} }),
}

function findChain(pool: HandPool): { rows: string[]; sessionId: string } {
  for (const id of pool.worklist.order()) {
    const rows = [id]
    let node = pool.visibleInputs.issue(id)
    while (node !== undefined && node.nestParent !== null && rows.length <= 5) {
      if (node.standing?.parentId !== node.nestParent) break
      rows.push(node.nestParent)
      node = pool.visibleInputs.issue(node.nestParent)
    }
    if (rows.length !== 5 || node?.nestParent !== null) continue
    if (node.standing?.parentId !== null) continue
    if (pool.rollup.aggregateOf(rows[4]!)?.finished.waiting) continue
    const bottom = pool.visibleInputs.issue(id)
    const seat = bottom?.memberIds.find((sessionId) => {
      const verdict = pool.rollup.inputs.seat(sessionId)
      return (
        typeof verdict === 'object' && verdict.finished !== 'waiting' && verdict.open !== 'waiting'
      )
    })
    if (seat !== undefined) return { rows, sessionId: seat }
  }
  throw new Error('no chain')
}

it('probe mounted chain', async () => {
  const out: string[] = []
  const ctx = await startScenarioEngine(1)
  const feeds = openFenceFeeds(ctx, 'overlaid')
  const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
  const handle = mounted.handle as HandPoolHandle
  try {
    let rounds = 0
    while (handle.pool.residency?.hasQueued() && rounds < 100) {
      act(() => { handle.pool.drainLoads() })
      rounds += 1
    }
    const chain = findChain(handle.pool)
    out.push(`chain ${chain.rows.join('<')} seat ${chain.sessionId}`)
    mounted.log.reset()
    handle.stats.reset()
    mounted.reads.reset()
    const step = {
      scenario: 'deepSessionQuestion',
      methodology: 'Hb3 depth 4',
      async write() {
        const current = ctx.cache.read('session', chain.sessionId)?.value as object | undefined
        upsert(ctx, 'session', chain.sessionId, { ...current, agentState: { phase: 'idle', idle: { kind: 'question' }, since: ctx.stamp() } })
        await new Promise((resolve) => setTimeout(resolve, ctx.settleMs))
      },
      readsBudget: () => phaseChangeReadBudget(chain.rows.length - 1),
    } satisfies FenceScenario
    const { result } = await runFenceStep(mounted, ctx, feeds.flush, step)
    out.push(`rollupsDerived(handle.stats): ${handle.stats.rollupsDerived}`)
    out.push(`rollupsDerived(result.stats): ${result.stats.rollupsDerived}`)
    out.push(`reads: ${result.readsPerChange} rowsCommitted: ${result.rowsCommitted}`)
    out.push(`oracleChanged: ${result.oracleChangedRows} drawn: ${result.drawnRows}`)
    out.push(`parity: ${result.parity} ${result.parityDiff ?? ''}`)
    writeFileSync('/tmp/probe-hb3-out.txt', out.join('\n'))
    expect(true).toBe(true)
  } finally {
    mounted.unmount()
    feeds.dispose()
    ctx.engine.destroy()
  }
}, 300000)
