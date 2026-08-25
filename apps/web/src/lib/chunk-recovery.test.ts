import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noteActiveUpdate, resetActiveUpdate } from './active-update'
import {
  type ChunkRecoveryDeps,
  chunkUrlFromError,
  classifyChunkFailure,
  importThroughRestarts,
  isWaitingForServer,
  OUTAGE_PATIENCE_MS,
  patienceFor,
  RESTART_PATIENCE_MS,
  resetChunkRecovery,
  retryUrl,
  subscribeWaitingForServer,
} from './chunk-recovery'
import type { ServedAssetsAnswer } from './served-assets'

const CHUNK_URL = 'http://100.113.194.89:32780/assets/SettingsView-WmDcr0IH.js'
const refused = (): Error =>
  new TypeError(`Failed to fetch dynamically imported module: ${CHUNK_URL}`)

beforeEach(() => {
  resetChunkRecovery()
  resetActiveUpdate()
})
afterEach(() => {
  resetChunkRecovery()
  resetActiveUpdate()
})

/**
 * A fake clock that only moves when the code under test waits. Real timers would
 * make the patience budgets untestable — the point of the 20 s and 90 s numbers
 * is that they are long.
 */
function rig(
  answers: Array<ServedAssetsAnswer>,
  importUrl?: (url: string) => Promise<unknown>,
) {
  let clock = 0
  const asked: number[] = []
  const imported: string[] = []
  const stylesheets: string[] = []
  const deps: ChunkRecoveryDeps = {
    askServer: async () => {
      asked.push(clock)
      return answers.length > 1
        ? (answers.shift() as ServedAssetsAnswer)
        : (answers[0] as ServedAssetsAnswer)
    },
    wait: async (ms) => {
      clock += ms
    },
    now: () => clock,
    importUrl: async (url) => {
      imported.push(url)
      if (importUrl) return importUrl(url)
      return { SettingsView: 'the real module' }
    },
    loadStylesheet: async (href) => {
      stylesheets.push(href)
    },
  }
  return { deps, asked, imported, stylesheets, clock: () => clock }
}

describe('chunkUrlFromError', () => {
  /** The sandbox's own message, verbatim — the only place the URL exists. */
  it('reads the URL out of the message every engine puts it in', () => {
    expect(chunkUrlFromError(refused())).toBe(CHUNK_URL)
    expect(
      chunkUrlFromError(new Error(`error loading dynamically imported module: ${CHUNK_URL}`)),
    ).toBe(CHUNK_URL)
  })

  /**
   * CAN SAY NO. A message with no URL in it must answer `undefined` rather than
   * something plausible: the caller uses the answer to decide whether an
   * in-place retry is even possible, and a guessed URL would turn "we cannot fix
   * this here" into a fetch of the wrong thing.
   */
  it('answers nothing when the message carries no URL', () => {
    expect(chunkUrlFromError(new Error('Loading chunk 42 failed'))).toBeUndefined()
    expect(chunkUrlFromError(undefined)).toBeUndefined()
  })
})

describe('retryUrl', () => {
  /**
   * THE MEASURED CONSTRAINT. A failed module URL is poisoned in the document's
   * module map for the life of the page, so a retry that reuses the URL cannot
   * make a request at all — verified in Chromium against a server toggled off
   * and back on. Everything else in this file depends on this line being true.
   */
  it('always changes the URL, because the same one can never be re-fetched', () => {
    expect(retryUrl(CHUNK_URL, 1)).toBe(`${CHUNK_URL}?podium-retry=1`)
    expect(retryUrl(CHUNK_URL, 1)).not.toBe(CHUNK_URL)
  })

  it('keeps a query string the URL already had', () => {
    expect(retryUrl('/a.js?v=2', 3)).toBe('/a.js?v=2&podium-retry=3')
  })
})

