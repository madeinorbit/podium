import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
import { oneRecordOf, stagePage, treeOf } from './collections'
import { LOADING } from './loading'
import { NOT_VISIBLE } from './lookup'
import { missionRootId } from './mission-screen'
import { missionView } from './mission-view'
import {
  ISSUE_STUBS,
  REFRESH_SCREENS,
  refreshingScreenFixture,
} from './refreshing-screen.test.fixture'

describe('complete device answers after a gap (POD-7166)', () => {
  it('resolves the phone root before its rich header so the opening can ask for its disk tree', async () => {
    const f = await refreshingScreenFixture()
    try {
      f.without(ISSUE_STUBS)
      f.without(treeOf('root'))
      f.without(treeOf('root', 'stub'))
      expect(missionView(f.pool).issue('root')).toBe(LOADING)
      expect(missionRootId(f.pool, 'root', true)).toBe('root')
    } finally {
      f.dispose()
    }
  })
  it('tracks refreshing then here without an intermediate loading answer, offline too', async () => {
    const f = await refreshingScreenFixture()
    const spec = treeOf('root')
    f.mark(spec)
    const readings: string[] = []
    const stop = autorun(() =>
      readings.push(f.pool.collections.reading(f.pool.collections.treeProgress('root'), [spec])),
    )
    try {
      expect(readings).toEqual(['refreshing'])
      expect(f.pool.collections.childCounts('root')).toEqual({ childCount: 1, childDoneCount: 1 })
      f.land()
      await Promise.resolve()
      expect(readings).toEqual(['refreshing', 'here'])
      expect(f.requested).toEqual([])
    } finally {
      stop()
      f.dispose()
    }
  })

  it('keeps absence and refusal distinct from a stale complete answer', async () => {
    const f = await refreshingScreenFixture()
    try {
      const spec = oneRecordOf('issue', 'missing')
      f.mark(spec)
      f.without(spec)
      expect(f.pool.collections.status(spec)).toBe('offline')
      expect(f.pool.collections.reading(LOADING, [spec])).toBe('offline')
      expect(f.pool.collections.reading(NOT_VISIBLE, [spec])).toBe('gone')
    } finally {
      f.dispose()
    }
  })

  for (const platform of ['web', 'phone'] as const)
    for (const screen of REFRESH_SCREENS)
      it(`${platform} ${screen}: paints its complete answer and ignores an unrelated stale tree`, async () => {
        const f = await refreshingScreenFixture()
        const states: { refreshing: boolean; answer: unknown }[] = []
        f.mark(f.owned[screen])
        const stop = autorun(() =>
          states.push({
            refreshing: f.refreshing(screen, platform),
            answer: f.answer(screen, platform),
          }),
        )
        try {
          expect(states[0]?.refreshing).toBe(true)
          expect(states[0]?.answer).not.toBe(LOADING)
          f.land()
          await Promise.resolve()
          expect(states.at(-1)?.refreshing).toBe(false)
          expect(states.every((state) => state.answer !== LOADING)).toBe(true)
          expect(JSON.stringify(states.at(-1)?.answer)).toContain('Cached root updated')
          const settled = states.length
          f.mark(treeOf('other'))
          await Promise.resolve()
          // Sidebar data also observes firstDownload, which can wake on a
          // marker publication. Its answer and freshness must stay equal;
          // the requirement is screen-local freshness, not zero wakeups.
          expect(states.at(-1)).toEqual(states[settled - 1])
          expect(states.at(-1)?.refreshing).toBe(false)
          expect(f.requested).toEqual([])
        } finally {
          stop()
          f.dispose()
        }
      })

  it('counts complete stale stubs and a paged total, instead of reporting LOADING', async () => {
    const f = await refreshingScreenFixture()
    try {
      f.mark(ISSUE_STUBS)
      expect(f.pool.collections.reading(f.pool.collections.countBy('stage'), [ISSUE_STUBS])).toBe(
        'refreshing',
      )
      expect(f.pool.collections.countBy('stage')).toEqual(
        new Map([
          ['in_progress', 2],
          ['done', 1],
        ]),
      )
      expect(f.pool.collections.treeProgress('root')).toEqual({ total: 1, done: 1 })
      const page = stagePage('done')
      f.mark(page)
      expect(f.pool.collections.pageTotal(page)).toBe(1)
      expect(f.pool.collections.reading(f.pool.collections.pageTotal(page), [page])).toBe(
        'refreshing',
      )
    } finally {
      f.dispose()
    }
  })
})
