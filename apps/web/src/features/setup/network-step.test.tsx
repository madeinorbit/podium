import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import { NetworkStep, networkStepInitialState } from './network-step'

/**
 * THE THREE FAILURES THIS STEP HAD (POD-1148), all of them about credentials rather than
 * about networking:
 *
 *   1. It sent `password.trim()` while `/auth/login` verifies and `auth.setPassword` hashes the
 *      raw string, so a pasted password with a leading or trailing space became unenterable.
 *   2. Storing a password closes the /trpc guard and evaporates this device's open-mode
 *      principal, so `onSaved()`'s reload 401'd on a URL write that had already committed.
 *   3. It rendered before `auth.status` resolved with `authMode` guessed as 'password', and
 *      threw away whatever had been typed into that box when the query flipped it to 'keep';
 *      the URL field opened blank however the instance was already configured.
 */
function fakeTrpc(
  overrides: {
    publicUrl?: string | null
    networkOption?: 'tailscale-funnel' | 'tailscale-serve' | 'cloudflare-tunnel' | 'manual' | null
    hasOwnCredential?: boolean
    complete?: ReturnType<typeof vi.fn>
  } = {},
) {
  const complete = overrides.complete ?? vi.fn().mockResolvedValue({ mode: 'all-in-one' })
  return {
    setup: {
      info: {
        query: vi.fn().mockResolvedValue({
          publicUrl: overrides.publicUrl ?? null,
          networkOption: overrides.networkOption ?? null,
        }),
      },
      options: {
        query: vi.fn().mockResolvedValue([
          { id: 'tailscale-funnel', label: 'Tailscale Funnel', note: 'Reachable anywhere.' },
          { id: 'manual', label: 'Manual reverse proxy', note: 'Paste the https URL.' },
        ]),
      },
      commandFor: {
        query: vi.fn().mockResolvedValue({ command: 'tailscale funnel 18787', hint: 'Paste it.' }),
      },
      complete: { mutate: complete },
    },
    auth: {
      status: {
        query: vi.fn().mockResolvedValue({ hasOwnCredential: overrides.hasOwnCredential ?? false }),
      },
    },
  } as unknown as Trpc
}

const stubFetch = (): ReturnType<typeof vi.fn> => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('networkStepInitialState', () => {
  it('seeds the URL from the saved config and preselects no option for it', () => {
    expect(
      networkStepInitialState({ publicUrl: 'https://box.tail.ts.net' }, { hasOwnCredential: true }),
    ).toEqual({ url: 'https://box.tail.ts.net', option: null, hasPassword: true })
  })

  it('on a fresh instance opens blank on the recommended option', () => {
    expect(networkStepInitialState({ publicUrl: null }, { hasOwnCredential: false })).toEqual({
      url: '',
      option: 'tailscale-funnel',
      hasPassword: false,
    })
  })

  it('degrades to a blank form when neither query could answer', () => {
    expect(networkStepInitialState(null, null)).toEqual({
      url: '',
      option: 'tailscale-funnel',
      hasPassword: false,
    })
  })
})

describe('NetworkStep', () => {
  it('seeds the URL input from the instance’s saved publicUrl', async () => {
    render(
      <NetworkStep
        embedded
        trpc={fakeTrpc({ publicUrl: 'https://box.tail.ts.net' })}
        onSaved={vi.fn()}
      />,
    )
    const input = (await screen.findByLabelText(/podium url/i)) as HTMLInputElement
    expect(input.value).toBe('https://box.tail.ts.net')
  })

  it('does not guess an exposure option for an older saved URL', async () => {
    render(
      <NetworkStep
        embedded
        trpc={fakeTrpc({ publicUrl: 'https://box.tail.ts.net' })}
        onSaved={vi.fn()}
      />,
    )
    expect(await screen.findByText(/choose how this url is exposed/i)).toBeTruthy()
    for (const radio of await screen.findAllByRole('radio', { name: /tailscale|reverse proxy/i })) {
      expect((radio as HTMLInputElement).checked).toBe(false)
    }
  })

  it('sends the password exactly as typed, surrounding whitespace and all', async () => {
    stubFetch()
    const trpc = fakeTrpc()
    render(<NetworkStep embedded trpc={trpc} onSaved={vi.fn()} />)
    fireEvent.change(await screen.findByLabelText(/podium url/i), {
      target: { value: 'https://box.tail.ts.net' },
    })
    fireEvent.change(screen.getByLabelText(/^login password$/i), { target: { value: ' spaced ' } })
    fireEvent.click(screen.getByRole('button', { name: /save network settings/i }))
    await waitFor(() =>
      expect(trpc.setup.complete.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ password: ' spaced ' }),
      ),
    )
  })

  it('logs in with the new password so the guard it just closed cannot lock this device out', async () => {
    const fetchMock = stubFetch()
    const onSaved = vi.fn()
    render(<NetworkStep embedded trpc={fakeTrpc()} onSaved={onSaved} />)
    fireEvent.change(await screen.findByLabelText(/podium url/i), {
      target: { value: 'https://box.tail.ts.net' },
    })
    fireEvent.change(screen.getByLabelText(/^login password$/i), { target: { value: 'hunter2' } })
    fireEvent.click(screen.getByRole('button', { name: /save network settings/i }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/auth/login'),
      expect.objectContaining({
        credentials: 'include',
        body: JSON.stringify({ password: 'hunter2' }),
      }),
    )
  })

  /** Keeping the existing password changes no credential, so there is no guard to re-enter. */
  it('does not re-login when the existing password is kept', async () => {
    const fetchMock = stubFetch()
    const onSaved = vi.fn()
    render(
      <NetworkStep
        embedded
        trpc={fakeTrpc({ publicUrl: 'https://old.tail.ts.net', hasOwnCredential: true })}
        onSaved={onSaved}
      />,
    )
    const keep = (await screen.findByRole('radio', {
      name: /keep current password/i,
    })) as HTMLInputElement
    expect(keep.checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /save network settings/i }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /**
   * The dropped-keystrokes race. Nothing renders until `auth.status` has answered, so there is
   * no window in which the password box exists on a guessed mode — the old code showed it
   * immediately and reset `authMode` to 'keep' underneath whatever had been typed.
   */
  it('shows no password box until auth.status has answered', () => {
    const trpc = fakeTrpc({ hasOwnCredential: true })
    render(<NetworkStep embedded trpc={trpc} onSaved={vi.fn()} />)
    expect(screen.queryByLabelText(/login password/i)).toBeNull()
    expect(screen.getByText(/loading/i)).toBeTruthy()
  })

  it('restores and persists the selected network method', async () => {
    const complete = vi.fn().mockResolvedValue({ mode: 'all-in-one' })
    const trpc = fakeTrpc({
      publicUrl: 'https://box.tail.ts.net',
      networkOption: 'tailscale-serve',
      hasOwnCredential: true,
      complete,
    })
    render(<NetworkStep embedded trpc={trpc} onSaved={vi.fn()} />)

    const serve = (await screen.findByRole('radio', {
      name: /tailscale serve/i,
    })) as HTMLInputElement
    expect(screen.getByRole('status').textContent).toBe('')
    expect(serve.checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /save network settings/i }))

    await waitFor(() =>
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({ networkOption: 'tailscale-serve' }),
      ),
    )
    expect(await screen.findByText('Network settings saved.')).toBeTruthy()
  })
})