describe('importThroughRestarts', () => {
  it('costs nothing at all when the import works', async () => {
    const { deps, asked } = rig(['ok'])
    await expect(importThroughRestarts(async () => 'module', deps)).resolves.toBe('module')
    expect(asked).toHaveLength(0)
  })

  /**
   * A component that throws while evaluating is not a network problem, and must
   * reach the boundary immediately and unchanged. Delaying it behind a server
   * probe would make every genuine bug take twenty seconds to report itself.
   */
  it('does not interrogate the server about an ordinary error', async () => {
    const { deps, asked } = rig(['ok'])
    const boom = new Error('Cannot read properties of undefined')
    await expect(importThroughRestarts(() => Promise.reject(boom), deps)).rejects.toBe(boom)
    expect(asked).toHaveLength(0)
  })

  /**
   * THE CASE THE BRIEF PROTECTS. A chunk that fails while the server is UP and
   * serving the same build is a genuine asset-serving bug. Retrying it would
   * bury the bug in a loop; the honest thing is to hand the original error
   * straight on.
   */
  it('does not retry a chunk the live server simply would not serve', async () => {
    const { deps, imported } = rig(['ok'])
    const error = refused()
    await expect(importThroughRestarts(() => Promise.reject(error), deps)).rejects.toBe(error)
    expect(imported).toHaveLength(0)
  })

  /** The assets MOVED. That is POD-2721's screen, reached without any waiting. */
  it('hands a replaced build straight to the boundary without waiting', async () => {
    const { deps, imported, clock } = rig(['replaced'])
    const error = refused()
    await expect(importThroughRestarts(() => Promise.reject(error), deps)).rejects.toBe(error)
    expect(imported).toHaveLength(0)
    expect(clock()).toBe(0)
  })

  /**
   * THE WHOLE POINT. Refused, then the server comes back on the same build, and
   * the surface simply opens — no crash page, no reload, no lost tab state.
   */
  it('recovers in place when the server comes back', async () => {
    const { deps, imported } = rig(['unreachable', 'unreachable', 'ok'])
    const module = await importThroughRestarts<unknown>(() => Promise.reject(refused()), deps)
    expect(module).toEqual({ SettingsView: 'the real module' })
    // Exactly one re-import, and it could not have been the poisoned URL.
    expect(imported).toEqual([`${CHUNK_URL}?podium-retry=1`])
  })

  /**
   * A handover that lands on a DIFFERENT build is POD-2721's case after all, and
   * this is the only moment the page could have found that out — at the instant
   * of the failure the server could not answer either way.
   */
  it('stops and reports when the server returns as a different build', async () => {
    const { deps, imported } = rig(['unreachable', 'replaced'])
    const error = refused()
    await expect(importThroughRestarts(() => Promise.reject(error), deps)).rejects.toBe(error)
    expect(imported).toHaveLength(0)
  })

  it('reports the ORIGINAL error when the retry itself fails', async () => {
    const { deps } = rig(['unreachable', 'ok'], () => Promise.reject(new Error('still gone')))
    const error = refused()
    await expect(importThroughRestarts(() => Promise.reject(error), deps)).rejects.toBe(error)
  })

  /** A wait has to end. A page stuck on "reconnecting" forever is its own bug. */
  it('gives up, and reports, when the server never comes back', async () => {
    const { deps, clock } = rig(['unreachable'])
    const error = refused()
    await expect(importThroughRestarts(() => Promise.reject(error), deps)).rejects.toBe(error)
    expect(clock()).toBeGreaterThanOrEqual(OUTAGE_PATIENCE_MS)
  })

  /**
   * A SHAPE WE DO NOT RECOGNISE IS STILL WORTH ONE GO. The message carries no
   * URL, so nothing can be re-imported by hand — but the loader itself may well
   * work once the server is back (that is exactly what a failed stylesheet
   * preload turned out to be), and the cost of finding out is one call.
   */
  it('still retries the loader once when it cannot name what failed', async () => {
    const { deps, imported } = rig(['unreachable', 'ok'])
    let calls = 0
    const load = async () => {
      calls += 1
      if (calls === 1) throw new Error('Loading chunk 42 failed')
      return 'recovered'
    }
    await expect(importThroughRestarts(load, deps)).resolves.toBe('recovered')
    expect(calls).toBe(2)
    // Nothing was invented: no URL means no hand-rolled import.
    expect(imported).toHaveLength(0)
  })

  it('gives up on an unnameable failure within the budget, not forever', async () => {
    const { deps, clock } = rig(['unreachable'])
    const error = new Error('Loading chunk 42 failed')
    await expect(importThroughRestarts(() => Promise.reject(error), deps)).rejects.toBe(error)
    expect(clock()).toBeGreaterThanOrEqual(OUTAGE_PATIENCE_MS)
    expect(clock()).toBeLessThan(OUTAGE_PATIENCE_MS * 3)
  })
})

describe('the waiting notice', () => {
  it('is raised only while something is actually waiting for the server', async () => {
    const seen: boolean[] = []
    const stop = subscribeWaitingForServer(() => seen.push(isWaitingForServer()))
    const { deps } = rig(['unreachable', 'ok'])
    expect(isWaitingForServer()).toBe(false)
    await importThroughRestarts<unknown>(() => Promise.reject(refused()), deps)
    stop()
    // Up while the wait ran, and down again by the time it resolved — a notice
    // left standing after recovery is worse than no notice.
    expect(seen).toEqual([true, false])
    expect(isWaitingForServer()).toBe(false)
  })

  /**
   * The incident had FOUR chunks fail together. The first one to recover must
   * not clear the notice out from under the three still waiting.
   */
  it('stays up while any one of several surfaces is still waiting', async () => {
    const quick = rig(['unreachable', 'ok'])
    // A second surface still stuck in its wait, held there deterministically
    // rather than by racing two fake clocks.
    const stuck: ChunkRecoveryDeps = {
      askServer: async () => 'unreachable',
      wait: () => new Promise(() => {}),
      now: () => 0,
      importUrl: async () => ({}),
    }
    void importThroughRestarts<unknown>(() => Promise.reject(refused()), stuck)
    await importThroughRestarts<unknown>(() => Promise.reject(refused()), quick.deps)
    expect(isWaitingForServer()).toBe(true)
  })
})

