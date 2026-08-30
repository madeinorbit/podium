import { afterEach, describe, expect, it, vi } from 'vitest'

const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>()

function rejectAmbientRead(name: 'window' | 'document' | 'navigator'): void {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      throw new Error(`${name} was read while evaluating a platform-neutral entrypoint`)
    },
  })
}

afterEach(() => {
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  descriptors.clear()
  vi.resetModules()
})

describe('platform-neutral client-core entrypoints', () => {
  it.each(['transcript', 'conversation'] as const)(
    '%s evaluates without DOM or browser globals',
    async (entrypoint) => {
      rejectAmbientRead('window')
      rejectAmbientRead('document')
      rejectAmbientRead('navigator')

      const module =
        entrypoint === 'transcript'
          ? await import('@podium/client-core/transcript')
          : await import('@podium/client-core/conversation')

      expect(Object.keys(module).length).toBeGreaterThan(0)
    },
  )
})
