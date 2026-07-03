import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelPicker } from './ModelEffortPicker'

const catalogQuery = vi.fn(async () => ({
  byAgent: {
    grok: [
      { value: 'grok-composer-2.5-fast', label: 'grok-composer-2.5-fast' },
      { value: 'grok-build', label: 'grok-build' },
    ],
  },
  fetchedAt: 1,
}))
const refreshMutate = vi.fn(async () => ({ byAgent: {}, fetchedAt: 1 }))

vi.mock('./store', () => ({
  useStore: () => ({
    trpc: {
      models: { catalog: { query: catalogQuery }, refresh: { mutate: refreshMutate } },
    },
  }),
}))

afterEach(() => {
  cleanup()
  catalogQuery.mockClear()
  refreshMutate.mockClear()
})

describe('ModelPicker live catalog', () => {
  it('fetches the live catalog and shows the agent CLI models for a probeable agent', async () => {
    render(<ModelPicker agentKind="grok" value="auto" onChange={vi.fn()} />)
    await waitFor(() => expect(catalogQuery).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    // Live models from the server, not a static grok fallback entry.
    expect(await screen.findByRole('menuitem', { name: 'grok-composer-2.5-fast' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'grok-build' })).toBeTruthy()
    // A non-probeable server response for cursor was empty → no refresh needed here.
    expect(refreshMutate).not.toHaveBeenCalled()
  })

  it('selecting a live model reports its value', async () => {
    const onChange = vi.fn()
    render(<ModelPicker agentKind="grok" value="auto" onChange={onChange} />)
    await waitFor(() => expect(catalogQuery).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'grok-build' }))
    expect(onChange).toHaveBeenCalledWith('grok-build')
  })
})
