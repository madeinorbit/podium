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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
})
