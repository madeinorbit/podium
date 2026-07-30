import { afterEach, describe, expect, it } from 'vitest'
import { defaultPtyBackend, hasBunTerminal, isUnderBun } from './index.js'

const orig = process.env.PODIUM_PTY_BACKEND
afterEach(() => {
  if (orig === undefined) delete process.env.PODIUM_PTY_BACKEND
  else process.env.PODIUM_PTY_BACKEND = orig
})

// The suite runs under Bun in CI and prod, but these tests stay correct under
// Node too: every expectation is derived from the LIVE runtime rather than
// assuming one. `process.versions.bun` is the independent oracle (set only under
// Bun) — using it keeps the isUnderBun()/hasBunTerminal() assertions non-circular.
const reallyUnderBun = !!process.versions.bun
// Under Bun the auto path takes the terminal PTY; under Node it falls to node-pty.
const autoBackendName = isUnderBun() && hasBunTerminal() ? 'bun-terminal' : 'node-pty'

describe('defaultPtyBackend', () => {
  it('auto-selects the runtime PTY (bun-terminal under Bun, else node-pty)', () => {
    delete process.env.PODIUM_PTY_BACKEND
    expect(defaultPtyBackend().name).toBe(autoBackendName)
  })
  it('honors PODIUM_PTY_BACKEND=node-pty', () => {
    process.env.PODIUM_PTY_BACKEND = 'node-pty'
    expect(defaultPtyBackend().name).toBe('node-pty')
  })
  it('forces bun-terminal when the API is present, else throws', () => {
    process.env.PODIUM_PTY_BACKEND = 'bun-terminal'
    if (hasBunTerminal()) {
      expect(defaultPtyBackend().name).toBe('bun-terminal')
    } else {
      expect(() => defaultPtyBackend()).toThrow(/Bun\.Terminal/)
    }
  })
  it('throws on an unknown backend name', () => {
    process.env.PODIUM_PTY_BACKEND = 'nope'
    expect(() => defaultPtyBackend()).toThrow(/unknown/)
  })
})

describe('bun terminal feature-detection', () => {
  it('isUnderBun() matches the runtime and hasBunTerminal() tracks it', () => {
    // The probes must move together so the auto path picks bun-terminal iff the
    // terminal PTY API is present: true under Bun (>= our floor, which CI + prod
    // pin), false under Node.
    expect(isUnderBun()).toBe(reallyUnderBun)
    expect(hasBunTerminal()).toBe(reallyUnderBun)
  })
})
