// @vitest-environment happy-dom
import {
  EXISTING_PODIUM_CLIENT_DRAFT_KEY,
  EXISTING_PODIUM_MACHINE_DRAFT_KEY,
} from '@podium/client-core/ui-state'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import {
  existingPodiumJoinToken,
  ExistingPodiumActivation,
  normalizeExistingPodiumUrl,
} from './ExistingPodiumActivation'

const MACHINE_PAIRING_TOKEN =
  'eyJ2IjoxLCJzZXJ2ZXJVcmwiOiJ3c3M6Ly9wb2RpdW0uZXhhbXBsZS5jb20iLCJwYWlyQ29kZSI6IlBBSVItQ09ERSJ9'
const MACHINE_PAIRING_COMMAND =
  'sh -c \'set -eu; sh "$1" "$@"\' sh https://github.com/madeinorbit/podium/releases/latest/download/install.sh --channel stable --agents codex,claude-code,grok --managed --join ' +
  MACHINE_PAIRING_TOKEN

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
})

function trpcWith({
  connect = vi.fn(),
  join = vi.fn(),
}: {
  connect?: ReturnType<typeof vi.fn>
  join?: ReturnType<typeof vi.fn>
} = {}): Trpc {
  return {
    setup: {
      connect: { mutate: connect },
      join: { mutate: join },
    },
  } as unknown as Trpc
}

