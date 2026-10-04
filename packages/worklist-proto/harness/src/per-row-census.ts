/** Counts only: the established read fence and MobX/hand census, on the same
 * kernel-fed synthetic memory cells. No spies or counting proxies in heap captures. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { createRowSource } from '../../shared/src/row-source'
import { autorun } from 'mobx'
import { handPoolArm } from '../../arms/hand/pool/arm'
import { PART_RULES } from '../../arms/hand/pool/views'
import { SESSION_RULES, VISIBLE_RULES } from '../../arms/hand/pool/worklist/visible'
import { LeanPool } from '../../arms/lean/src/pool'
import { createReadFence } from '../../shared/src/instrument/reads'
import {
  startEngineOnCorpus,
  writeBurst50,
  writeHeartbeat,
  writePhaseChange,
  writeTitleRename,
} from '../../shared/src/scenarios'
import { buildCorpus, buildCorpusCell } from './fixture'
import { startHandCensus } from './hand-census'
import { startCensus } from './mobx-census'

const results = []
for (const cell of ['1x', '4x', 'h10a1'])
  for (const arm of ['hand', 'lean']) {
    const corpus =
      cell === 'h10a1'
        ? buildCorpusCell({ history: 10, active: 1 }, 4443)
        : buildCorpus(cell === '4x' ? 4 : 1, 4443)
    const ctx = await startEngineOnCorpus(corpus)
    const feed = createRowSource(ctx.engine, ctx.replica, { mode: 'pooled' })
    const locals = createEngineLocals(ctx.engine)
    const reads = createReadFence({ enabled: true })
    let plainRuleRuns = 0
    let summaryReads = 0
    const restores: (() => void)[] = []
    // Count the plain rule bodies too: a single MobX filing run can hide a full scan.
    for (const rules of [VISIBLE_RULES, SESSION_RULES, PART_RULES]) {
      const host = rules as unknown as Record<string, (...args: unknown[]) => unknown>
      for (const [key, original] of Object.entries(host)) {
        host[key] = (...args) => {
          plainRuleRuns++
          return original(...args)
        }
        restores.push(() => {
          host[key] = original
        })
      }
    }
    const census = arm === 'lean' ? startCensus() : startHandCensus()
    census.enter('startup')
    const source = reads.wrapSource(feed.source)
    const hand =
      arm === 'hand'
        ? handPoolArm.create(source, locals.source, reads, { schedule: () => () => {} })
        : null
    const pool = hand?.pool ?? new LeanPool(source, locals.source, reads, () => () => {})
    const originalSummary = pool.residency!.summary.bind(pool.residency)
    pool.residency!.summary = (...args) => {
      summaryReads++
      return originalSummary(...args)
    }
    census.exit()
    const stops: (() => void)[] = []
    census.enter('window')
    const ids = hand
      ? hand.pool.order().slice(0, 20)
      : (pool as LeanPool).filing.get().order.slice(0, 20)
    if (hand) {
      stops.push(hand.pool.subscribeOrder(() => hand.pool.order()))
      for (const id of ids) {
        hand.pool.view(id)
        stops.push(hand.pool.subscribe(id, () => hand.pool.view(id)))
      }
    } else {
      ;(pool as LeanPool).setWindow(ids)
      stops.push(autorun(() => (pool as LeanPool).filing.get()))
      for (const id of ids) stops.push(autorun(() => (pool as LeanPool).mountRow(id).get()))
    }
    const settle = () => {
      for (let i = 0; pool.residency?.hasQueued(); i++) {
        if (i === 64) throw new Error('Loads did not settle')
        pool.hydrate()
      }
    }
    settle()
    census.exit()
    const startup = {
      rows: Object.fromEntries(
        Object.entries(pool.tables).map(([key, value]) => [key, value.size]),
      ),
      window: ids,
      visibleOrder: hand ? hand.pool.order() : (pool as LeanPool).filing.get().order,
      windowViews: ids.map((id) =>
        hand ? hand.pool.view(id) : (pool as LeanPool).mountRow(id).get(),
      ),
      census: census.snapshot(),
      reads: reads.stats(),
    }
    const changes = []
    for (const [name, write] of [
      ['heartbeat', writeHeartbeat],
      ['phase', writePhaseChange],
      ['rename', writeTitleRename],
      ['burst50', writeBurst50],
    ] as const) {
      reads.reset()
      census.enter(name)
      plainRuleRuns = 0
      summaryReads = 0
      await write(ctx)
      feed.flush()
      locals.flush()
      settle()
      census.exit()
      const read = reads.stats()
      const work = census.snapshot().phases[name]
      changes.push({ name, reads: read, work, plainRuleRuns, summaryReads })
    }
    results.push({ cell, arm, startup, changes })
    for (const stop of stops.reverse()) stop()
    if (hand) hand.dispose()
    else pool.dispose()
    census.stop()
    locals.dispose()
    feed.dispose()
    ctx.engine.destroy()
    for (const restore of restores.reverse()) restore()
    console.log(
      `${cell} ${arm}: ${changes.map((c) => `${c.name}=${c.reads.data} rows`).join(', ')}`,
    )
  }
const out = resolve('.artifacts/pool-memory/per-row-census.json')
mkdirSync(resolve('.artifacts/pool-memory'), { recursive: true })
writeFileSync(
  out,
  JSON.stringify({ synthetic: true, seed: 4443, windowRows: 20, results }, null, 2),
)
