import { describe, expect, it } from 'vitest'
import { COMMAND_ACTIONS, UI_LOCAL_ACTIONS } from '../../test-support/commands'
import { harness, sessionId, nestedKeys, ATTRIBUTION_FIELDS } from './test-support'
describe('engine action ownership boundary', () => {
  it('keeps command and device-local classifications disjoint', () => {
    expect(new Set([...COMMAND_ACTIONS, ...UI_LOCAL_ACTIONS]).size).toBe(
      COMMAND_ACTIONS.length + UI_LOCAL_ACTIONS.length,
    )
  })
})
describe('engine action ownership boundary', () => {
  it('never accepts client attribution fields in assembled command payloads', async () => {
    const h = harness()
    await h.actions.setPinned('panel', sessionId, true)
    await h.actions.setTabOrder('/worktree', [sessionId])
    await h.actions.renameSession(sessionId, 'new name')
    h.ui.setSuperOpen(true)
    h.layout.clear('superOpen')

    // Per-field, deliberately: `not.toEqual(expect.arrayContaining([...]))`
    // only fails when EVERY listed field is present at once, so the realistic
    // drift — one field leaking into one payload — passes silently (POD-1533).
    for (const { kind, input } of h.queued) {
      const keys = nestedKeys(input)
      for (const field of ATTRIBUTION_FIELDS) {
        expect(keys, `${kind} payload asserts attribution field '${field}'`).not.toContain(field)
      }
    }
  })
})
