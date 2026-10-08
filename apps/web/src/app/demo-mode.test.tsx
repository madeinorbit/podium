/**
 * Web demo mode (`?demo=1`) runs the real store over the shared demo fixtures
 * with no server: the sidebar and an issue page paint from demo rows through
 * the same pool the product reads.
 */
import { DEMO_ISSUES, demoEnabled } from '@podium/client-core/demo'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PoolIssuePage } from '@/features/issues/pool-issue-page'
import { SidebarUnified } from '@/features/worklist/SidebarUnified'
import { resetUsageCache } from '@/features/usage/useUsageFeed'
import { demoTrpc, WebDemoProvider } from './demo-mode'
import { StatusPerformanceStats } from './StatusPerformanceStats'

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
  resetUsageCache()
  ;(globalThis as { WebSocket?: unknown }).WebSocket = SilentSocket
  window.history.replaceState({}, '', '/?demo=1')
})

afterEach(() => {
  cleanup()
  resetUsageCache()
  window.history.replaceState({}, '', '/')
  vi.restoreAllMocks()
})

const DEMO_AUTH = DEMO_ISSUES.find((issue) => issue.id === 'demo-issue-auth')!

async function mountDemo(node: React.ReactNode) {
  render(<WebDemoProvider>{node}</WebDemoProvider>)
  // Pool attach is async by design (the graph arrives through a dynamic
  // import) and the demo slice publishes once it has attached, so first
  // paint waits on both. A shared-host CI worker can take seconds.
  await waitFor(() => expect(screen.getByText(DEMO_AUTH.title)).not.toBeNull(), {
    timeout: 15_000,
  })
}

describe('web demo mode', () => {
  it('is only ever entered deliberately', () => {
    expect(demoEnabled()).toBe(true)
    window.history.replaceState({}, '', '/')
    expect(demoEnabled()).toBe(false)
  })

  it('paints the demo work list through the shared pool', async () => {
    await mountDemo(<SidebarUnified />)
    // The rows the work list shows as top-level lanes: the mission root and
    // the three demo issues. (Mission children nest collapsed under the root
    // and proposals follow the product's proposal grouping — same as prod.)
    for (const id of ['demo-mission-root', 'demo-issue-auth', 'demo-issue-header', 'demo-issue-ci']) {
      const issue = DEMO_ISSUES.find((candidate) => candidate.id === id)!
      expect(screen.getByText(issue.title)).not.toBeNull()
    }
  })

  it('paints issue rows with the shell token-burn footer mounted', async () => {
    await mountDemo(
      <>
        <SidebarUnified />
        <StatusPerformanceStats trpc={demoTrpc()} />
      </>,
    )
    await waitFor(() =>
      expect(screen.getByTestId('status-strip-burn').textContent).toBe('measuring token burn'),
    )
  })

  it('paints a demo issue page from the same rows', async () => {
    await mountDemo(
      <PoolIssuePage issueId={DEMO_AUTH.id} orderedIds={[]} onBack={() => {}} onNavigate={() => {}} />,
    )
    expect(screen.getByText(DEMO_AUTH.description)).not.toBeNull()
  })

  it('reaches no server: nothing is fetched from the demo origin', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await mountDemo(<SidebarUnified />)
    expect(fetchSpy.mock.calls.some(([input]) => String(input).includes('demo.invalid'))).toBe(
      false,
    )
  })
})
