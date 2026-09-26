// @vitest-environment happy-dom
/** SCRATCH (POD-4705): count CaughtException in v8 heap at bootstrap stages. DELETE BEFORE LANDING. */
import { getHeapSnapshot } from 'node:v8'
import { writeFileSync } from 'node:fs'
import { onReactionError } from 'mobx'
import { describe, expect, it } from 'vitest'
import { createReplaySource, mountArmForCounts } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { openFenceFeeds } from '../../../harness/src/fence-scenarios'
import { startScenarioEngine } from '../../../shared/src/scenarios'
import type { CheckableArm } from '../../../shared/src/arm'
import { mobxPoolArm, type MobxPoolHandle } from './arm'
import { tracked } from './pool'

function countCaught(out: string): number {
  const matches = out.match(/CaughtException/g)
  return matches === null ? 0 : matches.length
}

describe('caught hunt', () => {
  it('counts across stages', async () => {
    const lines: string[] = []
    const errors: unknown[] = []
    const off = onReactionError((error) => {
      errors.push(error)
    })
    try {
      const ctx = await startScenarioEngine(1)
      try {
        const feeds = openFenceFeeds(ctx, 'overlaid')
        try {
          const arm: CheckableArm = {
            create: (source, locals, reads) =>
              mobxPoolArm.create(source, locals, reads, { schedule: () => () => {} }),
          }
          const snapOf = async (): Promise<number> => {
            const snap = getHeapSnapshot()
            const chunks: Buffer[] = []
            for await (const chunk of snap as unknown as AsyncIterable<Buffer>) chunks.push(chunk)
            return countCaught(Buffer.concat(chunks).toString('utf8'))
          }
          lines.push(`before mount: ${await snapOf()}`)
          const m = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
          lines.push(`after mount: ${await snapOf()}`)
          const { pool } = m.handle as MobxPoolHandle
          ;(m.handle as MobxPoolHandle).snapshot()
          lines.push(`after snapshot: ${await snapOf()}`)
          let windows = 0
          while (pool.residency?.hasQueued() && windows < 100) {
            pool.hydrate()
            windows += 1
          }
          ;(m.handle as MobxPoolHandle).snapshot()
          lines.push(`after settle (${windows} windows): ${await snapOf()}`)
          lines.push(`reaction errors so far: ${errors.length}`)
          if (errors.length > 0) {
            const first = errors[0]
            lines.push(
              `first reaction error: ${first instanceof Error ? first.message : String(first)}`,
            )
            const stackLines = first instanceof Error ? (first.stack ?? '').split('\n').slice(0, 12) : []
            lines.push(`stack: ${stackLines.join('\n')}`)
          }
          m.unmount()
          lines.push(`after unmount: ${await snapOf()}`)
        } finally {
          feeds.dispose()
        }
      } finally {
        ctx.engine.destroy()
      }
    } finally {
      off()
    }
    writeFileSync('/tmp/opencode/throw-hunt2.txt', lines.join('\n'))
    expect(true).toBe(true)
  }, 900_000)
})
