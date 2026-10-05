import { autorun, runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { insideReader, measureWork } from '../../worklist-proto/harness/src/work-meter'
import { chatRepositoryKey } from './chat-context'
import { headerIds } from './enumerate'
import type { HeaderRows } from './header-schema'
import { MobxPool } from './pool'

const repo = (path: string, branch = 'main') =>
  ({ path, branch, worktrees: [] }) as HeaderRows['repository']

it('answers the path-change key without repository reads at 1x/4x and ignores metadata or atomic moves', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const rows = Array.from({ length: 128 * scale }, (_, index) => repo(`/repo/${index}`))
    pool.header.apply(rows.map((value, index) => ({ kind: 'repository', id: `r${index}`, value })))
    const measure = (action: () => void) =>
      measureWork(async () => insideReader('chat repository path key', () => runInAction(action)), {
        pool,
      })
    let key = '',
      paints = 0,
      stop = () => {}
    try {
      const first = await measure(() => {
        stop = autorun(() => {
          key = chatRepositoryKey(pool)
          paints++
        })
      })
      expect(key).toBe('1')
      const repeated = await measure(() => {
        expect(chatRepositoryKey(pool)).toBe('1')
      })
      const before = paints
      const metadata = await measure(() =>
        pool.header.apply([
          { kind: 'repository', id: 'r2', value: { ...rows[2]!, branch: 'other' } },
        ]),
      )
      expect(paints).toBe(before)
      const path = await measure(() =>
        pool.header.apply([{ kind: 'repository', id: 'r0', value: repo('/changed') }]),
      )
      expect(key).toBe('2')
      expect(paints).toBe(before + 1)
      const move = await measure(() =>
        pool.header.apply([
          { kind: 'repository', id: 'r0', value: undefined },
          { kind: 'repository', id: 'new-r0', value: repo('/changed') },
        ]),
      )
      expect(key).toBe('2')
      const repeatedId = await measure(() =>
        pool.header.apply([
          { kind: 'repository', id: 'new-r0', value: repo('/temporary') },
          { kind: 'repository', id: 'new-r0', value: repo('/changed') },
        ]),
      )
      expect(key).toBe('2')
      const remove = await measure(() =>
        pool.header.apply([{ kind: 'repository', id: 'new-r0', value: undefined }]),
      )
      expect(key).toBe('3')
      const restore = await measure(() =>
        pool.header.apply([{ kind: 'repository', id: 'new-r0', value: repo('/changed') }]),
      )
      expect(key).toBe('4')
      stop()
      const closed = await measure(() =>
        pool.header.apply([{ kind: 'repository', id: 'new-r0', value: repo('/while-closed') }]),
      )
      const reopen = await measure(() => {
        expect(chatRepositoryKey(pool)).toBe('5')
      })
      const control = await measure(() => {
        const old = headerIds(pool, 'repository')
          .flatMap((id) => {
            const row = pool.headerViews.row('repository', id)
            return row ? [row.path] : []
          })
          .sort()
          .join('\n')
        expect(old).toContain('/while-closed')
      })
      const actions = {
        first,
        repeated,
        metadata,
        path,
        move,
        repeatedId,
        remove,
        restore,
        closed,
        reopen,
      }
      for (const result of Object.values(actions)) expect(result.work.rows).toBe(0)
      expect(control.work.rows).toBe(128 * scale)
      samples.push({ scale, actions, control })
      const beforeOrder = chatRepositoryKey(pool)
      runInAction(() =>
        pool.header.order('repository', rows.map((_, index) => `r${index}`).reverse()),
      )
      expect(chatRepositoryKey(pool)).toBe(beforeOrder)
      runInAction(() => pool.header.clear())
      expect(chatRepositoryKey(pool)).not.toBe(beforeOrder)
      const empty = chatRepositoryKey(pool)
      runInAction(() => pool.header.clear())
      expect(chatRepositoryKey(pool)).toBe(empty)
    } finally {
      stop()
      pool.dispose()
    }
  }
  expect(samples[1]!.actions).toEqual(samples[0]!.actions)
  expect(samples[1]!.control.work.rows).toBe(samples[0]!.control.work.rows! * 4)
  console.log('[chat repository path key work1x4x]', JSON.stringify(samples))
})

it('preserves path multiplicity while allowing duplicate-path identity swaps and empty bootstrap', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  try {
    expect(chatRepositoryKey(pool)).toBe('')
    pool.header.apply([
      { kind: 'repository', id: 'a', value: repo('/same') },
      { kind: 'repository', id: 'b', value: repo('/same') },
    ])
    const two = chatRepositoryKey(pool)
    pool.header.apply([
      { kind: 'repository', id: 'a', value: undefined },
      { kind: 'repository', id: 'c', value: repo('/same') },
    ])
    expect(chatRepositoryKey(pool)).toBe(two)
    pool.header.apply([{ kind: 'repository', id: 'b', value: undefined }])
    expect(chatRepositoryKey(pool)).not.toBe(two)
    const one = chatRepositoryKey(pool)
    pool.header.apply([{ kind: 'repository', id: 'missing', value: undefined }])
    expect(chatRepositoryKey(pool)).toBe(one)
  } finally {
    pool.dispose()
  }
})
