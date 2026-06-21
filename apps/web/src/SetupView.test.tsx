import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SetupView } from './SetupView'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

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

  it('POSTs the all-in-one mode and calls onSaved', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)
    const onSaved = vi.fn()
    const { container } = render(
      <SetupView httpOrigin="http://localhost:18787" onSaved={onSaved} />,
    )
    const view = within(container)
    // Explicitly select all-in-one to exercise onChange wiring
    fireEvent.click(view.getByRole('radio', { name: /all-in-one/i }))
    const btn = view.getByRole('button', { name: /save/i })
    await act(async () => {
      fireEvent.click(btn)
      await flush()
    })
    expect(fetchMock).toHaveBeenCalled()
    const firstCall = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(firstCall[0]).toBe('http://localhost:18787/setup/config')
    expect(JSON.parse(firstCall[1].body as string)).toMatchObject({ mode: 'all-in-one' })
    expect(onSaved).toHaveBeenCalled()
  })

  it('shows server-url field for daemon mode and POSTs serverUrl', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)
    const onSaved = vi.fn()
    const { container } = render(
      <SetupView httpOrigin="http://localhost:18787" onSaved={onSaved} />,
    )
    const view = within(container)

    // Server-url field must NOT be present for default all-in-one mode
    expect(view.queryByLabelText(/server url/i)).toBeNull()

    // Select daemon mode — field must appear
    // Use exact label-text match to avoid matching "daemons" in other labels' blurbs
    fireEvent.click(view.getByRole('radio', { name: /daemon → external server/i }))
    const urlInput = view.getByLabelText(/server url/i)
    expect(urlInput).toBeTruthy()

    // Fill in a URL
    fireEvent.change(urlInput, { target: { value: 'ws://host:18787' } })

    const btn = view.getByRole('button', { name: /save/i })
    await act(async () => {
      fireEvent.click(btn)
      await flush()
    })

    expect(fetchMock).toHaveBeenCalled()
    const firstCall = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(firstCall[0]).toBe('http://localhost:18787/setup/config')
    expect(JSON.parse(firstCall[1].body as string)).toMatchObject({
      mode: 'daemon',
      serverUrl: 'ws://host:18787',
    })
    expect(onSaved).toHaveBeenCalled()
  })
})
