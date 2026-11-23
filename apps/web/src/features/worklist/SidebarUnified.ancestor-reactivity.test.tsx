// @vitest-environment happy-dom

import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useClientRuntime } from '@podium/client-core/react'
import type { ClientRuntime } from '@podium/client-core/runtime-root'
import { asUserId } from '@podium/model/browser'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { attachWorklistPool, useWorklistPool } from '@/app/store-worklist-pool'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { createSidebarFixture } from '../../../test/sidebar-fixture'
import { SidebarUnified } from './SidebarUnified'

vi.mock('@/features/mobile-handoff/MobilePromoCard', () => ({ MobilePromoCard: () => null }))

const NOW = Date.parse('2026-10-06T12:00:00Z')
const USER = asUserId('ancestor-reactivity')
let runtime: ClientRuntime
let pool: ReturnType<typeof useWorklistPool>

function Capture() {
  runtime = useClientRuntime() as ClientRuntime
  pool = useWorklistPool()
  return null
}

async function mount() {
  localStorage.clear()
  window.history.replaceState(null, '', '/')
  pool = null
  const fixture = createSidebarFixture(8, NOW, true, USER)
  fixture.patch('issueProjection', 'synthetic-2', { parentId: 'synthetic-0' })
  fixture.patch('issueProjection', 'synthetic-3', { parentId: 'synthetic-2' })
  fixture.patch('issueProjection', 'synthetic-4', { parentId: 'synthetic-0' })
  fixture.patch('issueProjection', 'synthetic-5', { parentId: 'synthetic-1' })
  // Three leaf work units under the old parent, two under the new one.
  // The intermediate task is a branch, rather than another work unit.
  fixture.patch('issueProjection', 'synthetic-6', { parentId: 'synthetic-0' })
  fixture.patch('issueProjection', 'synthetic-7', { parentId: 'synthetic-1' })
  fixture.patch('session', 'synthetic-session-3', {
    agentState: { phase: 'working', since: new Date(NOW - 60_000).toISOString() },
  })
  render(
    <StoreProvider
      principal={asClientPrincipal(USER)}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={fixture.api}
      createReplicaFn={() => fixture.replica}
      networkEnabled={false}
      onFatalError={(message) => {
        throw new Error(message)
      }}
      attachRuntime={(owner) =>
        attachWorklistPool(owner, (error) => {
          throw error
        })
      }
    >
      <ConfirmProvider>
        <Capture />
        <SidebarUnified />
      </ConfirmProvider>
    </StoreProvider>,
  )
  await waitFor(() => expect(pool).not.toBeNull())
  await waitFor(() => expect(screen.getByText('Synthetic task 0')).toBeTruthy())
  return fixture
}

function row(id: string) {
  const body = document.querySelector(`[data-issue-row="${id}"]`)
  expect(body, `mounted real row ${id}`).not.toBeNull()
  return body!.closest('[data-testid="unified-issue-row"]')!
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('updates a mounted ancestor status when a grandchild session asks', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  const fixture = await mount()
  const ancestor = row('synthetic-0')
  expect(ancestor.querySelector('[title^="Working since"]')?.textContent).toContain('1:00')
  await act(async () => {
    fixture.patch('session', 'synthetic-session-3', {
      agentState: { phase: 'idle', idle: { kind: 'question' }, since: new Date(NOW).toISOString() },
    })
  })
  await waitFor(() =>
    expect(ancestor.querySelector('[title^="Waiting since"]')?.textContent).toBe('now'),
  )
  expect(ancestor.querySelector('[data-phase="waiting"]')).not.toBeNull()
  expect(row('synthetic-0')).toBe(ancestor)
})

it('updates both mounted parent statuses after a child is reparented', async () => {
  const fixture = await mount()
  const oldParent = row('synthetic-0')
  const newParent = row('synthetic-1')
  // The calm row tallies two or more subtasks; a lone one says nothing.
  expect(oldParent.textContent).toContain('0/3')
  expect(newParent.textContent).not.toContain('0/3')
  await act(async () => {
    fixture.patch('issueProjection', 'synthetic-2', { parentId: 'synthetic-1' })
  })
  await waitFor(() => {
    expect(oldParent.textContent).not.toContain('0/3')
    expect(newParent.textContent).toContain('0/3')
  })
  expect(row('synthetic-0')).toBe(oldParent)
  expect(row('synthetic-1')).toBe(newParent)
})
