// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import { ExistingPodiumActivation, normalizeExistingPodiumUrl } from './ExistingPodiumActivation'

afterEach(() => {
  cleanup()
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

    fireEvent.click(screen.getByRole('button', { name: 'Connect as a client' }))
    expect(onRouteChange).toHaveBeenCalledWith('existing-client')
    fireEvent.click(screen.getByRole('button', { name: 'Join as a machine' }))
    expect(onRouteChange).toHaveBeenCalledWith('existing-machine')
    fireEvent.click(screen.getByRole('button', { name: 'Back to local setup' }))
    expect(onRouteChange).toHaveBeenCalledWith('local-project')
    fireEvent.click(screen.getByRole('button', { name: /Explore Podium/ }))
    expect(onExplore).toHaveBeenCalledOnce()
  })

  it('configures client-only mode with the normalized URL and explains remote login', async () => {
    const connect = vi.fn().mockResolvedValue({})
    const onConfigured = vi.fn().mockResolvedValue(undefined)
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
    fireEvent.change(screen.getByLabelText('Join code'), { target: { value: '  JOIN-CODE  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join and restart' }))

    expect(await screen.findByText(/temporary URL will change/)).toBeTruthy()
    expect(join).toHaveBeenCalledWith({ code: 'JOIN-CODE' })
    expect(onConfigured).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Continue anyway' }))
    await waitFor(() => expect(onConfigured).toHaveBeenCalledOnce())
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

    fireEvent.change(screen.getByLabelText('Join code'), { target: { value: 'JOIN-CODE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join and restart' }))

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Studio Mac is connected — quit and reopen Podium/,
    )
  })
})
