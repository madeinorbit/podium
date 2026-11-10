import { expect, it } from 'vitest'
import { browserSignInMetadata } from './sign-in-device'

const AT = '2026-11-10T00:00:00.000Z'
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const EDGE_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'

it('names a browser sign-in by browser and OS (POD-6701)', () => {
  expect(browserSignInMetadata(SAFARI_MAC, 'https://podium.example', AT)).toEqual({
    deviceId: 'browser',
    deviceName: 'Safari on macOS',
    platform: 'macos',
    lastSeenAt: AT,
  })
  expect(browserSignInMetadata(EDGE_WINDOWS, undefined, AT).deviceName).toBe('Edge on Windows')
  expect(browserSignInMetadata(undefined, undefined, AT)).toMatchObject({
    deviceId: 'browser',
    deviceName: 'Web browser',
    platform: 'unknown',
  })
})

it('names a sign-in from the desktop shell’s webview origin as the desktop app', () => {
  expect(browserSignInMetadata(SAFARI_MAC, 'tauri://localhost', AT)).toMatchObject({
    deviceId: 'desktop',
    deviceName: 'Podium desktop on macOS',
  })
  expect(browserSignInMetadata(EDGE_WINDOWS, 'http://tauri.localhost', AT).deviceName).toBe(
    'Podium desktop on Windows',
  )
  expect(browserSignInMetadata(EDGE_WINDOWS, 'not a url', AT).deviceId).toBe('browser')
})
