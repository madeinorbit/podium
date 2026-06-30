import { describe, expect, test } from 'vitest'
import { isAllowedWsOrigin } from './wsServer'

describe('isAllowedWsOrigin', () => {
  test('a request with no Origin (native client / daemon) is allowed', () => {
    expect(isAllowedWsOrigin(undefined, 'podium.example.com')).toBe(true)
  })

  test('a same-origin browser request (Origin host == Host) is allowed', () => {
    expect(isAllowedWsOrigin('https://podium.example.com', 'podium.example.com')).toBe(true)
    expect(isAllowedWsOrigin('http://1.2.3.4:18787', '1.2.3.4:18787')).toBe(true)
  })

  test('the desktop webview origin (tauri://localhost) is allowed', () => {
    expect(isAllowedWsOrigin('tauri://localhost', '127.0.0.1:54321')).toBe(true)
  })

  test('loopback origins are allowed (local dev / bundled app)', () => {
    expect(isAllowedWsOrigin('http://localhost:5173', '127.0.0.1:18787')).toBe(true)
    expect(isAllowedWsOrigin('http://127.0.0.1:18787', '127.0.0.1:18787')).toBe(true)
  })

  test('a foreign cross-site origin is rejected (CSWSH defense)', () => {
    expect(isAllowedWsOrigin('https://evil.example', 'podium.example.com')).toBe(false)
  })

  test('a malformed Origin is rejected', () => {
    expect(isAllowedWsOrigin('not a url', 'podium.example.com')).toBe(false)
  })
})
