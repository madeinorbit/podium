import { afterEach, describe, expect, it, vi } from 'vitest'
import { pageSurface } from './page-surface'

/**
 * The bridge-driven cases live in `features/updates/use-update-state.test.tsx`,
 * which exercises this same function through `surfaceFromDesktopBridge`. What is
 * here is the half that has no bridge at all — the browser and the phone
 * website — because that is the branch the BOOT RECORD takes (POD-3224), and it
 * runs before any of that feature's code is even fetched.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pageSurface without a desktop bridge', () => {
  it('is `web` for an ordinary browser tab', () => {
    vi.stubGlobal('location', { pathname: '/', protocol: 'https:', hostname: 'podium.example' })
    expect(pageSurface()).toBe('web')
  })

  it('is `mobile` for the phone website this same bundle serves', () => {
    vi.stubGlobal('location', {
      pathname: '/mobile/sessions',
      protocol: 'https:',
      hostname: 'podium.example',
    })
    expect(pageSurface()).toBe('mobile')
  })
})

describe('pageSurface with a desktop bridge', () => {
  afterEach(() => {
    delete (globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__
  })

  // A VPS-connected desktop is a `client` (POD-5973), remote even on the bundled tauri:// page
  // the shell loads when its server did not answer at cold start.
  it.each(['client', 'daemon'] as const)('is remote for a %s window', (mode) => {
    vi.stubGlobal('location', { pathname: '/', protocol: 'tauri:', hostname: 'localhost' })
    ;(globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__ = {
      platform: 'macos',
      launchMode: mode,
    }
    expect(pageSurface()).toBe('desktop-remote')
  })
})
