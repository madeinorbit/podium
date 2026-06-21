import { afterEach, describe, expect, it } from 'vitest'
import { defaultPtyBackend } from './index.js'

const orig = process.env.PODIUM_PTY_BACKEND
afterEach(() => {
  if (orig === undefined) delete process.env.PODIUM_PTY_BACKEND
  else process.env.PODIUM_PTY_BACKEND = orig
})

describe('defaultPtyBackend', () => {
  it('defaults to node-pty under Node (no Bun.Terminal)', () => {
    delete process.env.PODIUM_PTY_BACKEND
    expect(defaultPtyBackend().name).toBe('node-pty')
  })
  it('honors PODIUM_PTY_BACKEND=node-pty', () => {
    process.env.PODIUM_PTY_BACKEND = 'node-pty'
    expect(defaultPtyBackend().name).toBe('node-pty')
  })
  it('throws when bun-terminal is forced but unavailable (under Node)', () => {
    process.env.PODIUM_PTY_BACKEND = 'bun-terminal'
    expect(() => defaultPtyBackend()).toThrow(/Bun\.Terminal/)
  })
  it('throws on an unknown backend name', () => {
    process.env.PODIUM_PTY_BACKEND = 'nope'
    expect(() => defaultPtyBackend()).toThrow(/unknown/)
  })
})
