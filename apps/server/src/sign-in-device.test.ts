import { expect, it } from 'vitest'
import { browserSignInDevice } from './sign-in-device'

const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const EDGE_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'

it('names a browser sign-in by browser and OS (POD-6701)', () => {
  expect(browserSignInDevice(SAFARI_MAC, 'https://podium.example')).toEqual({
    kind: 'browser',
    name: 'Safari on macOS',
    platform: 'macos',
  })
  expect(browserSignInDevice(EDGE_WINDOWS, undefined).name).toBe('Edge on Windows')
  expect(browserSignInDevice(undefined, undefined)).toMatchObject({
    kind: 'browser',
    name: 'Web browser',
    platform: 'unknown',
  })
})

it('names a sign-in from the desktop shell’s webview origin as the desktop app', () => {
  expect(browserSignInDevice(SAFARI_MAC, 'tauri://localhost')).toMatchObject({
    kind: 'desktop',
    name: 'Podium desktop on macOS',
  })
  expect(browserSignInDevice(EDGE_WINDOWS, 'http://tauri.localhost').name).toBe(
    'Podium desktop on Windows',
  )
  expect(browserSignInDevice(EDGE_WINDOWS, 'not a url').kind).toBe('browser')
})
