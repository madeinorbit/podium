import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from './id'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('randomUUID', () => {
  it('produces RFC 4122 v4 ids', () => {
    expect(randomUUID()).toMatch(UUID_V4)
    expect(randomUUID()).not.toBe(randomUUID())
  })

  it('falls back to getRandomValues where randomUUID is missing (insecure context)', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (array: Uint8Array) => {
        for (let i = 0; i < array.length; i++) array[i] = (i * 37 + 11) % 256
        return array
      },
    })
    expect(randomUUID()).toMatch(UUID_V4)
  })

  it('still mints ids where `crypto` does not exist at all (Hermes)', () => {
    // React Native's Hermes ships NO `globalThis.crypto`. The old code guarded
    // `crypto.randomUUID` but then dereferenced the same missing `crypto` for
    // `getRandomValues` — so the first client-minted id (a draft spawn, an
    // outbox mutation) crashed the native app (2026-08-27 device feedback #3).
    vi.stubGlobal('crypto', undefined)
    const id = randomUUID()
    expect(id).toMatch(UUID_V4)
    expect(randomUUID()).not.toBe(id)
  })
})
