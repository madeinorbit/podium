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

/**
 * The Flight Deck and the Task dock must resolve focus against the SAME set, or
 * the two columns disagree about what is being inspected.
 *
 * Two ways they used to diverge, both fixed by resolving against the mission
 * ROOT's unfiltered membership:
 *
 *  - the deck resolved against its MODE-FILTERED rows, so switching to
 *    "Needs you" moved the highlight — and the dock with it — to the root;
 *  - the dock resolved against `selectedIssueId`'s subtree rather than the
 *    mission's, so with a child selected its set was strictly smaller than the
 *    deck's and a focus on a sibling fell back here alone.
 *
 * These cases assert the shared rule directly. The membership itself is
 * `missionIssueIds`, covered in mission.test.ts.
 */
describe('deck / dock focus agreement', () => {
  // root ── c1 ── g1   (only g1 needs you, so "Needs you" renders root+c1+g1)
  //      └─ c2
  const missionMembers = new Set(['root', 'c1', 'c2', 'g1'])
  const needsYouRows = new Set(['root', 'c1', 'g1'])

  it('keeps a focus that a filter has scrolled out of view', () => {
    // c2 is filtered out of the deck. It is still the inspected task.
    expect(resolveFocus('c2', needsYouRows, 'root')).toBe('root')
    expect(resolveFocus('c2', missionMembers, 'root')).toBe('c2')
  })

  it('agrees with itself for every member of the mission, in either column', () => {
    for (const id of missionMembers) {
      const deck = resolveFocus(id, missionMembers, 'root')
      const dock = resolveFocus(id, missionMembers, 'root')
      expect(deck).toBe(dock)
      expect(deck).toBe(id)
    }
  })

  it('agrees on the fallback when the focus belongs to no mission at all', () => {
    expect(resolveFocus('other-mission', missionMembers, 'root')).toBe('root')
  })

  // The dock's own former bug: with a CHILD selected, resolving against that
  // child's subtree loses every sibling the deck still shows.
  it('does not shrink the set when the selection is a child rather than the root', () => {
    const childSubtreeOnly = new Set(['c1', 'g1'])
    expect(resolveFocus('c2', childSubtreeOnly, 'c1')).toBe('c1')
    expect(resolveFocus('c2', missionMembers, 'root')).toBe('c2')
  })
})
