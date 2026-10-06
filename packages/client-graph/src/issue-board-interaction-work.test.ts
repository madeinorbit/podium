import { autorun, observable, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { type BoardOptions, ISSUE_BOARD_SUMMARIES } from './issue-board-schema'
import { createIssueBoardSource } from './issue-board-source'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

const now = Date.parse('2026-10-06T12:00:00Z')
const options: BoardOptions = {
  display: { layout: 'board', ordering: 'priority', showAgentTasks: false },
  filter: {}, expanded: [], isMobile: false,
}

it('keeps broad-search scalar reads and context-menu facts bounded at 1x and 4x', () => {
  const measurements = [1, 4].map(scale => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, {
      load: vi.fn(), summaries: ISSUE_BOARD_SUMMARIES, schedule: () => () => {},
    })
    pool.apply({ type: 'replace', rows: Array.from({ length: 128 * scale }, (_, seq) => {
      const id = `issue-${seq}`
      return { kind: 'issue' as const, id, value: {
        id, seq, title: `Shared task ${seq}`, description: { value: 'Document' },
        stage: 'backlog', priority: 2, type: 'task', labels: [], deps: [], audience: 'human',
        repoPath: '/fixture', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      } }
    }) })
    const source = createIssueBoardSource(pool)
    const needle = observable.box('')
    let board: ReturnType<typeof source.board>
    let summaries = 0
    const read = pool.row.bind(pool)
    const spy = vi.spyOn(pool, 'row').mockImplementation((...args: Parameters<typeof pool.row>) => {
      if (args[0] === 'issue' && args[2] === 'summary-fields') summaries++
      return read(...args)
    })
    const stops = [autorun(() => { board = source.board({ ...options, filter: { text: needle.get() } }) })]
    try {
      summaries = 0
      runInAction(() => needle.set('shared'))
      const search = summaries
      expect(board! && board! !== LOADING && board!.activeIds.length).toBe(128 * scale)
      summaries = 0
      let menu: ReturnType<typeof source.read>
      stops.push(autorun(() => {
        menu = source.read('issueBoardMenu', JSON.stringify({ ids: ['issue-0'], agents: false }))
      }))
      expect(menu!).not.toBe(LOADING)
      const contextMenu = summaries
      console.info('board interaction summary reads', JSON.stringify({ scale, search, contextMenu }))
      return { search, contextMenu }
    } finally {
      for (const stop of stops.reverse()) stop()
      spy.mockRestore()
      source.dispose()
      pool.dispose()
    }
  })
  expect(measurements[0]!.search).toBeLessThanOrEqual(8)
  expect(measurements[0]!.contextMenu).toBeLessThanOrEqual(8)
  expect(measurements[1]).toEqual(measurements[0])
})
