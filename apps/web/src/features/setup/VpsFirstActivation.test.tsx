// @vitest-environment happy-dom
import { ONBOARDING_VPS_SERVER_DRAFT_KEY } from '@podium/client-core/ui-state'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import type { ConfirmedVpsActivation } from './use-vps-activation'
import {
  normalizeNewVpsUrl,
  probeNewVps,
  VpsFirstActivation,
  vpsChannelOf,
} from './VpsFirstActivation'
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

function trpcWith(
  connect = vi.fn(async () => undefined),
  channel: () => Promise<unknown> = async () => ({ channel: 'edge' }),
): Trpc {
  return Object.assign(() => undefined, {
    setup: {
      channel: { query: vi.fn(channel) },
      connect: { mutate: connect },
    },
  }) as unknown as Trpc
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function renderStep(trpc: Trpc): void {
  render(
    <VpsFirstActivation
      trpc={trpc}
      vps={vpsController()}
      onRouteChange={vi.fn()}
      onConfigured={vi.fn(async () => undefined)}
    />,
  )
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
    expect((await screen.findByText(/setup --vps/)).textContent).not.toContain('--join')
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

/**
 * THE DEFECT (POD-1288): the step rendered a copyable command from a guessed
 * `stable` channel, whose `releases/latest/download/install.sh` 404s while only
 * the edge prerelease is published — a fast copy pasted an install that failed.
 */
describe('the VPS command waits for the channel', () => {
  it('does not turn an unread channel into stable', () => {
    expect(vpsChannelOf(undefined)).toBeUndefined()
    expect(vpsChannelOf({})).toBeUndefined()
    expect(vpsChannelOf({ channel: 'something-new' })).toBeUndefined()
    expect(vpsChannelOf({ channel: 'stable' })).toBe('stable')
    expect(vpsChannelOf({ channel: 'dev' })).toBe('edge')
    expect(vpsChannelOf('edge')).toBe('edge')
  })

  it('offers no command and nothing to copy while the channel is unread', async () => {
    const channel = deferred<unknown>()
    renderStep(
      trpcWith(
        vi.fn(async () => undefined),
        () => channel.promise,
      ),
    )

    expect(screen.getByText(/Reading which release train/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull()
    expect(screen.queryByText(/setup --vps/)).toBeNull()

    channel.resolve({ channel: 'edge' })
    await waitFor(() => expect(screen.getByText(/setup --vps/)).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
  })

  it('never pastes the stable installer while no stable release is published', async () => {
    renderStep(
      trpcWith(
        vi.fn(async () => undefined),
        async () => ({ channel: 'stable' }),
      ),
    )

    const command = await screen.findByText(/setup --vps/)
    expect(command.textContent).not.toContain('/releases/latest/download/install.sh')
    expect(command.textContent).toContain('/releases/download/edge/install.sh')
    expect(command.textContent).toContain('--channel edge')
    // Substituted, never silently: the page says which train it fell back to.
    expect(screen.getByText(/no stable release is published yet/)).toBeTruthy()
  })

  it('says nothing about a substitution when the instance is already on edge', async () => {
    renderStep(
      trpcWith(
        vi.fn(async () => undefined),
        async () => ({ channel: 'edge' }),
      ),
    )

    await screen.findByText(/setup --vps/)
    expect(screen.queryByText(/no stable release is published yet/)).toBeNull()
  })

  it('leaves a failed channel query unread, and reads it again on request', async () => {
    const query = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('server is restarting'))
      .mockResolvedValueOnce({ channel: 'edge' })
    renderStep(
      trpcWith(
        vi.fn(async () => undefined),
        () => query(),
      ),
    )

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.queryByText(/setup --vps/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    await waitFor(() => expect(screen.getByText(/setup --vps/)).toBeTruthy())
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('stays unread when the server answers with a channel it does not recognise', async () => {
    renderStep(
      trpcWith(
        vi.fn(async () => undefined),
        async () => ({ channel: 'nightly' }),
      ),
    )

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.queryByText(/setup --vps/)).toBeNull()
  })
})
