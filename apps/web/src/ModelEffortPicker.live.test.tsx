import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EffortPicker, ModelPicker } from './ModelEffortPicker'

const catalogQuery = vi.fn(async () => ({
  byAgent: {
    grok: [
      { value: 'grok-composer-2.5-fast', label: 'grok-composer-2.5-fast' },
      { value: 'grok-build', label: 'grok-build' },
    ],
    'claude-code': [
      { value: 'claude-opus-4-8', label: 'Opus 4.8', efforts: ['low', 'high', 'xhigh'] },
      { value: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: [] },
    ],
  },
  fetchedAt: 1,
}))
const refreshMutate = vi.fn(async () => ({ byAgent: {}, fetchedAt: 1 }))

vi.mock('./store', () => {
  const useStore = () => ({
    trpc: {
      models: { catalog: { query: catalogQuery }, refresh: { mutate: refreshMutate } },
    },
  })
  // The selector-store hook reads slices off the same store shape.
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

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

describe('EffortPicker follows the selected model', () => {
  it('hides when the model is auto', async () => {
    render(<EffortPicker agentKind="claude-code" model="auto" value="auto" onChange={vi.fn()} />)
    await waitFor(() => expect(catalogQuery).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Effort' })).toBeNull()
  })

  it("shows the selected model's per-model effort levels", async () => {
    render(
      <EffortPicker
        agentKind="claude-code"
        model="claude-opus-4-8"
        value="auto"
        onChange={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Effort' })).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Effort' }))
    expect(await screen.findByRole('menuitem', { name: 'Extra high' })).toBeTruthy()
    // opus-4-8's live efforts are [low,high,xhigh] → no "Max" option.
    expect(screen.queryByRole('menuitem', { name: 'Max' })).toBeNull()
  })

  it('hides for a model that supports no effort (efforts: [])', async () => {
    render(
      <EffortPicker
        agentKind="claude-code"
        model="claude-haiku-4-5"
        value="auto"
        onChange={vi.fn()}
      />,
    )
    await waitFor(() => expect(catalogQuery).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Effort' })).toBeNull()
  })
})
