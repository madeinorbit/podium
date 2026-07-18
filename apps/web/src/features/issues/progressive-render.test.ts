import { describe, expect, it } from 'vitest'
import {
  ISSUE_RENDER_CHUNK,
  nextProgressiveRenderLimit,
  progressiveRenderLimit,
} from './progressive-render'

describe('progressiveRenderLimit', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `issue-${i}`)

  it('bounds an ordinary large group to the revealed prefix', () => {
    expect(progressiveRenderLimit(ids, ISSUE_RENDER_CHUNK, new Set())).toBe(ISSUE_RENDER_CHUNK)
  })

  it('reveals the prefix through focused or selected issues', () => {
    expect(progressiveRenderLimit(ids, ISSUE_RENDER_CHUNK, new Set(['issue-64']))).toBe(65)
    expect(progressiveRenderLimit(ids, ISSUE_RENDER_CHUNK, new Set(['issue-2', 'issue-79']))).toBe(
      80,
    )
  })

  it('clamps stale revealed state to a filtered group', () => {
    expect(progressiveRenderLimit(ids.slice(0, 7), 80, new Set())).toBe(7)
  })
})

describe('nextProgressiveRenderLimit', () => {
  it('advances by one chunk and clamps at the total', () => {
    expect(nextProgressiveRenderLimit(ISSUE_RENDER_CHUNK, 100)).toBe(80)
    expect(nextProgressiveRenderLimit(80, 100)).toBe(100)
  })
})
