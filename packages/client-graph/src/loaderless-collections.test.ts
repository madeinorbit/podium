import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
import { ISSUE_STUBS, oneRecordOf, stagePage, treeOf } from './collections'
import { fullDevice } from './full-device-fixture'
import { createBoardLayout } from './issue-board-layout'
import { LOADING } from './loading'
import { MobxPool } from './pool'

describe('collection completeness needs device evidence', () => {
  it('a loaderless pool cannot vouch for any collection, even when it has rows', () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'root', value: { id: 'root' } }] })
    try {
      for (const spec of [
        ISSUE_STUBS,
        oneRecordOf('issue', 'root'),
        treeOf('root'),
        stagePage('done'),
      ]) {
        expect(pool.collections.held(spec)).toBe(false)
        expect(pool.collections.complete(spec)).toBe(false)
        expect(pool.collections.status(spec)).toBe('loading')
        expect(pool.collections.pageEnded(spec)).toBe(false)
        expect(pool.collections.pageTotal(spec)).toBe(LOADING)
      }
      expect(pool.collections.available).toBe(false)
      expect(pool.collections.treeHeld('root')).toBe(false)
      expect(pool.collections.treeStatus('root')).toBe('loading')
      expect(pool.collections.stubsComplete).toBe(false)
      expect(pool.collections.someIssue(() => true)).toBe(LOADING)
      expect(pool.collections.countBy('stage')).toBe(LOADING)
      expect(pool.collections.countStubs('all', () => true)).toBe(LOADING)
      expect(pool.collections.childCounts('root')).toBe(LOADING)
      expect(pool.collections.treeProgress('root')).toBe(LOADING)
    } finally {
      pool.dispose()
    }
  })

  it('fullDevice explicitly promises complete fixture data, including empty collections', () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const seen: boolean[] = []
    const stop = autorun(() => seen.push(pool.collections.treeHeld('root')))
    try {
      expect(seen).toEqual([false])
      expect(fullDevice(pool)).toBe(pool)
      expect(seen.at(-1)).toBe(true)
      expect(pool.collections.held(ISSUE_STUBS)).toBe(true)
      expect(pool.collections.status(ISSUE_STUBS)).toBe('complete')
      expect(pool.collections.treeStatus('root')).toBe('complete')
      expect(pool.collections.available).toBe(false)
      expect(pool.queries.issueChildCounts('root')).toEqual({ childCount: 0, childDoneCount: 0 })
      pool.apply({
        type: 'update',
        rows: [
          { kind: 'issue', id: 'child', value: { id: 'child', parentId: 'root', stage: 'done' } },
        ],
      })
      expect(pool.queries.issueChildCounts('root')).toEqual({ childCount: 1, childDoneCount: 1 })
      // No device markers or stubs are invented by this declaration.
      expect(pool.collections.pageTotal(ISSUE_STUBS)).toBe(LOADING)
      expect(pool.collections.treeProgress('root')).toBe(LOADING)
    } finally {
      stop()
      pool.dispose()
    }
  })

  it('disposing a full fixture removes its completeness evidence', () => {
    const pool = fullDevice(new MobxPool({ selectedIssueId: null, coarseNow: 0 }))
    pool.dispose()
    expect(pool.collections.held(ISSUE_STUBS)).toBe(false)
    expect(pool.collections.treeHeld('root')).toBe(false)
    expect(pool.collections.status(ISSUE_STUBS)).toBe('loading')
  })

  it('a board column reads its page instead of assuming a loaderless device is complete', () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const board = createBoardLayout(pool)
    const column = {
      stage: 'done',
      filter: {},
      ordering: 'priority',
      showAgentTasks: false,
    } as const
    try {
      expect(board.columnHeld(column)).toBe(false)
      expect(board.columnCount(column)).toBe(LOADING)
      fullDevice(pool)
      expect(board.columnHeld(column)).toBe(true)
      expect(board.columnCount(column)).toBe(0)
    } finally {
      board.dispose()
      pool.dispose()
    }
  })
})
