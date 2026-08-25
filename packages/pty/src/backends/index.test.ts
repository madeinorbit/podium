import { afterEach, describe, expect, it } from 'vitest'
import { defaultPtyBackend, hasBunTerminal, isUnderBun } from './index.js'

const orig = process.env.PODIUM_PTY_BACKEND
afterEach(() => {
  if (orig === undefined) delete process.env.PODIUM_PTY_BACKEND
  else process.env.PODIUM_PTY_BACKEND = orig
})

// Podium and its validation lanes run under Bun. `process.versions.bun` is an
// independent oracle for the feature-detection helpers.
const reallyUnderBun = !!process.versions.bun

describe('defaultPtyBackend', () => {
  it('selects Bun.Terminal', () => {
    delete process.env.PODIUM_PTY_BACKEND
    expect(defaultPtyBackend().name).toBe('bun-terminal')
  })
  it('rejects the retired node-pty override', () => {
    process.env.PODIUM_PTY_BACKEND = 'node-pty'
    expect(() => defaultPtyBackend()).toThrow(/requires bun-terminal/)
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
    expect(isUnderBun()).toBe(reallyUnderBun)
    expect(hasBunTerminal()).toBe(reallyUnderBun)
  })
})
