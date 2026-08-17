// @vitest-environment happy-dom
import { ONBOARDING_VPS_SERVER_DRAFT_KEY } from '@podium/client-core/ui-state'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import type { ConfirmedVpsActivation } from './use-vps-activation'
import { normalizeNewVpsUrl, probeNewVps, VpsFirstActivation } from './VpsFirstActivation'
import { vpsIntroState } from './vps-activation'

const uiValues = new Map<string, string>()
const uiSet = vi.fn((key: string, value: string | null) => {
  if (value === null) uiValues.delete(key)
  else uiValues.set(key, value)
})
const uiState = {
  get: (key: string) => uiValues.get(key) ?? null,
  set: uiSet,
}

vi.mock('@/app/store', () => ({
  useStoreSelector: (selector: (store: { uiState: typeof uiState }) => unknown) =>
    selector({ uiState }),
}))

afterEach(() => {
  cleanup()
  uiValues.clear()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

function trpcWith(connect = vi.fn(async () => undefined)): Trpc {
  return Object.assign(() => undefined, {
    setup: {
      channel: { query: vi.fn(async () => ({ channel: 'stable' })) },
      connect: { mutate: connect },
    },
  }) as unknown as Trpc
}

function vpsController(clear = vi.fn(async () => undefined)): ConfirmedVpsActivation {
  return {
    state: vpsIntroState('vps-choice'),
    ready: true,
    saving: false,
    error: null,
    persist: vi.fn(),
    clear,
  }
}

describe('fresh VPS activation', () => {
  it('normalizes the printed origin for both the readiness probe and client transport', () => {
    expect(normalizeNewVpsUrl(' https://podium.example.com/path ')).toEqual({
      serverUrl: 'wss://podium.example.com',
      httpOrigin: 'https://podium.example.com',
    })
    expect(normalizeNewVpsUrl('not a server')).toBeNull()
  })

  it('requires the VPS setup to finish before changing this desktop', async () => {
    await expect(
      probeNewVps('https://vps.example.com', async () =>
        response({ state: 'unconfigured', reason: 'setup_required', dataPlane: 'blocked' }),
      ),
    ).rejects.toThrow('terminal setup is not finished')

    await expect(
      probeNewVps('https://vps.example.com', async () =>
        response({
          state: 'degraded',
          reason: 'configuration_invalid',
          dataPlane: 'available',
        }),
      ),
    ).rejects.toThrow('configuration needs repair')
  })

  it('connects the desktop only after a current ready VPS answers', async () => {
    const connect = vi.fn(async () => undefined)
    const clear = vi.fn(async () => undefined)
    const onConfigured = vi.fn(async () => undefined)
    const request = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(response({ state: 'ready', reason: null, dataPlane: 'available' }))

    render(
      <VpsFirstActivation
        trpc={trpcWith(connect)}
        vps={vpsController(clear)}
        onRouteChange={vi.fn()}
        onConfigured={onConfigured}
      />,
    )

    expect(
      screen.getByText(/Nothing on this computer is exposed, paired, or transferred/),
    ).toBeTruthy()
    expect(screen.getByText(/setup --vps/).textContent).not.toContain('--join')
    fireEvent.change(screen.getByLabelText('New VPS Podium URL'), {
      target: { value: 'https://vps.example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect to VPS' }))

    await waitFor(() => expect(onConfigured).toHaveBeenCalledOnce())
    expect(request).toHaveBeenCalledWith('https://vps.example.com/readiness')
    expect(connect).toHaveBeenCalledWith({ mode: 'client', serverUrl: 'wss://vps.example.com' })
    expect(uiSet).toHaveBeenLastCalledWith(ONBOARDING_VPS_SERVER_DRAFT_KEY, null)
    expect(clear.mock.invocationCallOrder[0]).toBeLessThan(
      onConfigured.mock.invocationCallOrder[0]!,
    )
  })
})
