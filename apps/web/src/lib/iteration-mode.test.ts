import { afterEach, describe, expect, it, vi } from 'vitest'
import { isIterationMode } from './iteration-mode'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isIterationMode', () => {
  it('is false in a built bundle, where the define is the literal false', () => {
    expect(isIterationMode(false)).toBe(false)
  })

  it('is false when the define is absent entirely (an older bundle, a test)', () => {
    expect(isIterationMode(undefined)).toBe(false)
  })

  it('is true only for the boolean the iterate define writes', () => {
    expect(isIterationMode(true)).toBe(true)
  })

  it('refuses a truthy string — a stray env value must not claim iteration mode', () => {
    expect(isIterationMode('1' as unknown as boolean)).toBe(false)
  })

  it('defaults to the build define, and says NO when there is none', () => {
    expect(isIterationMode()).toBe(false)
  })

  // `vi.stubEnv` coerces to a string, which is exactly the shape a leaked env
  // value has — and the shape that must never switch the updater off. The true
  // path is a build-time define, verified against the running dev server rather
  // than here (a browser found the frame on :55566 and not on the installed UI).
  it('is not fooled by a stringly-true value in the environment', () => {
    vi.stubEnv('PODIUM_ITERATION_MODE', 'true')
    expect(isIterationMode()).toBe(false)
  })
})
