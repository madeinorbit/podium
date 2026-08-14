import { describe, expect, it } from 'vitest'
import {
  advanceLaneHistory,
  EMPTY_LANE_HISTORY,
  formatReleasedAgo,
  RELEASED_LANE_TTL_MS,
} from './released-lanes'

const T0 = Date.parse('2026-08-06T12:00:00.000Z')

describe('advanceLaneHistory', () => {
  it('remembers a lane only once it has been seen and then lost', () => {
    // The first reading is not evidence that anything was released — the client
    // had nothing to compare against.
    const first = advanceLaneHistory(EMPTY_LANE_HISTORY, ['test:heavy'], T0)
    expect(first.released).toEqual([])
    expect(first.held).toEqual(['test:heavy'])

    const gone = advanceLaneHistory(first, [], T0 + 1_000)
    expect(gone.released).toEqual([{ name: 'test:heavy', kind: 'heavy', releasedAt: T0 + 1_000 }])
  })

  it('classifies a released lane by its name, so the tail keeps the vocabulary', () => {
    const seen = advanceLaneHistory(EMPTY_LANE_HISTORY, ['merge:next', 'migrations'], T0)
    const gone = advanceLaneHistory(seen, [], T0 + 1_000)
    expect(gone.released.map((lane) => [lane.name, lane.kind])).toEqual([
      ['merge:next', 'merge'],
      ['migrations', 'other'],
    ])
  })

  it('newest first, so the tail reads as history', () => {
    let history = advanceLaneHistory(EMPTY_LANE_HISTORY, ['a', 'b'], T0)
    history = advanceLaneHistory(history, ['b'], T0 + 1_000)
    history = advanceLaneHistory(history, [], T0 + 2_000)
    expect(history.released.map((lane) => lane.name)).toEqual(['b', 'a'])
  })

  it('drops a lane from the tail when it is held again', () => {
    let history = advanceLaneHistory(EMPTY_LANE_HISTORY, ['migrations'], T0)
    history = advanceLaneHistory(history, [], T0 + 1_000)
    expect(history.released).toHaveLength(1)

    history = advanceLaneHistory(history, ['migrations'], T0 + 2_000)
    // Live and history at once would state the same lane twice.
    expect(history.released).toEqual([])
    expect(history.held).toEqual(['migrations'])
  })

  it('ages entries out at the ttl', () => {
    let history = advanceLaneHistory(EMPTY_LANE_HISTORY, ['migrations'], T0)
    history = advanceLaneHistory(history, [], T0 + 1_000)

    const justInside = advanceLaneHistory(history, [], T0 + RELEASED_LANE_TTL_MS)
    expect(justInside.released).toHaveLength(1)

    // The ttl is the lifetime, so the entry is gone the moment it is reached.
    const expired = advanceLaneHistory(history, [], T0 + 1_000 + RELEASED_LANE_TTL_MS)
    expect(expired.released).toEqual([])
  })

  it('returns the same object when a reading moves nothing', () => {
    // This runs on every poll; a fresh object each time re-renders the panel
    // once a second for no reason.
    const history = advanceLaneHistory(EMPTY_LANE_HISTORY, ['b', 'a'], T0)
    expect(advanceLaneHistory(history, ['a', 'b'], T0 + 1_000)).toBe(history)
  })
})

describe('formatReleasedAgo', () => {
  it('is coarse and past tense', () => {
    expect(formatReleasedAgo(0)).toBe('just now')
    expect(formatReleasedAgo(59_000)).toBe('just now')
    expect(formatReleasedAgo(60_000)).toBe('1m ago')
    expect(formatReleasedAgo(22 * 60_000)).toBe('22m ago')
  })
})
