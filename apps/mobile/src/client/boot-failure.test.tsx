/**
 * A BOOT THAT CANNOT FINISH HAS TO SAY SO (POD-712).
 *
 * The reported symptom was "the ASCII loader, then a blank navy screen, no
 * errors" — and the reason no error ever appeared is that there was nowhere for
 * one to go. `LiveProvider` ran its boot in a fire-and-forget async IIFE with no
 * `catch`, so a thrown auth status, a storage engine that never opened, or a
 * rejected migration all ended the same way: `setOpenedReplica` was never
 * called, the provider returned `null`, and the `LaunchBoundary` above it kept
 * the wordmark splash up for the life of the page. `shell.error` could not
 * help — it is only rendered by screens a failed boot never mounts.
 *
 * These tests pin the two halves of the fix: a failed boot RENDERS something,
 * and a `pagehide` mid-boot does not silence it. The second is the regression
 * from ee02d6331, which registered a pagehide handler that cleared the SAME
 * `alive` flag guarding every `setState` in the boot — one backgrounded app (the
 * ordinary thing iOS Safari does) and no later state update could ever land.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { Platform } from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// AsyncStorage's native CommonJS entry bypasses Vite's source alias and loads
// Flow-typed React Native in Node. Boot only needs the documented async key/value
// boundary, so exercise that boundary directly with an empty backing store.
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getAllKeys: async () => [],
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}))
// These isolated provider tests exercise the documented no-profile compatibility
// path. Stop at that seam instead of importing Expo Router's externalized CJS
// graph, whose direct React Native require bypasses Vite's web alias.
vi.mock('./ServerProfileGate', () => ({ useOptionalServerProfile: () => null }))

import { MobileClientProvider } from './MobileClientProvider'

class SilentSocket {
  readyState = 0
  send(): void {}
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

beforeEach(() => {
  ;(globalThis as { WebSocket?: unknown }).WebSocket = SilentSocket
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Calls made by the boot, so a retry can be observed as a fresh attempt. */
let fetchCalls = 0

/** The server is unreachable — the boot's first await rejects. */
function withUnreachableServer() {
  fetchCalls = 0
  vi.stubGlobal('fetch', async () => {
    fetchCalls += 1
    throw new Error('Load failed')
  })
}

describe('mobile boot failure surface', () => {
  it('renders a failure screen instead of an eternal splash', async () => {
    withUnreachableServer()
    render(
      <MobileClientProvider>
        <div>app</div>
      </MobileClientProvider>,
    )
    // The point of the whole change: something is on screen, and it names the
    // failure rather than leaving the launch splash as the last word.
    expect(await screen.findByText('CANNOT START')).toBeTruthy()
    await waitFor(() => expect(screen.queryByText(/Load failed/)).toBeTruthy())
    // The app subtree is NOT mounted — a failed boot has no store to render it.
    expect(screen.queryByText('app')).toBeNull()
  })

  it('still reports the failure after the app is backgrounded mid-boot', async () => {
    withUnreachableServer()
    render(
      <MobileClientProvider>
        <div>app</div>
      </MobileClientProvider>,
    )
    // iOS Safari fires this every time the app is sent to the background. Before
    // POD-712 it cleared the boot's liveness flag, so the failure below could
    // never be reported and the splash stayed up forever.
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(await screen.findByText('CANNOT START')).toBeTruthy()
  })

  it('pagehide then pageshow does not start a second boot', async () => {
    withUnreachableServer()
    render(
      <MobileClientProvider>
        <div>app</div>
      </MobileClientProvider>,
    )
    await screen.findByText('CANNOT START')
    const afterFail = fetchCalls
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
      window.dispatchEvent(new Event('pageshow'))
    })
    // Closing IndexedDB on pagehide and reopening on pageshow is the ~60s
    // Safari lock. Foregrounding must keep the existing replica (or the
    // existing failure) and only wake the socket.
    expect(fetchCalls).toBe(afterFail)
  })

  it('retry starts a fresh boot attempt', async () => {
    withUnreachableServer()
    render(
      <MobileClientProvider>
        <div>app</div>
      </MobileClientProvider>,
    )
    await screen.findByText('CANNOT START')
    const before = fetchCalls
    const retry = await screen.findByText('Retry')
    await act(async () => {
      retry.click()
    })
    await waitFor(() => expect(fetchCalls).toBeGreaterThan(before))
  })

  it('keeps a loading surface visible while a retry is in flight', async () => {
    fetchCalls = 0
    vi.stubGlobal('fetch', async () => {
      fetchCalls += 1
      if (fetchCalls === 1) throw new Error('Load failed')
      return new Promise<Response>(() => {})
    })
    render(
      <MobileClientProvider>
        <div>app</div>
      </MobileClientProvider>,
    )
    await screen.findByText('CANNOT START')

    await act(async () => {
      ;(await screen.findByText('Retry')).click()
    })

    await waitFor(() => expect(fetchCalls).toBeGreaterThan(1))
    expect(screen.getByText(/^RETRYING/)).toBeTruthy()
    expect(screen.queryByText('app')).toBeNull()
  })

  it('boots on native, where `window` exists but has no DOM listener methods', async () => {
    // Hermes aliases `window` to the JS global, so `typeof window` is 'object'
    // on a phone — but none of the DOM listener methods exist there. The first
    // Release build on-device died exactly here: an SSR-style existence guard
    // passed and `window.addEventListener('pagehide', …)` was the app's last
    // act. Native's hide/show answers come from the AppState/NetInfo
    // controller instead, so the boot must not touch DOM listeners at all.
    withUnreachableServer()
    const win = window as unknown as Record<string, unknown>
    const originalOS = Platform.OS
    const originalAdd = win.addEventListener
    const originalRemove = win.removeEventListener
    ;(Platform as { OS: string }).OS = 'ios'
    win.addEventListener = undefined
    win.removeEventListener = undefined
    try {
      render(
        <MobileClientProvider>
          <div>app</div>
        </MobileClientProvider>,
      )
      // The mount survives, and the unreachable server surfaces as the ordinary
      // boot failure — not as an unhandled TypeError before the boot even ran.
      expect(await screen.findByText('CANNOT START')).toBeTruthy()
    } finally {
      win.addEventListener = originalAdd
      win.removeEventListener = originalRemove
      ;(Platform as { OS: string }).OS = originalOS
    }
  })
})
