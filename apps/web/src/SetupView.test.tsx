import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SetupView } from './SetupView'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('SetupView', () => {
  it('renders the four deployment modes', () => {
    render(<SetupView httpOrigin="http://localhost:18787" onSaved={() => {}} />)
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(4)
    expect(screen.getByText(/all-in-one/i)).toBeTruthy()
    expect(screen.getByText(/^daemon/i)).toBeTruthy()
    expect(screen.getByText(/^client/i)).toBeTruthy()
    expect(screen.getByText(/^server only/i)).toBeTruthy()
  })

  it('POSTs the selected mode and calls onSaved', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)
    const onSaved = vi.fn()
    // Use container-scoped queries to avoid stale DOM from prior renders
    const { container } = render(
      <SetupView httpOrigin="http://localhost:18787" onSaved={onSaved} />,
    )
    const view = within(container)
    const btn = view.getByRole('button')
    await act(async () => {
      fireEvent.click(btn)
      await new Promise((r) => setTimeout(r, 200))
    })
    expect(fetchMock).toHaveBeenCalled()
    const firstCall = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(firstCall[0]).toBe('http://localhost:18787/setup/config')
    expect(JSON.parse(firstCall[1].body as string)).toMatchObject({ mode: 'all-in-one' })
    expect(onSaved).toHaveBeenCalled()
  })
})
