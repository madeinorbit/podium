import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoginGate, LoginView } from './LoginGate'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const child = <div>APP-READY</div>

function statusFetch(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body })
}

describe('LoginGate', () => {
  it('renders the app when no password is required (open mode)', async () => {
    vi.stubGlobal('fetch', statusFetch({ needsAuth: false, authed: false }))
    render(<LoginGate>{child}</LoginGate>)
    expect(await screen.findByText('APP-READY')).toBeTruthy()
  })

  it('shows the login form when auth is required and not yet authed', async () => {
    vi.stubGlobal('fetch', statusFetch({ needsAuth: true, authed: false }))
    render(<LoginGate>{child}</LoginGate>)
    expect(await screen.findByLabelText(/password/i)).toBeTruthy()
    expect(screen.queryByText('APP-READY')).toBeNull()
  })

  it('renders the app when already authed', async () => {
    vi.stubGlobal('fetch', statusFetch({ needsAuth: true, authed: true }))
    render(<LoginGate>{child}</LoginGate>)
    expect(await screen.findByText('APP-READY')).toBeTruthy()
  })

  it('does not block on a backend without the auth route (non-OK status)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    )
    render(<LoginGate>{child}</LoginGate>)
    expect(await screen.findByText('APP-READY')).toBeTruthy()
  })

  it('does not block when the status probe is unreachable (SetupGate owns that error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    render(<LoginGate>{child}</LoginGate>)
    expect(await screen.findByText('APP-READY')).toBeTruthy()
  })

  it('sends credentials on the status probe so the session cookie rides', async () => {
    const f = statusFetch({ needsAuth: false, authed: false })
    vi.stubGlobal('fetch', f)
    render(<LoginGate>{child}</LoginGate>)
    await screen.findByText('APP-READY')
    expect(f).toHaveBeenCalledWith(
      expect.stringContaining('/auth/status'),
      expect.objectContaining({ credentials: 'include' }),
    )
  })
})

describe('LoginView', () => {
  function typePasswordAndSubmit(value: string) {
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: /log in/i }))
  }

  it('logs in with the entered password (credentials included) and calls onLoggedIn', async () => {
    const login = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', login)
    const onLoggedIn = vi.fn()
    render(<LoginView httpOrigin="http://x" onLoggedIn={onLoggedIn} />)
    typePasswordAndSubmit('hunter2')
    await waitFor(() => expect(onLoggedIn).toHaveBeenCalled())
    expect(login).toHaveBeenCalledWith(
      'http://x/auth/login',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    )
    const body = JSON.parse((login.mock.calls[0]?.[1] as { body: string }).body)
    expect(body.password).toBe('hunter2')
  })

  it('shows an error and does not proceed on a wrong password (401)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
    )
    const onLoggedIn = vi.fn()
    render(<LoginView httpOrigin="http://x" onLoggedIn={onLoggedIn} />)
    typePasswordAndSubmit('wrong')
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(onLoggedIn).not.toHaveBeenCalled()
  })

  it('surfaces a throttle (429) distinctly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }),
    )
    render(<LoginView httpOrigin="http://x" onLoggedIn={vi.fn()} />)
    typePasswordAndSubmit('x')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent?.toLowerCase()).toContain('too many')
  })

  it('clears the error on the next keystroke', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
    )
    render(<LoginView httpOrigin="http://x" onLoggedIn={vi.fn()} />)
    typePasswordAndSubmit('wrong')
    await screen.findByRole('alert')
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'wrong2' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('walks the status line: waiting → press ⏎ → verifying → signed in', async () => {
    let release: (v: { ok: boolean; status: number; json: () => Promise<unknown> }) => void =
      () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise((resolve) => {
          release = resolve
        }),
      ),
    )
    render(<LoginView httpOrigin="http://x" onLoggedIn={vi.fn()} />)
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('waiting on you')
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'pw' } })
    expect(status.textContent).toContain('press ⏎ to sign in')
    fireEvent.click(screen.getByRole('button', { name: /log in/i }))
    expect(status.textContent).toContain('verifying')
    release({ ok: true, status: 200, json: async () => ({ ok: true }) })
    await waitFor(() => expect(status.textContent).toContain('signed in'))
  })

  it('shows the caps-lock pill while CapsLock is on', () => {
    vi.stubGlobal('fetch', vi.fn())
    render(<LoginView httpOrigin="http://x" onLoggedIn={vi.fn()} />)
    const input = screen.getByLabelText(/password/i)
    // happy-dom ignores the modifierCapsLock init flag, so stub getModifierState directly.
    const capsEvent = (type: string, on: boolean) => {
      const e = new KeyboardEvent(type, { key: 'a', bubbles: true })
      Object.defineProperty(e, 'getModifierState', { value: () => on })
      return e
    }
    fireEvent(input, capsEvent('keydown', true))
    expect(screen.getByText(/caps lock on/i)).toBeTruthy()
    fireEvent(input, capsEvent('keyup', false))
    expect(screen.queryByText(/caps lock on/i)).toBeNull()
  })

  it('renders the ASCII wordmark', () => {
    vi.stubGlobal('fetch', vi.fn())
    render(<LoginView httpOrigin="http://x" onLoggedIn={vi.fn()} />)
    expect(screen.getByLabelText('Podium')).toBeTruthy()
  })
})

describe('LoginGate success reveal', () => {
  it('mounts the app behind the login layer on success, then removes the layer', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi
        .fn()
        // auth/status probe → login required
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ needsAuth: true, authed: false }),
        })
        // auth/login → success
        .mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
      vi.stubGlobal('fetch', fetchMock)
      render(<LoginGate>{child}</LoginGate>)
      const input = await vi.waitFor(() => {
        const el = screen.queryByLabelText(/password/i)
        if (!el) throw new Error('no input yet')
        return el
      })
      expect(screen.queryByText('APP-READY')).toBeNull()

      fireEvent.change(input, { target: { value: 'pw' } })
      fireEvent.click(screen.getByRole('button', { name: /log in/i }))
      // App mounts behind the still-visible login layer at t=0…
      await vi.waitFor(() => {
        if (!screen.queryByText('APP-READY')) throw new Error('app not mounted')
      })
      expect(screen.getByLabelText(/password/i)).toBeTruthy()
      // …and the layer unmounts after the reveal completes.
      await vi.advanceTimersByTimeAsync(2000)
      expect(screen.queryByLabelText(/password/i)).toBeNull()
      expect(screen.getByText('APP-READY')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
