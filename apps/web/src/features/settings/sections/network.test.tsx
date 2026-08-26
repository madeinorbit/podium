import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '@/app/store'

const storeState = {
  trpc: {} as Store['trpc'],
}

vi.mock('@/app/store', () => ({
  useStoreSelector: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}))

import { NetworkSection } from './network'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('NetworkSection', () => {
  it('shows the saved network settings without a separate disclosure step', async () => {
    storeState.trpc = {
      setup: {
        info: {
          query: vi.fn().mockResolvedValue({
            mode: 'all-in-one',
            publicUrl: 'https://box.tail.ts.net',
            networkOption: 'tailscale-serve',
            serverUrl: null,
          }),
        },
        options: {
          query: vi.fn().mockResolvedValue([
            {
              id: 'tailscale-serve',
              label: 'Tailscale Serve (private)',
              note: 'Reachable only from devices on your tailnet.',
            },
          ]),
        },
        commandFor: {
          query: vi.fn().mockResolvedValue({
            command: 'tailscale serve 18787',
            hint: 'Then paste the URL it prints.',
          }),
        },
        complete: { mutate: vi.fn().mockResolvedValue({ mode: 'all-in-one' }) },
      },
      auth: {
        status: { query: vi.fn().mockResolvedValue({ hasOwnCredential: true }) },
      },
    } as unknown as Store['trpc']

    render(<NetworkSection />)

    const selected = (await screen.findByRole('radio', {
      name: /tailscale serve/i,
    })) as HTMLInputElement
    expect(selected.checked).toBe(true)
    expect(screen.getByLabelText('Podium URL')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save network settings' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /change|set up/i })).toBeNull()
  })
})
