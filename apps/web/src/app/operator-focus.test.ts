import { describe, expect, it } from 'vitest'
import { resolveFocus } from './operator-focus'

/**
 * Focus is the operator's pointer INSIDE a mission, and the mission it belongs
 * to can change out from under it — selecting a child of a different mission
 * sets both in one interaction. Resolving (rather than resetting focus when the
 * mission changes) is what keeps "click a task, inspect that task" true across
 * that switch; a reset lands after both writes and hands you back the epic.
 */
describe('resolveFocus', () => {
  const mission = new Set(['root', 'child', 'grandchild'])

  it('keeps a focus that belongs to the mission', () => {
    expect(resolveFocus('child', mission, 'root')).toBe('child')
    expect(resolveFocus('grandchild', mission, 'root')).toBe('grandchild')
    expect(resolveFocus('root', mission, 'root')).toBe('root')
  })

  it('falls back to the root for a focus left over from another mission', () => {
    expect(resolveFocus('stranger', mission, 'root')).toBe('root')
  })

  it('falls back to the root when nothing is focused', () => {
    expect(resolveFocus(null, mission, 'root')).toBe('root')
  })

  it('resolves to nothing when there is no mission to fall back to', () => {
    expect(resolveFocus(null, new Set(), null)).toBeNull()
    expect(resolveFocus('stranger', new Set(), undefined)).toBeNull()
  })

  // The bug this exists to prevent: a mission switch must not silently retarget
  // the inspector at a task the operator did not click.
  it('never invents a focus outside the mission it is resolved against', () => {
    for (const candidate of ['stranger', 'archived', '']) {
      expect(mission.has(resolveFocus(candidate, mission, 'root') as string)).toBe(true)
    }
  })
})
