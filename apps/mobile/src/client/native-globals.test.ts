// @vitest-environment node
//
// NOT happy-dom, deliberately — see `test/native-globals.ts`. Everything in this
// file asks the question the rest of the lane cannot: does shared client code
// run on a device whose `window` is React Native's `global`?

import { platformIsOnline, platformOnlineEvents } from '@podium/client-core/outbox'
import { afterEach, describe, expect, test } from 'vitest'
import { installNativeGlobals, type NativeGlobals } from '../../test/native-globals'
import { readServerConfig } from './trpc'

let natives: NativeGlobals | undefined

afterEach(() => {
  natives?.restore()
  natives = undefined
  delete (globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__
})

describe('the shared platform probes on React Native globals', () => {
  test('the harness itself is native-shaped: a window with no DOM under it', () => {
    natives = installNativeGlobals()
    expect(typeof window).toBe('object')
    expect((window as unknown as { location?: unknown }).location).toBeUndefined()
    expect(typeof document).toBe('undefined')
  })

  test('online events decline to subscribe rather than throwing', () => {
    natives = installNativeGlobals()
    expect(platformOnlineEvents()).toBeUndefined()
  })

  test('a navigator with no onLine reads as online', () => {
    natives = installNativeGlobals()
    expect(platformIsOnline()).toBe(true)
  })
})

describe('readServerConfig without a browser location', () => {
  /**
   * THE POINT IS THAT IT DOES NOT CRASH, and the expected answer moved.
   *
   * This case was written asserting a fall-through to `http://127.0.0.1:18787`,
   * because that is what the function did when POD-2062 made it stop
   * dereferencing `window.location` on React Native. It no longer does: server
   * PROFILES landed since, and a phone with no location and nothing injected is
   * now told to pick one rather than being pointed at a localhost that is not
   * there. That is a deliberate product answer, so the assertion follows it.
   *
   * What this case still guards is the bug it was written for, and the
   * distinction is the whole value of it: the failure must be the DELIBERATE
   * refusal, not the `TypeError` on `location.search` that RN's
   * `global.window = global` used to produce one line into the app's boot. A
   * regression there throws too — so asserting the MESSAGE, not merely that it
   * threw, is what keeps this test able to tell the two apart.
   */
  test('refuses deliberately instead of dereferencing window.location', () => {
    natives = installNativeGlobals()
    expect(() => readServerConfig()).toThrow('native server profile has not been selected')
  })

  test('takes the injected server, which is the only config path on device', () => {
    natives = installNativeGlobals()
    ;(globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__ = 'https://podium.example:8443'
    const config = readServerConfig()
    expect(config).toEqual({
      wsClientUrl: expect.stringContaining('wss://podium.example:8443/client?v='),
      httpOrigin: 'https://podium.example:8443',
      override: true,
    })
  })
})
