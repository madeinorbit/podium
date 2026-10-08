import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import { asUserId } from '@podium/model/browser'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { attachWorklistPool } from '@/app/store-worklist-pool'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { createSidebarFixture } from '../../../test/sidebar-fixture'
import { SidebarUnified } from './SidebarUnified'

vi.mock('@/features/mobile-handoff/MobilePromoCard', () => ({ MobilePromoCard: () => null }))

afterEach(cleanup)

it('renders matching issue content when searching an already expanded repository', async () => {
  localStorage.clear()
  const fixture = createSidebarFixture(40, Date.now(), true, 'search-reader')
  render(
    <StoreProvider
      principal={asClientPrincipal(asUserId('search-reader'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={fixture.api}
      createReplicaFn={() => fixture.replica}
      networkEnabled={false}
      onFatalError={(message) => { throw new Error(message) }}
      attachRuntime={(owner) => attachWorklistPool(owner, (error) => { throw error })}
    >
      <ConfirmProvider><SidebarUnified /></ConfirmProvider>
    </StoreProvider>,
  )
  const group = await screen.findByTestId('project-group')
  expect(group.getAttribute('data-collapsed')).toBe('false')
  await screen.findByText('Only responsive target')
  const panel = screen.getByTestId('project-group-rows')
  fireEvent.change(screen.getByTestId('work-search-input'), { target: { value: 'task 1' } })
  await waitFor(() => expect(screen.getByTestId('work-search-count').textContent).toBe('11/40'))
  await waitFor(() => {
    const rows = [...group.querySelectorAll('[data-window-row]')]
    expect(rows).toHaveLength(11)
    for (const row of rows) expect(row.querySelector('.shell-work-row-title')?.textContent).toMatch(/Synthetic task 1/)
  })
  expect(screen.getByTestId('project-group-rows')).toBe(panel)
})
