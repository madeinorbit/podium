// @vitest-environment happy-dom
import { referenceState } from '../../../../../tests/worklist/diagnostics/reference-state'
import type { ClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
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
  runtime = useStoreHandle() as ClientRuntime
  pool = useWorklistPool()
  return null
}

async function mount() {
  localStorage.clear()
  window.history.replaceState(null, '', '/')
  pool = null
  const fixture = createSidebarFixture(6, NOW, true, USER)
  fixture.patch('issueProjection', 'synthetic-2', { parentId: 'synthetic-0' })
  fixture.patch('issueProjection', 'synthetic-3', { parentId: 'synthetic-2' })
  fixture.patch('issueProjection', 'synthetic-4', { parentId: 'synthetic-0' })
  fixture.patch('issueProjection', 'synthetic-5', { parentId: 'synthetic-1' })
  render(
    <StoreProvider
      principal={asClientPrincipal(USER)}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={fixture.api}
      createReplicaFn={() => fixture.replica}
      networkEnabled={false}
      onFatalError={message => { throw new Error(message) }}
      attachRuntime={owner => attachWorklistPool(owner, error => { throw error })}
    >
      <ConfirmProvider>
        <Capture />
        <SidebarUnified />
      </ConfirmProvider>
    </StoreProvider>,
  )
  await act(async () => { await referenceState(runtime).refreshRepos() })
  await waitFor(() => expect(pool).not.toBeNull())
  await waitFor(() => expect(screen.getByText('Synthetic task 0')).toBeTruthy())
  return fixture
}

function row(id: string) {
  const body = document.querySelector(`[data-issue-row="${id}"]`)
  expect(body, `mounted real row ${id}`).not.toBeNull()
  return body!.closest('[data-testid="unified-issue-row"]')!
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('updates a mounted ancestor status when a grandchild session asks', async () => {
  const fixture = await mount()
  const ancestor = row('synthetic-0')
  expect(ancestor.textContent).toContain('0/3 subtasks done · 3 stalled')
  await act(async () => {
    fixture.patch('session', 'synthetic-session-3', {
      agentState: { phase: 'idle', idle: { kind: 'question' }, since: new Date(NOW).toISOString() },
    })
  })
  await waitFor(() => expect(ancestor.textContent).toContain('0/3 subtasks done · 2 underway'))
  expect(row('synthetic-0')).toBe(ancestor)
})

it('updates both mounted parent statuses after a child is reparented', async () => {
  const fixture = await mount()
  const oldParent = row('synthetic-0')
  const newParent = row('synthetic-1')
  expect(oldParent.textContent).toContain('0/3 subtasks done')
  expect(newParent.textContent).toContain('0/1 subtask done')
  await act(async () => {
    fixture.patch('issueProjection', 'synthetic-2', { parentId: 'synthetic-1' })
  })
  await waitFor(() => {
    expect(oldParent.textContent).toContain('0/1 subtask done')
    expect(newParent.textContent).toContain('0/3 subtasks done')
  })
  expect(row('synthetic-0')).toBe(oldParent)
  expect(row('synthetic-1')).toBe(newParent)
})
