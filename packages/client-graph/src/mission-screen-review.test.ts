import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { MissionScreen, type MissionIssueEvent } from './mission-screen'
import { MobxPool } from './pool'

const stamp = '2026-10-07T12:00:00Z'
const returned = (from: string, to: string): MissionIssueEvent => ({ kind: 'issue.stage_changed', payload: { from, to } })

function pool() {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({ type: 'replace', rows: ['root', 'a'].map((id, index) => ({ kind: 'issue' as const, id, value: {
    id, seq: index + 1, title: id, stage: 'review', audience: 'human', parentId: index ? 'root' : null,
    deps: [], repoPath: '/synthetic', createdAt: stamp, updatedAt: stamp,
  } })) })
  return pool
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { for (let turn = 0; turn < 5; turn++) await Promise.resolve() }

it('loads a review-return count on request, with a loading field and the answer', async () => {
  const p = pool()
  const answer = deferred<readonly MissionIssueEvent[]>()
  const load = vi.fn(() => answer.promise)
  const screen = new MissionScreen(p, 'root', { issueEvents: load })
  screen.open()
  try {
    const seen: unknown[] = []
    const stop = autorun(() => {
      const value = screen.reviewReturn(p.issueObject('a'))
      seen.push({ loading: value.loading, count: value.count, error: value.error })
    })
    screen.requestReviewReturns('a')
    screen.requestReviewReturns('a')
    expect(load).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledWith({ since: 0, repoPath: '/synthetic', subject: 'a', limit: 200 })
    expect(seen.at(-1)).toEqual({ loading: true, count: undefined, error: null })
    answer.resolve([returned('review', 'in_progress'), returned('review', 'planning'), returned('backlog', 'review')])
    await flush()
    expect(seen.at(-1)).toEqual({ loading: false, count: 2, error: null })
    stop()
  } finally { screen.close(); p.dispose() }
})

it('shows a failed read as an error, never as zero', async () => {
  const p = pool()
  const screen = new MissionScreen(p, 'root', { issueEvents: () => Promise.reject(new Error('history offline')) })
  screen.open()
  try {
    screen.requestReviewReturns('a')
    await flush()
    const value = screen.reviewReturn(p.issueObject('a'))
    expect(value.loading).toBe(false)
    expect(value.error).toBe('history offline')
    expect(value.count).toBeUndefined()
  } finally { screen.close(); p.dispose() }
})

it('a newer version supersedes an older answer, and a closed opening stores nothing', async () => {
  const p = pool()
  const first = deferred<readonly MissionIssueEvent[]>(), second = deferred<readonly MissionIssueEvent[]>()
  const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const screen = new MissionScreen(p, 'root', { issueEvents: load })
  screen.open()
  try {
    screen.requestReviewReturns('a')
    runInAction(() => p.apply({ type: 'update', rows: [{ kind: 'issue', id: 'a', value: {
      id: 'a', seq: 2, title: 'a', stage: 'review', audience: 'human', parentId: 'root', deps: [],
      repoPath: '/synthetic', createdAt: stamp, updatedAt: '2026-10-07T12:05:00Z',
    } }] }))
    screen.requestReviewReturns('a')
    expect(load).toHaveBeenCalledTimes(2)
    second.resolve([returned('review', 'planning')])
    await flush()
    first.resolve([returned('review', 'planning'), returned('review', 'planning'), returned('review', 'planning')])
    await flush()
    // The superseded response does not overwrite the current version's count.
    expect(screen.reviewReturn(p.issueObject('a')).count).toBe(1)
    // Closing ends the opening: a late answer is dropped, a request is refused.
    const late = deferred<readonly MissionIssueEvent[]>()
    const other = new MissionScreen(p, 'root', { issueEvents: () => late.promise })
    other.open()
    other.requestReviewReturns('a')
    other.close()
    late.resolve([returned('review', 'planning')])
    await flush()
    expect(other.reviewReturn(p.issueObject('a')).count).toBeUndefined()
  } finally { screen.close(); p.dispose() }
})

it('keeps answers per opening: a new opening asks again instead of reading a module cache', async () => {
  const p = pool()
  const load = vi.fn(async () => [returned('review', 'planning'), returned('review', 'planning')])
  try {
    for (let opening = 0; opening < 2; opening++) {
      const screen = new MissionScreen(p, 'root', { issueEvents: load })
      screen.open()
      screen.requestReviewReturns('a')
      await flush()
      expect(screen.reviewReturn(p.issueObject('a')).count).toBe(2)
      screen.close()
    }
    expect(load).toHaveBeenCalledTimes(2)
  } finally { p.dispose() }
})


it('fences a response across close and reopen, and requests the unchanged version again', async () => {
  const p = pool()
  const old = deferred<readonly MissionIssueEvent[]>(), next = deferred<readonly MissionIssueEvent[]>()
  const load = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
  const screen = new MissionScreen(p, 'root', { issueEvents: load })
  try {
    screen.open()
    screen.requestReviewReturns('a')
    screen.close()
    screen.open()
    old.resolve([returned('review', 'planning'), returned('review', 'planning')])
    await flush()
    expect(screen.reviewReturn(p.issueObject('a')).count).toBeUndefined()
    screen.requestReviewReturns('a')
    expect(load).toHaveBeenCalledTimes(2)
    next.resolve([returned('review', 'planning')])
    await flush()
    expect(screen.reviewReturn(p.issueObject('a')).count).toBe(1)
    expect(screen.reviewReturn(p.issueObject('a')).loading).toBe(false)
  } finally { screen.close(); p.dispose() }
})
