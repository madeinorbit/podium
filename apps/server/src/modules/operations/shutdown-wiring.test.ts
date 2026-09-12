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

/**
 * The OTHER close path. `failListen` closes the store on a listen failure — a
 * port-in-use start, which is the routine outcome with a stale backend on
 * :18787 — and boot adoption has already run by then, so this server may hold
 * armed deadlines and drives in flight over the database it is about to close.
 * It called neither `stop()` nor anything that reached it (POD-2148).
 */
const failListenBody = (): string => {
  const source = serverSource()
  const start = source.indexOf('const failListen =')
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf('\n    }\n', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('operation timers in the shutdown path', () => {
  it('are stopped, by name, in the persist list', () => {
    expect(serverSource()).toContain('operations.stopTimers')
  })

  it('are stopped BEFORE the store closes', () => {
    const source = serverSource()
    // THE SHAPE CHANGED, THE PROPERTY DID NOT (ce4635f3). The persist list used
    // to END with a `['store.close', ...]` step, so "before the store closes"
    // was a question about this list's ORDER. The store owns the drain now —
    // `drainStore` IS `store.close(persist)`, and it runs the whole list from
    // INSIDE the close it is performing — so every step runs while the database
    // is still open, and the timers are disarmed before it shuts. Position in
    // the list no longer decides it; being in the list at all does.
    expect(source).toContain('drainStore: (persist) => store.close(persist)')
    // MATCH THE STEP, NOT ONE FORMATTING OF IT. A persist step is `['name', fn]`,
    // and an entry wraps its bracket onto its own line as soon as the body grows
    // — which `operations.stopTimers` has done. Scraping for the adjacent
    // `['name'` spelling made this assertion a test of the formatter. The
    // trailing comma is what separates a step from a mention in prose: the
    // comment below the list names `'store.close'` precisely to say it is gone.
    const persistStep = (name: string) => new RegExp(`\\[\\s*'${name.replaceAll('.', '\\.')}'\\s*,`)
    expect(source).toMatch(persistStep('operations.stopTimers'))
    // AND THE OLD STEP MUST NOT COME BACK. Holding both spellings at once is
    // what deadlocked shutdown: the last persist step re-entered the close it
    // was running inside and awaited a drain that could never finish. Neither
    // side's tests could see it, because the defect exists only in the pair.
    expect(source).not.toMatch(persistStep('store.close'))
  })

  it('are stopped through the module seam, not a captured local', () => {
    // A local reference would silently keep pointing at a replaced engine.
    expect(serverSource()).toContain('registry.modules.operations.engine.stop()')
  })
})

describe('the listen-failure close path (POD-2148)', () => {
  it('stops the engine', () => {
    expect(failListenBody()).toContain('registry.modules.operations.engine.stop()')
  })

  it('stops it BEFORE closing the store', () => {
    const body = failListenBody()
    const stop = body.indexOf('registry.modules.operations.engine.stop()')
    const close = body.indexOf('store.close()')
    expect(stop).toBeGreaterThan(-1)
    expect(close).toBeGreaterThan(-1)
    expect(stop).toBeLessThan(close)
  })
})

describe('boot adoption runs before the server binds (POD-2147)', () => {
  it('is awaited ahead of the listen', () => {
    // WHY THIS IS THE ONLY CLAIM LEFT HERE. `startServer` awaits adoption
    // before `serveNative`, so a rejection there is a server that does not boot
    // — on the machine whose updater is the broken thing. That is fixed in the
    // ENGINE, which contains every throw and resolves regardless, and it is
    // tested as behaviour in `engine.test.ts` rather than as a shape here: a
    // source scrape for a `.catch(` could only ever assert the presence of one
    // spelling of the guard, and would fail on a reformat that changed nothing.
    // What a unit test structurally cannot see is the ORDER, so that is what
    // this file keeps.
    const source = serverSource()
    const adopt = source.indexOf('.adoptOnBoot(')
    const listen = source.indexOf('serveNative({')
    expect(adopt).toBeGreaterThan(-1)
    expect(listen).toBeGreaterThan(-1)
    expect(adopt).toBeLessThan(listen)
  })
})
