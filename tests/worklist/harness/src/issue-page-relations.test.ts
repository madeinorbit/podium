import { omitGone } from '@podium/client-graph/lookup'
import { describe, expect, it } from 'vitest'
import { reaction, runInAction } from 'mobx'
import { MobxPool } from '@podium/client-graph/pool'
import { attachIssuePageSource } from '@podium/client-graph/issue-page-source'
import { LOADING } from '@podium/client-graph'
import type { ReplicaAddressedBatch } from '@podium/client-core/replica'
import { tracked } from './adapters/mobx-pool'
import { installMobxWarnTrap } from './mobx-trap'

installMobxWarnTrap({ errors: true })
const STAMP = '2026-09-01T12:00:00Z'

describe('issue page exit evidence', () => {
  it('borrows exit evidence through the one reader, reacts to rescope and disposes the subscription once', () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(STAMP) })
    let receive: (batch: ReplicaAddressedBatch) => void = () => {}
    let kind: 'evicted' | 'removed' | undefined = 'evicted', stops = 0
    const replica = {
      exitKind: (entity: string, id: string) => entity === 'issueProjection' && id === 'opaque' ? kind : undefined,
      subscribeAddressedBatch: (listener: typeof receive) => { receive = listener; return () => { stops++ } },
    }
    const stop = attachIssuePageSource(pool, { replica } as Parameters<typeof attachIssuePageSource>[1])
    const states: unknown[] = []
    const unobserve = reaction(() => omitGone(pool.row('issueExit', 'opaque')), next => states.push(next), { fireImmediately: true })
    try {
      expect(tracked(() => omitGone(pool.row('issueExit', 'opaque')))).toEqual({ kind: 'evicted' })
      kind = 'removed'; receive({ type: 'replace', reason: 'rescope' })
      expect(tracked(() => omitGone(pool.row('issueExit', 'opaque')))).toEqual({ kind: 'removed' })
      kind = undefined; receive({ type: 'replace', reason: 'rescope' })
      expect(tracked(() => omitGone(pool.row('issueExit', 'opaque')))).toEqual({ kind: undefined })
      expect(states).toEqual([{ kind: 'evicted' }, { kind: 'removed' }, { kind: undefined }])
      unobserve()
      stop(); stop(); pool.dispose()
      expect(stops).toBe(1)
      expect(runInAction(() => omitGone(pool.row('issueExit', 'opaque')))).toBe(LOADING)
    } finally { unobserve(); pool.dispose() }
  })
})
