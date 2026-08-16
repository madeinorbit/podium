import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * THE ENGINE'S TIMERS MUST STOP BEFORE THE STORE CLOSES (POD-2136 review).
 *
 * `engine.stop()` disarming its timers is unit-tested next door; what THIS
 * asserts is the thing a unit test structurally cannot see — that the shutdown
 * path actually calls it, and calls it early enough. An armed deadline that
 * outlives the server wakes into a closed database and tries to persist a
 * stall against it.
 *
 * Read from the source rather than by booting a server: the claim is about the
 * ORDER of the persist list, which is a fact about that list, and the
 * alternative (start a real server, kill it, catch the throw) makes a
 * shutdown-ordering regression show up as a flake in an integration lane.
 */

const serverSource = () => readFileSync(join(import.meta.dirname, '../../server.ts'), 'utf8')

describe('operation timers in the shutdown path', () => {
  it('are stopped, by name, in the persist list', () => {
    expect(serverSource()).toContain('operations.stopTimers')
  })

  it('are stopped BEFORE the store closes', () => {
    const source = serverSource()
    const stopTimers = source.indexOf("['operations.stopTimers'")
    const closeStore = source.indexOf("['store.close'")
    expect(stopTimers).toBeGreaterThan(-1)
    expect(closeStore).toBeGreaterThan(-1)
    expect(stopTimers).toBeLessThan(closeStore)
  })

  it('are stopped through the module seam, not a captured local', () => {
    // A local reference would silently keep pointing at a replaced engine.
    expect(serverSource()).toContain('registry.modules.operations.engine.stop()')
  })
})
