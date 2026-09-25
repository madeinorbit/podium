// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { runInAction } from 'mobx'
import { mountArmForCounts } from '../../../../harness/src/count-harness'
import { openFenceFeeds } from '../../../../harness/src/fence-scenarios'
import { startScenarioEngine } from '../../../../shared/src/scenarios'
import type { KernelCommand, TxId, WriteTransport } from '../../../../shared/src/write-contract'
import { installMobxWarnTrap } from '../mobx-trap'
import { tracked } from '../pool'
import { writableMobxPoolArm, type WritableMobxPoolHandle } from './arm'

installMobxWarnTrap()

const NEVER_AUTO = { schedule: () => () => {} } as const

function fakeTransport(): WriteTransport & { sent: unknown[] } {
  const sent: unknown[] = []
  return {
    sent,
    send(txId, command) {
      sent.push({ txId, command })
    },
    subscribe() {
      return () => {}
    },
    pending() {
      return []
    },
  }
}

describe('debug i4050 vanishing', () => {
  it('inspects pool state across a mark-read edit', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const arm = writableMobxPoolArm(fakeTransport(), NEVER_AUTO)
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      const handle = mounted.handle as WritableMobxPoolHandle
      const write = handle.write
      const id = 'i4050'
      const { appendFileSync } = await import('node:fs')
      const show = (label: string): void => {
        const snap = handle.snapshot()
        const inSnap = snap.rowsById[id]?.title ?? 'MISSING'
        const rebuilt = handle.rebuildFromScratch().rowsById[id]?.title ?? 'MISSING'
        const [table, node, verdict, inSet, overlay] = runInAction(() => [
          handle.pool.tables.issue.get(id) !== undefined,
          handle.pool.worklist.issue(id),
          handle.pool.worklist.issue(id)?.visible,
          (handle.pool.worklist as unknown as { heldIds(): string[] }).heldIds().includes(id),
          (handle.pool.inputs.issue(id) as unknown as Record<string, unknown> | undefined)?.['readAt'] ?? null,
        ])
        const [issueRowReadAt] = runInAction(() => [
          (
            handle.pool.visibleInputs.issueRow(id) as unknown as Record<string, unknown> | undefined
          )?.['readAt'] ?? null,
        ])
        let freshStanding = 'n/a'
        try {
          const s = tracked(() => {
            const n = handle.pool.worklist.issue(id) as unknown as
              | { standing: Record<string, unknown> | undefined }
              | undefined
            return n?.standing === undefined ? 'none' : JSON.stringify(n.standing)
          })
          freshStanding = s
        } catch {
          freshStanding = 'tracked-threw'
        }
        const [present, placed, flat, unread, standing] = runInAction(() => {
          const n = handle.pool.worklist.issue(id) as unknown as
            | {
              present: boolean
              placed: boolean
              flat: boolean
              unread: boolean
              standing: Record<string, unknown> | undefined
            }
            | undefined
          return [
            n?.present,
            n?.placed,
            n?.flat,
            n?.unread,
            n?.standing === undefined ? 'none' : JSON.stringify(n.standing),
          ]
        })
        appendFileSync(
          '/tmp/i4050.txt',
          `${label}: snap=${inSnap} rebuilt=${rebuilt} table=${table} ` +
            `node=${node === undefined ? 'none' : 'present'} verdict=${verdict} inSet=${inSet} ` +
            `shownReadAt=${JSON.stringify(overlay)} issueRowReadAt=${JSON.stringify(issueRowReadAt)} present=${present} placed=${placed} ` +
            `flat=${flat} unread=${unread} standing=${standing}\n` +
            `   freshStanding=${freshStanding}\n`,
        )
      }
      show('boot')
      const flipsBefore = handle.pool.stats.counters.membershipFlips
      const stamp = new Date(ctx.engine.getSnapshot().coarseNow).toISOString()
      const { act } = await import('react')
      await act(async () => {
        write.edit('issue', id, { readAt: stamp })
      })
      const flipsAfter = handle.pool.stats.counters.membershipFlips
      show('edit')
      appendFileSync('/tmp/i4050.txt', `flips ${flipsBefore} -> ${flipsAfter}\n`)
      expect(true).toBe(true)
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
