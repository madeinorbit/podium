/**
 * THE SIDEBAR'S FOLDS ARE PER-USER STATE, AND THIS IS WHAT HOLDS THEM THERE
 * (POD-407, readiness §3.3 / §3.1.1).
 *
 * `readAt`, snooze, pins, tab order and sidebar layout are the per-user state
 * family: one row per `(userId, entityId)`, replicated, converging across that
 * person's devices. For the sidebar's folds that property is carried entirely by
 * how their key is SPELLED — `Store.uiState` routes by key, and a key the layout
 * vocabulary does not recognise falls to the device-local store instead.
 *
 * That is a silent failure mode: renaming a key keeps the UI working perfectly on
 * the machine in front of you and simply stops the state replicating. No test of
 * the sidebar's BEHAVIOUR can see it, because the behaviour on one device is
 * identical either way. So the assertion has to be made against the routing
 * itself.
 *
 * The test imports the same builders the component calls rather than restating
 * their strings — a test that re-spelled the key would pass while the component
 * used a different one, which is the bug it is here to catch.
 */
import { isLayoutKey, layoutKeyFromLegacy } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { closedFoldKey, snoozedFoldKey } from './fold-keys'

/** Every fold key the worklist writes, under a representative id. The per-issue
 *  row disclosure is NOT among them any more: POD-516 made the worklist flat, so
 *  the group folds are the only foldable things in the column — and round 2 cut
 *  the Proposed section, so there are exactly two. */
const FOLD_KEYS = [
  ['snoozed fold', snoozedFoldKey('proj-podium')],
  ['closed fold', closedFoldKey('proj-podium')],
] as const

describe('sidebar fold state is per-user replicated layout', () => {
  it.each(FOLD_KEYS)('routes the %s to a replicated layout row', (_label, key) => {
    const layoutKey = layoutKeyFromLegacy(key)
    expect(layoutKey).not.toBeNull()
    expect(isLayoutKey(layoutKey as string)).toBe(true)
  })

  it.each(FOLD_KEYS)('files the %s under the sidebar section family', (_label, key) => {
    expect(layoutKeyFromLegacy(key)).toMatch(/^sidebar\.section\./)
  })

  it('does not collide with the reserved sidebar keys', () => {
    // `width` is deliberately device-local (pixel geometry) and `collapsed` is an
    // exact layout key; a fold key must never be mistaken for either.
    const reserved = ['sidebar.collapsed', null]
    for (const [, key] of FOLD_KEYS) {
      expect(reserved).not.toContain(layoutKeyFromLegacy(key))
    }
  })
})
