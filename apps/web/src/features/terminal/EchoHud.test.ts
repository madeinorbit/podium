import { afterEach, describe, expect, it } from 'vitest'
import { echoHudEnabled } from './EchoHud'

const stored = (value: string | null): { get(key: string): string | null } => ({
  get: (key) => (key === 'podium.echoHud' ? value : null),
})

describe('echoHudEnabled', () => {
  afterEach(() => history.replaceState(null, '', '/'))

  it('is off by default and reads the stored diagnostic flag', () => {
    expect(echoHudEnabled(stored(null))).toBe(false)
    expect(echoHudEnabled(stored('1'))).toBe(true)
  })

  it('lets the one-off URL flag enable or explicitly disable the probe', () => {
    history.replaceState(null, '', '/?echoHud=1')
    expect(echoHudEnabled(stored(null))).toBe(true)

    history.replaceState(null, '', '/?echoHud=0')
    expect(echoHudEnabled(stored('1'))).toBe(false)
  })
})
