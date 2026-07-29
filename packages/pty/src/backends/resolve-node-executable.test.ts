import { describe, expect, it } from 'vitest'
import { resolveNodeExecutable } from './resolve-node-executable.js'

describe('resolveNodeExecutable', () => {
  it('returns a path that is not a Bun shim', () => {
    const bin = resolveNodeExecutable()
    expect(bin.length).toBeGreaterThan(0)
    expect(bin.toLowerCase()).not.toMatch(/bun-node-/)
    // Under Bun we must not hand back process.execPath (the bun binary).
    if (process.versions.bun) {
      expect(bin).not.toBe(process.execPath)
    } else {
      expect(bin).toBe(process.execPath)
    }
  })

  it('is stable across calls', () => {
    expect(resolveNodeExecutable()).toBe(resolveNodeExecutable())
  })
})
