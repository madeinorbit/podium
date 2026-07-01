import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The all-in-one path runs a reachability step that talks to the `setup` tRPC procedures via
// the vanilla client from makeTrpc(). Mock the client so the step resolves without network.
const trpcMock = vi.hoisted(() => ({
  options: vi.fn(),
  commandFor: vi.fn(),
  complete: vi.fn(),
  join: vi.fn(),
  connect: vi.fn(),
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
        join: { mutate: trpcMock.join },
        connect: { mutate: trpcMock.connect },
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

  it('all-in-one requires acknowledgement before finishing reachable setup without a password', async () => {
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
    // Paste the URL; no-password finish remains blocked until the warning is acknowledged.
    fireEvent.change(view.getByLabelText(/public url/i), {
      target: { value: 'https://box.ts.net' },
    })
    expect((view.getByRole('button', { name: /finish/i }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(view.getByText(/I understand that anyone who can reach this Podium URL/i))
    await act(async () => {
      await flush()
    })
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /finish/i }))
      await flush()
    })
    expect(trpcMock.complete).toHaveBeenCalledWith({
      publicUrl: 'https://box.ts.net',
      acknowledgeNoPassword: true,
    })
    expect(onSaved).toHaveBeenCalled()
  })

  it('sends a login password from the reachability step when one is entered', async () => {
    const { container } = render(
      <SetupView httpOrigin="http://localhost:18787" onSaved={() => {}} />,
    )
    const view = within(container)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /continue/i }))
      await flush()
    })
    fireEvent.change(view.getByLabelText(/public url/i), {
      target: { value: 'https://box.ts.net' },
    })
    fireEvent.change(view.getByLabelText(/password/i), { target: { value: 'launch-code' } })
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /finish/i }))
      await flush()
    })
    expect(trpcMock.complete).toHaveBeenCalledWith({
      publicUrl: 'https://box.ts.net',
      password: 'launch-code',
    })
  })

  it('daemon mode takes one join code and applies it via setup.join', async () => {
    const onSaved = vi.fn()
    const { container } = render(
      <SetupView httpOrigin="http://localhost:18787" onSaved={onSaved} />,
    )
    const view = within(container)

    // No join-code field for default all-in-one mode.
    expect(view.queryByLabelText(/join code/i)).toBeNull()

    // Select daemon mode — a single join-code field appears (no separate URL / pair fields).
    fireEvent.click(view.getByRole('radio', { name: /daemon → external server/i }))
    expect(view.getByLabelText(/join code/i)).toBeTruthy()
    expect(view.queryByLabelText(/server url/i)).toBeNull()
    expect(view.queryByLabelText(/pairing code/i)).toBeNull()

    fireEvent.change(view.getByLabelText(/join code/i), { target: { value: 'JOINCODE123' } })
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /save/i }))
      await flush()
    })

    expect(trpcMock.join).toHaveBeenCalledWith({ code: 'JOINCODE123' })
    expect(onSaved).toHaveBeenCalled()
  })

  it('client mode shows a server-url field, no join code', () => {
    const { container } = render(
      <SetupView httpOrigin="http://localhost:18787" onSaved={() => {}} />,
    )
    const view = within(container)
    fireEvent.click(view.getByRole('radio', { name: /client → external server/i }))
    expect(view.getByLabelText(/server url/i)).toBeTruthy()
    expect(view.queryByLabelText(/join code/i)).toBeNull()
  })

  it('client mode applies via setup.connect (not the legacy POST)', async () => {
    const onSaved = vi.fn()
    const { container } = render(
      <SetupView httpOrigin="http://localhost:18787" onSaved={onSaved} />,
    )
    const view = within(container)
    fireEvent.click(view.getByRole('radio', { name: /client → external server/i }))
    fireEvent.change(view.getByLabelText(/server url/i), { target: { value: 'ws://host:18787' } })
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /save/i }))
      await flush()
    })
    expect(trpcMock.connect).toHaveBeenCalledWith({ mode: 'client', serverUrl: 'ws://host:18787' })
    expect(onSaved).toHaveBeenCalled()
  })

  it('server-only mode applies via setup.connect', async () => {
    const onSaved = vi.fn()
    const { container } = render(
      <SetupView httpOrigin="http://localhost:18787" onSaved={onSaved} />,
    )
    const view = within(container)
    fireEvent.click(view.getByRole('radio', { name: /server only/i }))
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /save/i }))
      await flush()
    })
    expect(trpcMock.connect).toHaveBeenCalledWith({ mode: 'server' })
    expect(onSaved).toHaveBeenCalled()
  })
})
