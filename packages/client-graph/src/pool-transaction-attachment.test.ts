import { asMutationId } from '@podium/model'
import { autorun, observable, runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { MobxPool, type PoolMutator } from './pool'

function writer() {
  const prompts = observable.map<string, string | null>([['s-1', 'First turn']], { deep: false })
  const refused = observable.set(['issue:i-1'])
  const port: PoolMutator = {
    spawnPrompts: prompts,
    notSaved: (kind, id) => refused.has(`${kind}:${id}`),
    mutate: vi.fn(() => asMutationId('m-1')),
  }
  return { port, prompts, refused }
}

describe('transaction attachment after an initial pool read', () => {
  it('replaces an absent spawn prompt and follows its confirmation', () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const log = writer()
    const seen: unknown[] = []
    const stop = autorun(() => seen.push(pool.spawnPlaceholders()?.get('s-1')))
    try {
      expect(seen).toEqual([undefined])
      pool.attachTransactions(log.port)
      expect(seen).toEqual([undefined, 'First turn'])
      runInAction(() => log.prompts.set('s-1', 'Updated turn'))
      expect(seen.at(-1)).toBe('Updated turn')
      runInAction(() => log.prompts.delete('s-1'))
      expect(seen.at(-1)).toBeUndefined()
    } finally {
      stop()
      pool.dispose()
    }
  })

  it('shows an already refused change when the log attaches and follows its recovery', () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const log = writer()
    const seen: boolean[] = []
    const stop = autorun(() => seen.push(pool.notSaved('issue', 'i-1')))
    try {
      expect(seen).toEqual([false])
      pool.attachTransactions(log.port)
      expect(seen).toEqual([false, true])
      runInAction(() => log.refused.clear())
      expect(seen).toEqual([false, true, false])
    } finally {
      stop()
      pool.dispose()
    }
  })
})
