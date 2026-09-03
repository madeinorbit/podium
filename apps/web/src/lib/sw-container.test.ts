import { afterEach, describe, expect, it } from 'vitest'
import { serviceWorkerAvailability, serviceWorkerContainer } from './sw-container'

/**
 * The accessor exists for ONE case that `typeof navigator === 'undefined'` does
 * not cover: a getter that throws (POD-3224 review). The first read happens at
 * `main.tsx` module scope, before React and before the error boundary, so a
 * throw there is a blank page with no crash report.
 */

const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'serviceWorker')

function defineServiceWorker(get: () => unknown): void {
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, get })
}

afterEach(() => {
  // Back to whatever happy-dom provides, so one case cannot leak into the next.
  delete (navigator as unknown as Record<string, unknown>).serviceWorker
  if (original) Object.defineProperty(Navigator.prototype, 'serviceWorker', original)
})

describe('serviceWorkerContainer', () => {
  it('answers the container when the property is a plain value', () => {
    const container = {} as ServiceWorkerContainer
    defineServiceWorker(() => container)
    expect(serviceWorkerContainer()).toBe(container)
    expect(serviceWorkerAvailability()).toBe('available')
  })

  it('does NOT throw when the getter does — the opaque-origin case', () => {
    defineServiceWorker(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    })
    expect(() => serviceWorkerContainer()).not.toThrow()
    expect(serviceWorkerContainer()).toBeUndefined()
    // And it says WHICH kind of absence this is, so a silent `web:sw` namespace
    // has an explanation rather than a missing field.
    expect(serviceWorkerAvailability()).toBe('refused')
  })

  it('reports an unsupported browser apart from a refused one', () => {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker
    if (original) delete (Navigator.prototype as unknown as Record<string, unknown>).serviceWorker
    expect(serviceWorkerContainer()).toBeUndefined()
    expect(serviceWorkerAvailability()).toBe('unsupported')
  })
})
