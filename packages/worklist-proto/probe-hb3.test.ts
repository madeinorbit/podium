// @vitest-environment happy-dom
import { writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { gen } from './shared/src/gen/changes'
import { startGenRun } from './shared/src/gen/run'
import { diffSnapshots } from './shared/src/gen/check'
import { createEngineLocals } from './harness/src/engine-locals'
import { handPoolArm, type HandPoolHandle } from './arms/hand/pool/arm'

it('replay seed 1 to step 112', async () => {
  const out: string[] = []
  const sequence = gen(1, 200)
  out.push(`change at 112: ${JSON.stringify(sequence[112])?.slice(0, 400)}`)
  const run = await startGenRun({ feedMode: 'overlaid' })
  let feed = run.feed()
  let locals = createEngineLocals(run.ctx.engine)
  let handle = handPoolArm.create(feed.source, locals.source) as HandPoolHandle
  try {
    for (let index = 0; index <= 112; index++) {
      const step = await run.apply(sequence[index]!)
      if (run.feed() !== feed) {
        handle.dispose()
        locals.dispose()
        feed = run.feed()
        locals = createEngineLocals(run.ctx.engine)
        handle = handPoolArm.create(feed.source, locals.source) as HandPoolHandle
        out.push(`reloaded at ${index}`)
      }
      void step
      locals.flush()
    }
    const pool = handle.pool
    const actual = handle.snapshot()
    const rebuilt = handle.rebuildFromScratch()
    out.push(`diff: ${diffSnapshots(actual, rebuilt)?.split('\n').slice(0, 8).join(' | ')}`)
    const actualIds = new Set(Object.keys(actual.rowsById))
    for (const id of Object.keys(rebuilt.rowsById)) {
      if (actualIds.has(id)) continue
      const inTables = pool.tables.issue.has(id)
      const cold = pool.residency?.isCold('issue', id) ?? false
      const holder = pool.worklist.peekIssue(id) !== undefined
      const inOrder = pool.worklist.has(id)
      const view = pool.view(id)
      const placement = pool.groups.placement(id)
      out.push(`${id}: tables=${inTables} cold=${cold} holder=${holder} order=${inOrder} view=${view === undefined ? 'undef' : `${view.phase}/${view.asking}`} placement=${placement === undefined ? 'undef' : `${placement.closed}`}`)
    }
    writeFileSync('/tmp/probe-hb3-out.txt', out.join('\n'))
    expect(true).toBe(true)
  } finally {
    handle.dispose()
    locals.dispose()
    run.dispose()
  }
}, 900000)
