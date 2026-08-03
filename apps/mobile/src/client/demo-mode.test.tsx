/**
 * DEMO MODE STILL WORKS — AND NOW WORKS THROUGH THE PRODUCT'S OWN PATH (POD-332).
 *
 * `?demo=1` used to be a second hand-written `MobileClientValue`: fixtures and
 * no-ops implementing the same 55 fields. That is exactly the shape that lets a
 * design surface and a product surface diverge without anyone noticing — port a
 * screen to a slice and it renders from the slice in the product and from the
 * fixture object in demo, and only one of the two is ever looked at.
 *
 * So the fixtures are ROWS in a memory replica now, under the ordinary
 * `StoreProvider`. This file asserts the thing that makes that worth doing: what
 * demo mode paints comes out of the PUBLISHED SLICE, not out of a fixture
 * object — the same derivation the product and the desktop run.
 */
import { useSlice } from '@podium/client-core/react'
import { worklistSlice } from '@podium/client-core/viewmodels'
import { cleanup, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useConnected, useIssues, useSessions } from './hooks'
import { DEMO_ISSUES, DEMO_SESSIONS, demoEnabled } from './demoData'
import { MobileClientProvider } from './MobileClientProvider'

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
  const slice = useSlice(worklistSlice)
  const sessions = useSessions()
  const issues = useIssues()
  const connected = useConnected()
  return (
    <div>
      <span data-testid="sessions">{String(sessions.length)}</span>
      <span data-testid="issues">{String(issues.length)}</span>
      <span data-testid="slice-rows">
        {String(slice.pinned.length + slice.groups.flatMap((g) => g.rows).length)}
      </span>
      <span data-testid="connected">{String(connected)}</span>
    </div>
  )
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

  it('and the WORKLIST SLICE derives over them — the fixture is data, not a stand-in value', async () => {
    // The discriminating assertion. Counts alone would pass against a provider
    // that handed the screens a fixture list directly; a non-empty published
    // slice can only come from the slice running over replica rows.
    await mountDemo()
    expect(Number(screen.getByTestId('slice-rows').textContent)).toBeGreaterThan(0)
  })

  it('reads as connected, because there is no server it is failing to reach', async () => {
    await mountDemo()
    expect(screen.getByTestId('connected').textContent).toBe('true')
  })
})
