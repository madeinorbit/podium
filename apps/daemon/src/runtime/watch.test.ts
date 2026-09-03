/**
 * THE FINE-WATCH LIFECYCLE (POD-2293).
 *
 * Each property is a leak, a flap, or a lie the naive version has. The clock is
 * faked because the debounce IS the design — a test that only checked "released
 * eventually" would pass on an implementation that released immediately, which
 * is the one behaviour the debounce exists to prevent.
 */

import type { AgentSessionHandle, DriverCapabilities } from '@podium/agent-runtime'
import type { SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { createRuntimeWatchLifecycle } from './watch'

const SESSION = 'sess-watch' as SessionId

const capabilities = (levels: readonly ('coarse' | 'fine')[]): DriverCapabilities =>
  ({ observation: { watchLevels: levels } }) as unknown as DriverCapabilities

interface World {
  watches: ReturnType<typeof createRuntimeWatchLifecycle>
  acquires: number
  releases: number
  tick(ms: number): Promise<void>
  settle(): Promise<void>
  gate(): void
  open(): void
}

function world(opts: { levels?: readonly ('coarse' | 'fine')[]; handle?: boolean } = {}): World {
  const timers: { at: number; fn: () => void; id: number }[] = []
  let now = 0
  let nextTimer = 1
  const state = { acquires: 0, releases: 0 }
  let gate: Promise<void> | undefined
  let openGate: (() => void) | undefined

  const handle = {
    async watch(level: string) {
      expect(level).toBe('fine')
      state.acquires += 1
      if (gate) await gate
      return () => {
        state.releases += 1
      }
    },
  } as unknown as AgentSessionHandle

  const watches = createRuntimeWatchLifecycle({
    handleFor: () => (opts.handle === false ? undefined : handle),
    capabilitiesFor: () => capabilities(opts.levels ?? ['coarse', 'fine']),
    releaseDelayMs: 30_000,
    setTimer: (fn, ms) => {
      const id = nextTimer++
      timers.push({ at: now + ms, fn, id })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (h) => {
      const index = timers.findIndex((t) => t.id === (h as unknown as number))
      if (index >= 0) timers.splice(index, 1)
    },
  })

  const settle = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  return {
    watches,
    get acquires() {
      return state.acquires
    },
    get releases() {
      return state.releases
    },
    settle,
    gate: () => {
      gate = new Promise<void>((resolve) => {
        openGate = resolve
      })
    },
    open: () => openGate?.(),
    async tick(ms) {
      now += ms
      for (const timer of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(timer), 1)
        timer.fn()
      }
      await settle()
    },
  }
}

describe('fine watch lifecycle', () => {
  it('acquires ONCE however many times the level is asked for', async () => {
    const w = world()
    w.watches.want(SESSION, 'fine')
    w.watches.want(SESSION, 'fine')
    w.watches.want(SESSION, 'fine')
    await w.settle()
    // The frame carries a desired STATE, so a repeat is a no-op. A second
    // acquire here is a refcount nothing will ever release.
    expect(w.acquires).toBe(1)
    expect(w.watches.held()).toEqual([SESSION])
  })

  it('holds the watch through a debounce, and releases when nobody came back', async () => {
    const w = world()
    w.watches.want(SESSION, 'fine')
    await w.settle()
    w.watches.want(SESSION, 'coarse')
    await w.tick(29_000)
    // Still held. A viewer navigating between two sessions takes the count to
    // zero and back inside this window; on codex a release costs a reconnect
    // each way, which is far more than the tokens it would have saved.
    expect(w.releases).toBe(0)
    await w.tick(2_000)
    expect(w.releases).toBe(1)
    expect(w.watches.held()).toEqual([])
  })

  it('cancels the release when a viewer comes back inside the window', async () => {
    const w = world()
    w.watches.want(SESSION, 'fine')
    await w.settle()
    w.watches.want(SESSION, 'coarse')
    await w.tick(10_000)
    w.watches.want(SESSION, 'fine')
    await w.tick(60_000)
    expect(w.releases).toBe(0)
    // And it did NOT acquire a second one on top of the one it still holds.
    expect(w.acquires).toBe(1)
  })

  it('releases a watch whose viewer left while `watch()` was still resolving', async () => {
    const w = world()
    w.gate()
    w.watches.want(SESSION, 'fine')
    await w.settle()
    expect(w.acquires).toBe(1)
    // The window this closes: everything can change while an async acquire
    // resolves, and a watch nobody wants any more is exactly a leak.
    w.watches.want(SESSION, 'coarse')
    await w.tick(60_000)
    w.open()
    await w.settle()
    expect(w.releases).toBe(1)
    expect(w.watches.held()).toEqual([])
  })

  it('takes no path at all for a coarse-only driver', async () => {
    const w = world({ levels: ['coarse'] })
    w.watches.want(SESSION, 'fine')
    await w.settle()
    // A PTY produces bytes, not tokens. A watch here is a refcount that buys
    // nothing, and the point of the gate is that the session is untouched.
    expect(w.acquires).toBe(0)
    expect(w.watches.held()).toEqual([])
  })

  it('does nothing for a session this daemon does not drive', async () => {
    const w = world({ handle: false })
    w.watches.want(SESSION, 'fine')
    await w.settle()
    expect(w.acquires).toBe(0)
  })

  it('drops the watch immediately when the session is forgotten', async () => {
    const w = world()
    w.watches.want(SESSION, 'fine')
    await w.settle()
    w.watches.forget(SESSION)
    // No debounce: the handle whose release function this is has gone, and
    // waiting 30 seconds to drop a reference to a dead driver helps nobody.
    expect(w.releases).toBe(1)
    await w.tick(60_000)
    expect(w.releases).toBe(1)
  })

  it('releases everything it holds on dispose', async () => {
    const w = world()
    w.watches.want(SESSION, 'fine')
    await w.settle()
    w.watches.dispose()
    expect(w.releases).toBe(1)
    expect(w.watches.held()).toEqual([])
  })
})
