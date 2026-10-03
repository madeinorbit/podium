/** Demo uses the same pool host and provider-owned fixture replica as the
 * product. These literal counts and connectivity expectations are the final
 * green demo controls, with only their legacy read arm retired. */

import type { MobxPool } from '@podium/client-graph/pool'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The demo never opens persisted storage. Mock the native CommonJS package so
// importing the shared composition root does not make Node parse RN's Flow
// entrypoint before the provider can select DemoProvider.
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getAllKeys: async () => [],
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}))
// DemoProvider deliberately bypasses server selection. Model that production
// branch at its optional-profile seam without loading Expo Router's externalized
// CJS graph, whose direct React Native require bypasses Vite's web alias.
vi.mock('./ServerProfileGate', () => ({ useOptionalServerProfile: () => null }))

import { DEMO_ISSUES, DEMO_SESSIONS, demoEnabled } from './demoData'
import { useConnected, useIssues, useSessions } from './hooks'
import { MobileClientProvider } from './MobileClientProvider'
import { useMobilePoolProjection } from './mobile-pool'

/** The runtime opens a socket on start; nothing here is about the transport,
 *  and the real one takes the worker down with an unhandled error event. */
class SilentSocket {
  readyState = 0
  send(): void {}
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

beforeEach(() => {
  ;(globalThis as { WebSocket?: unknown }).WebSocket = SilentSocket
  window.history.replaceState({}, '', '/?demo=1')
})

afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', '/')
})

function DemoProbe() {
  const rowCount = useMobilePoolProjection(readRowCount, 0)
  const sessions = useSessions()
  const issues = useIssues()
  const connected = useConnected()
  return (
    <div>
      <span data-testid="sessions">{String(sessions.length)}</span>
      <span data-testid="issues">{String(issues.length)}</span>
      <span data-testid="slice-rows">
        {String(rowCount)}
      </span>
      <span data-testid="connected">{String(connected)}</span>
    </div>
  )
}

function readRowCount(pool: MobxPool) {
  return pool.mobileWork.sections().sections.reduce((count, section) => count + section.data.length, 0)
}

async function mountDemo() {
  const result = render(
    <MobileClientProvider>
      <DemoProbe />
    </MobileClientProvider>,
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  await waitFor(() => expect(screen.getByTestId('sessions').textContent).toBe(String(DEMO_SESSIONS.length)))
  return result
}

describe('demo fixtures under the real store', () => {
  it('is only ever entered deliberately', () => {
    expect(demoEnabled()).toBe(true)
    window.history.replaceState({}, '', '/')
    expect(demoEnabled()).toBe(false)
  })

  it('paints the fixture sessions and issues through the shared store', async () => {
    await mountDemo()
    expect(screen.getByTestId('sessions').textContent).toBe(String(DEMO_SESSIONS.length))
    expect(screen.getByTestId('issues').textContent).toBe(String(DEMO_ISSUES.length))
  })

  it('paints the fixture rows through the pool', async () => {
    await mountDemo()
    expect(Number(screen.getByTestId('slice-rows').textContent)).toBeGreaterThan(0)
  })

  it('reads as connected, because there is no server it is failing to reach', async () => {
    await mountDemo()
    expect(screen.getByTestId('connected').textContent).toBe('true')
  })
})