describe('patienceFor', () => {
  /**
   * The page was TOLD an update was running, seconds before the server went
   * quiet. That is the difference between waiting out a handover and waiting out
   * something that is not going to fix itself.
   */
  it('waits much longer when an update was running', () => {
    noteActiveUpdate(true)
    expect(patienceFor({})).toBe(RESTART_PATIENCE_MS)
    expect(RESTART_PATIENCE_MS).toBeGreaterThan(OUTAGE_PATIENCE_MS)
  })

  it('is brisk about an outage with nothing behind it', () => {
    noteActiveUpdate(false)
    expect(patienceFor({})).toBe(OUTAGE_PATIENCE_MS)
  })

  /**
   * A tab left open overnight that saw an update finish yesterday must not spend
   * the long budget on an unrelated outage this morning. A stale observation is
   * not an observation.
   */
  it('will not spend the long budget on a stale sighting', () => {
    const yesterday = Date.now() - 6 * 60 * 60 * 1000
    noteActiveUpdate(true, yesterday)
    expect(patienceFor({})).toBe(OUTAGE_PATIENCE_MS)
  })

  it('knows nothing before the first poll lands', () => {
    expect(patienceFor({})).toBe(OUTAGE_PATIENCE_MS)
  })
})

describe('what it refuses to do', () => {
  /**
   * NEVER A RELOAD. Not on the failure, not when the server comes back, not when
   * it gives up. An automatic reload is the single ingredient POD-2608's
   * unclearable loop required, and this module runs in exactly the conditions
   * that would make one loop.
   */
  it('never reloads the page, on any path', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload, href: 'http://podium.test/' })
    for (const answers of [
      ['ok'],
      ['replaced'],
      ['unreachable', 'ok'],
      ['unreachable', 'replaced'],
      ['unreachable'],
    ] as Array<ServedAssetsAnswer[]>) {
      const { deps } = rig(answers)
      await importThroughRestarts<unknown>(() => Promise.reject(refused()), deps).catch(() => {})
    }
    expect(reload).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

/**
 * THE FAILURE THE FIRST END-TO-END RUN ACTUALLY PRODUCED.
 *
 * A lazy route is not one fetch: vite links the view's STYLESHEET before it
 * imports the module, and when the server is away it is the stylesheet that
 * rejects first — with a root-relative path, not the absolute URL a failed
 * module carries. The first version of this recovery understood only the second
 * shape, so it read the real incident as "no URL, nothing I can do" and handed
 * the whole interface to the error boundary. These are that bug's regressions.
 */
describe('a stylesheet that would not preload', () => {
  const cssFailure = (): Error =>
    new Error('Unable to preload CSS for /assets/SpecsView-BU77C3xX.css')

  it('is recognised as a stylesheet, with its href', () => {
    expect(classifyChunkFailure(cssFailure())).toEqual({
      kind: 'stylesheet',
      href: '/assets/SpecsView-BU77C3xX.css',
    })
  })

  it('reads a root-relative module path too, not only an absolute URL', () => {
    expect(classifyChunkFailure(new Error('Failed to fetch dynamically imported module: /assets/X-abc.js'))).toEqual(
      { kind: 'module', url: '/assets/X-abc.js' },
    )
    expect(classifyChunkFailure(refused())).toEqual({ kind: 'module', url: CHUNK_URL })
  })

  /**
   * The module was never imported, so nothing is poisoned: the ORDINARY loader
   * is the right retry, and re-importing under a cache-busted URL would be both
   * unnecessary and wrong (a stylesheet is not a module).
   */
  it('retries the loader itself, not a cache-busted module URL', async () => {
    const { deps, imported } = rig(['unreachable', 'ok'])
    let calls = 0
    const load = async () => {
      calls += 1
      if (calls === 1) throw cssFailure()
      return 'the view'
    }
    await expect(importThroughRestarts(load, deps)).resolves.toBe('the view')
    expect(calls).toBe(2)
    expect(imported).toHaveLength(0)
  })

  /**
   * And it asks for the stylesheet again. Vite's `seen` map means the retried
   * loader will NOT re-link it, so without this the view comes back correct and
   * completely unstyled — a repair that looks like a success.
   */
  it('re-requests the stylesheet vite will never ask for again', async () => {
    const { deps, stylesheets } = rig(['unreachable', 'ok'])
    let calls = 0
    const load = async () => {
      calls += 1
      if (calls === 1) throw cssFailure()
      return 'the view'
    }
    await importThroughRestarts(load, deps)
    expect(stylesheets).toEqual(['/assets/SpecsView-BU77C3xX.css'])
  })

  /** A view without its styles still beats a view that is not there. */
  it('still loads the view when the stylesheet cannot be recovered', async () => {
    const { deps } = rig(['unreachable', 'ok'])
    deps.loadStylesheet = () => Promise.reject(new Error('still gone'))
    let calls = 0
    const load = async () => {
      calls += 1
      if (calls === 1) throw cssFailure()
      return 'the view'
    }
    await expect(importThroughRestarts(load, deps)).resolves.toBe('the view')
  })
})
