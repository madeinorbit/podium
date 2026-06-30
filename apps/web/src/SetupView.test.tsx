import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The all-in-one path runs a reachability step that talks to the `setup` tRPC procedures via
// the vanilla client from makeTrpc(). Mock the client so the step resolves without network.
const trpcMock = vi.hoisted(() => ({
  options: vi.fn(),
  commandFor: vi.fn(),
  complete: vi.fn(),
}))

vi.mock('./trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./trpc')>()
  return {
    ...actual,
    makeTrpc: () => ({
      setup: {
        options: { query: trpcMock.options },
        commandFor: { query: trpcMock.commandFor },
        complete: { mutate: trpcMock.complete },
      },
    }),
  }
})

import { SetupView } from './SetupView'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => {
  trpcMock.options.mockResolvedValue([
    {
      id: 'tailscale-funnel',
      label: 'Tailscale Funnel (public, recommended)',
      note: 'Reachable from anywhere.',
    },
    { id: 'manual', label: 'Manual reverse proxy', note: 'Paste the https URL.' },
  ])
  trpcMock.commandFor.mockResolvedValue({
    command: 'tailscale funnel 18787',
    hint: 'Then paste the https URL it prints.',
  })
  trpcMock.complete.mockResolvedValue({ mode: 'all-in-one', publicUrl: 'https://box.ts.net' })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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

  it('all-in-one advances to the reachability step and persists the URL via setup.complete', async () => {
    const onSaved = vi.fn()
    const { container } = render(
      <SetupView httpOrigin="http://localhost:18787" onSaved={onSaved} />,
    )
    const view = within(container)
    // all-in-one is the default; advance to the networking step.
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /continue/i }))
      await flush()
    })
    // Options + funnel command loaded from the mocked tRPC client.
    expect(trpcMock.options).toHaveBeenCalled()
    expect(view.getByText('tailscale funnel 18787')).toBeTruthy()
    // Paste the URL and finish.
    fireEvent.change(view.getByLabelText(/public url/i), {
      target: { value: 'https://box.ts.net' },
    })
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /finish/i }))
      await flush()
    })
    expect(trpcMock.complete).toHaveBeenCalledWith({ publicUrl: 'https://box.ts.net' })
    expect(onSaved).toHaveBeenCalled()
  })

  it('shows server-url + pairing-code fields for daemon mode and POSTs both', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)
    const onSaved = vi.fn()
    const { container } = render(
      <SetupView httpOrigin="http://localhost:18787" onSaved={onSaved} />,
    )
    const view = within(container)

    // Fields must NOT be present for default all-in-one mode
    expect(view.queryByLabelText(/server url/i)).toBeNull()
    expect(view.queryByLabelText(/pairing code/i)).toBeNull()

    // Select daemon mode — both fields must appear
    // Use exact label-text match to avoid matching "daemons" in other labels' blurbs
    fireEvent.click(view.getByRole('radio', { name: /daemon → external server/i }))
    const urlInput = view.getByLabelText(/server url/i)
    const pairInput = view.getByLabelText(/pairing code/i)
    expect(urlInput).toBeTruthy()
    expect(pairInput).toBeTruthy()

    // Fill in a URL + pairing code
    fireEvent.change(urlInput, { target: { value: 'ws://host:18787' } })
    fireEvent.change(pairInput, { target: { value: 'ABC123' } })

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
      pairCode: 'ABC123',
    })
    expect(onSaved).toHaveBeenCalled()
  })

  it('client mode shows server url but NOT a pairing code field', () => {
    const { container } = render(
      <SetupView httpOrigin="http://localhost:18787" onSaved={() => {}} />,
    )
    const view = within(container)
    fireEvent.click(view.getByRole('radio', { name: /client → external server/i }))
    expect(view.getByLabelText(/server url/i)).toBeTruthy()
    expect(view.queryByLabelText(/pairing code/i)).toBeNull()
  })
})
