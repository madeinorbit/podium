import { describe, expect, it } from 'vitest'
import { workSectionWindow } from './work-section-window'

const projects = [
  { key: 'large', ids: Array.from({ length: 200 }, (_, i) => `task-${i}`) },
  { key: 'empty', ids: [] },
  { key: 'next', ids: ['other'] },
]
describe('native Work list window', () => {
  it('bounds row observers and places the load trigger before unreached project headers', () => {
    const first = workSectionWindow(projects, new Set(), false, 120)
    expect(first.sections.map((item) => item.section.key)).toEqual(['large'])
    expect(first.sections.flatMap((item) => item.visible)).toHaveLength(120)
    expect(first.more).toBe(true)
    const next = workSectionWindow(projects, new Set(), false, 240)
    expect(next.sections.map((item) => item.section.key)).toEqual(['large', 'empty', 'next'])
    expect(next.sections.flatMap((item) => item.visible)).toHaveLength(201)
    expect(next.more).toBe(false)
  })
  it('does not spend row slots on a folded project, and opens folds during search', () => {
    const folded = workSectionWindow(projects, new Set(['large']), false, 120)
    expect(folded.sections[0]?.visible).toEqual([])
    expect(folded.sections.at(-1)?.visible).toEqual(['other'])
    expect(folded.more).toBe(false)
    expect(
      workSectionWindow(projects, new Set(['large']), true, 120).sections[0]?.visible,
    ).toHaveLength(120)
  })
})
