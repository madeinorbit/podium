import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountView } from './shared'

const trpc = {
  accounts: {
    list: { query: vi.fn() },
    connect: { mutate: vi.fn() },
    disconnect: { mutate: vi.fn() },
  },
}

vi.mock('@/app/store', () => {
  const useStore = () => ({ trpc })
  return {
    useStore,
    useStoreSelector: (selector: (store: unknown) => unknown) => selector(useStore()),
  }
})

const { AccountsSection } = await import('./accounts')

const NATIVE: AccountView = {
  id: 'native:claude-code',
  provider: 'anthropic',
  source: 'native',
  harness: 'claude-code',
  status: 'not-configured',
}
const API_KEY_ROW: AccountView = {
  id: 'managed:anthropic',
  provider: 'anthropic',
  source: 'managed',
  kind: 'api-key',
  status: 'not-configured',
}
const OAUTH_ROW: AccountView = {
  id: 'managed:claude-oauth',
  provider: 'anthropic',
  source: 'managed',
  kind: 'oauth',
  status: 'not-configured',
}

/** accounts.list answers with `first`, then with `then` on every later refetch. */
function serveList(first: AccountView[], then: AccountView[] = first): void {
  let calls = 0
  trpc.accounts.list.query.mockImplementation(async () => (calls++ === 0 ? first : then))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('AccountsSection', () => {
  it('connects a managed API key, masks the input, and refetches so the row flips', async () => {
    const connected: AccountView = { ...API_KEY_ROW, identity: 'sk-a…f9x2', status: 'connected' }
    serveList([NATIVE, API_KEY_ROW], [NATIVE, connected])
    trpc.accounts.connect.mutate.mockResolvedValue({ id: 'managed:anthropic' })
    render(<AccountsSection />)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    const input = screen.getByLabelText('Anthropic API key secret') as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: 'sk-ant-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(trpc.accounts.connect.mutate).toHaveBeenCalledWith({
        provider: 'anthropic',
        kind: 'api-key',
        credential: 'sk-ant-secret',
      }),
    )
    // Refetched, so the row shows the server's masked identity — not local state.
    expect(await screen.findByText('● sk-a…f9x2')).toBeTruthy()
    expect(screen.queryByDisplayValue('sk-ant-secret')).toBeNull()
  })

  it('offers the setup-token affordance on the Claude subscription row only', async () => {
    serveList([API_KEY_ROW, OAUTH_ROW])
    render(<AccountsSection />)

    expect(await screen.findByText('Claude subscription (setup-token)')).toBeTruthy()
    expect(screen.getByText(/long-lived subscription token \(about a year\)/)).toBeTruthy()

    const rows = screen.getAllByRole('button', { name: 'Connect' })
    expect(rows).toHaveLength(2)
    fireEvent.click(rows[1] as HTMLElement)
    fireEvent.change(screen.getByLabelText('Claude subscription (setup-token) secret'), {
      target: { value: 'sk-ant-oat01-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // OAuth is anthropic-only; the api-key row must never send kind 'oauth'.
    await waitFor(() =>
      expect(trpc.accounts.connect.mutate).toHaveBeenCalledWith({
        provider: 'anthropic',
        kind: 'oauth',
        credential: 'sk-ant-oat01-token',
      }),
    )
  })

  it('disconnects a connected managed account and refetches', async () => {
    const connected: AccountView = { ...API_KEY_ROW, identity: 'sk-a…f9x2', status: 'connected' }
    serveList([connected], [API_KEY_ROW])
    trpc.accounts.disconnect.mutate.mockResolvedValue({ ok: true })
    render(<AccountsSection />)

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    await waitFor(() =>
      expect(trpc.accounts.disconnect.mutate).toHaveBeenCalledWith({ id: 'managed:anthropic' }),
    )
    expect(await screen.findByRole('button', { name: 'Connect' })).toBeTruthy()
  })

  it('surfaces a connect failure and keeps the form open', async () => {
    serveList([API_KEY_ROW])
    trpc.accounts.connect.mutate.mockRejectedValue(new Error('bad credential'))
    render(<AccountsSection />)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    fireEvent.change(screen.getByLabelText('Anthropic API key secret'), {
      target: { value: 'nope' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('bad credential')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
  })
})
