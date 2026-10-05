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
import { WebDemoProvider } from './demo-mode'

beforeEach(() => {
  window.history.replaceState({}, '', '/?demo=1')
})

afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', '/')
  vi.restoreAllMocks()
})

const DEMO_AUTH = DEMO_ISSUES.find((issue) => issue.id === 'demo-issue-auth')!

async function mountDemo(node: React.ReactNode) {
  render(<WebDemoProvider>{node}</WebDemoProvider>)
  await waitFor(() => expect(screen.getByText(DEMO_AUTH.title)).not.toBeNull(), {
    timeout: 10_000,
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
    for (const issue of DEMO_ISSUES.slice(0, 3)) {
      expect(screen.getByText(issue.title)).not.toBeNull()
    }
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