describe('existing Podium activation', () => {
  it('normalizes every supported remote URL through the transport parser', () => {
    expect(normalizeExistingPodiumUrl(' https://podium.example.com/path ')).toBe(
      'wss://podium.example.com',
    )
    expect(normalizeExistingPodiumUrl('ws://host.test:18787')).toBe('ws://host.test:18787')
    expect(normalizeExistingPodiumUrl('ftp://host.test')).toBeNull()
  })

  it('extracts the MachinePairing join token without evaluating the command', () => {
    expect(existingPodiumJoinToken(MACHINE_PAIRING_COMMAND)).toBe(MACHINE_PAIRING_TOKEN)
    expect(existingPodiumJoinToken('RAW-TOKEN')).toBe('RAW-TOKEN')
    expect(existingPodiumJoinToken('sh install.sh --join first --join second')).toBeNull()
  })

  it('keeps local setup and exploration available from the connection choice', () => {
    const onRouteChange = vi.fn()
    const onExplore = vi.fn()
    render(
      <ExistingPodiumActivation
        route="existing-podium"
        trpc={trpcWith()}
        onRouteChange={onRouteChange}
        onExplore={onExplore}
        onConfigured={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Use as a client' }))
    expect(onRouteChange).toHaveBeenCalledWith('existing-client')
    fireEvent.click(screen.getByRole('button', { name: 'Add this machine' }))
    expect(onRouteChange).toHaveBeenCalledWith('existing-machine')
    fireEvent.click(screen.getByRole('button', { name: 'Back to activation choices' }))
    expect(onRouteChange).toHaveBeenCalledWith('welcome')
    fireEvent.click(screen.getByRole('button', { name: /Explore Podium/ }))
    expect(onExplore).toHaveBeenCalledOnce()
  })

  it('returns from a connection form to the activation choices, not repository intake', () => {
    const onRouteChange = vi.fn()
    render(
      <ExistingPodiumActivation
        route="existing-client"
        trpc={trpcWith()}
        onRouteChange={onRouteChange}
        onExplore={vi.fn()}
        onConfigured={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Back to activation choices' }))
    expect(onRouteChange).toHaveBeenCalledWith('welcome')
  })

  it('configures client-only mode with the normalized URL and explains remote login', async () => {
    const connect = vi.fn().mockResolvedValue({})
    const onConfigured = vi.fn(async () => {
      expect(uiValues.has(EXISTING_PODIUM_CLIENT_DRAFT_KEY)).toBe(false)
    })
    render(
      <ExistingPodiumActivation
        route="existing-client"
        trpc={trpcWith({ connect })}
        onRouteChange={vi.fn()}
        onExplore={vi.fn()}
        onConfigured={onConfigured}
      />,
    )

    expect(screen.getByText(/requires a password/)).toBeTruthy()
    expect(screen.getByText(/No agents run on this device/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Existing Podium URL'), {
      target: { value: 'https://remote.example.com/workspace' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save and restart' }))

    await waitFor(() =>
      expect(connect).toHaveBeenCalledWith({
        mode: 'client',
        serverUrl: 'wss://remote.example.com',
      }),
    )
    await waitFor(() => expect(onConfigured).toHaveBeenCalledOnce())
    expect(uiSet).toHaveBeenLastCalledWith(EXISTING_PODIUM_CLIENT_DRAFT_KEY, null)
  })

  it('restores the client URL after Explore or reload and keeps it when configuration fails', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('remote unavailable'))
    const onExplore = vi.fn()
    const first = render(
      <ExistingPodiumActivation
        route="existing-client"
        trpc={trpcWith({ connect })}
        onRouteChange={vi.fn()}
        onExplore={onExplore}
        onConfigured={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('Existing Podium URL'), {
      target: { value: 'https://saved.example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Explore Podium/ }))
    expect(onExplore).toHaveBeenCalledOnce()
    expect(uiValues.get(EXISTING_PODIUM_CLIENT_DRAFT_KEY)).toBe('https://saved.example.com')

    first.unmount()
    render(
      <ExistingPodiumActivation
        route="existing-client"
        trpc={trpcWith({ connect })}
        onRouteChange={vi.fn()}
        onExplore={vi.fn()}
        onConfigured={vi.fn()}
      />,
    )
    expect((screen.getByLabelText('Existing Podium URL') as HTMLInputElement).value).toBe(
      'https://saved.example.com',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save and restart' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/remote unavailable/)
    expect(uiValues.get(EXISTING_PODIUM_CLIENT_DRAFT_KEY)).toBe('https://saved.example.com')
  })

  it('rejects an invalid client URL before changing local configuration', async () => {
    const connect = vi.fn()
    render(
      <ExistingPodiumActivation
        route="existing-client"
        trpc={trpcWith({ connect })}
        onRouteChange={vi.fn()}
        onExplore={vi.fn()}
        onConfigured={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('Existing Podium URL'), {
      target: { value: 'not a URL' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save and restart' }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/http:\/\//)
    expect(connect).not.toHaveBeenCalled()
  })

  it('applies a join code and pauses for a temporary-URL warning before restarting', async () => {
    const join = vi.fn().mockResolvedValue({
      name: 'Studio Mac',
      warning: 'This temporary URL will change when its tunnel restarts.',
    })
    const onConfigured = vi.fn().mockResolvedValue(undefined)
    render(
      <ExistingPodiumActivation
        route="existing-machine"
        trpc={trpcWith({ join })}
        onRouteChange={vi.fn()}
        onExplore={vi.fn()}
        onConfigured={onConfigured}
      />,
    )

    expect(screen.getByText(/single-use machine credential/)).toBeTruthy()
    expect(screen.getByText(/human access still follows/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Join token or command'), {
      target: { value: '  JOIN-CODE  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Join and restart' }))

    expect(await screen.findByText(/temporary URL will change/)).toBeTruthy()
    expect(join).toHaveBeenCalledWith({ code: 'JOIN-CODE' })
    expect(uiSet).toHaveBeenCalledWith(EXISTING_PODIUM_MACHINE_DRAFT_KEY, null)
    expect(onConfigured).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Continue anyway' }))
    await waitFor(() => expect(onConfigured).toHaveBeenCalledOnce())
  })

  it('accepts the complete MachinePairing command and restores it until joining succeeds', async () => {
    const command = MACHINE_PAIRING_COMMAND
    const expectedToken = MACHINE_PAIRING_TOKEN
    const failedJoin = vi.fn().mockRejectedValue(new Error('pairing expired'))
    const onExplore = vi.fn()
    const first = render(
      <ExistingPodiumActivation
        route="existing-machine"
        trpc={trpcWith({ join: failedJoin })}
        onRouteChange={vi.fn()}
        onExplore={onExplore}
        onConfigured={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('Join token or command'), {
      target: { value: command },
    })
    fireEvent.click(screen.getByRole('button', { name: /Explore Podium/ }))
    expect(onExplore).toHaveBeenCalledOnce()
    expect(uiValues.get(EXISTING_PODIUM_MACHINE_DRAFT_KEY)).toBe(command)
    first.unmount()

    const failed = render(
      <ExistingPodiumActivation
        route="existing-machine"
        trpc={trpcWith({ join: failedJoin })}
        onRouteChange={vi.fn()}
        onExplore={vi.fn()}
        onConfigured={vi.fn()}
      />,
    )
    expect((screen.getByLabelText('Join token or command') as HTMLInputElement).value).toBe(command)
    fireEvent.click(screen.getByRole('button', { name: 'Join and restart' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/pairing expired/)
    expect(uiValues.get(EXISTING_PODIUM_MACHINE_DRAFT_KEY)).toBe(command)
    failed.unmount()

    const join = vi.fn().mockResolvedValue({ name: 'Studio Mac' })
    render(
      <ExistingPodiumActivation
        route="existing-machine"
        trpc={trpcWith({ join })}
        onRouteChange={vi.fn()}
        onExplore={vi.fn()}
        onConfigured={vi.fn().mockResolvedValue(undefined)}
      />,
    )
    expect((screen.getByLabelText('Join token or command') as HTMLInputElement).value).toBe(command)
    fireEvent.click(screen.getByRole('button', { name: 'Join and restart' }))

    await waitFor(() => expect(join).toHaveBeenCalledWith({ code: expectedToken }))
    expect(uiSet).toHaveBeenLastCalledWith(EXISTING_PODIUM_MACHINE_DRAFT_KEY, null)
  })

  it('surfaces manual-relaunch guidance after configuration is already saved', async () => {
    const join = vi.fn().mockResolvedValue({ name: 'Studio Mac' })
    render(
      <ExistingPodiumActivation
        route="existing-machine"
        trpc={trpcWith({ join })}
        onRouteChange={vi.fn()}
        onExplore={vi.fn()}
        onConfigured={vi.fn().mockRejectedValue(new Error('restart unavailable'))}
      />,
    )

    fireEvent.change(screen.getByLabelText('Join token or command'), {
      target: { value: 'JOIN-CODE' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Join and restart' }))

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Studio Mac is connected — quit and reopen Podium/,
    )
    expect(uiSet).toHaveBeenLastCalledWith(EXISTING_PODIUM_MACHINE_DRAFT_KEY, null)
  })
})
