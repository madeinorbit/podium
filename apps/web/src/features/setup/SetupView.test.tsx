import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The all-in-one path runs a reachability step that talks to the `setup` tRPC procedures via
// the vanilla client from makeTrpc(). Mock the client so the step resolves without network.
const trpcMock = vi.hoisted(() => ({
  options: vi.fn(),
  commandFor: vi.fn(),
  info: vi.fn(),
  complete: vi.fn(),
  join: vi.fn(),
  connect: vi.fn(),
  authStatus: vi.fn(),
}))

vi.mock('@/app/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/trpc')>()
  return {
    ...actual,
    makeTrpc: () => ({
      setup: {
        options: { query: trpcMock.options },
        commandFor: { query: trpcMock.commandFor },
        // NetworkStep seeds its URL field from the saved config before rendering (POD-1148).
        info: { query: trpcMock.info },
        complete: { mutate: trpcMock.complete },
        join: { mutate: trpcMock.join },
        connect: { mutate: trpcMock.connect },
      },
      auth: {
        status: { query: trpcMock.authStatus },
      },
    }),
  }
})

import { reachablePort, SetupView } from './SetupView'

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
  trpcMock.info.mockResolvedValue({
    mode: null,
    publicUrl: null,
    networkOption: null,
    serverUrl: null,
  }) // first run
  trpcMock.complete.mockResolvedValue({ mode: 'all-in-one', publicUrl: 'https://box.ts.net' })
  trpcMock.connect.mockResolvedValue({ mode: 'all-in-one' })
  // POD-1554 made "a password is already set" PER-ACCOUNT: SetupView reads
  // `hasOwnCredential` (SetupView.tsx:462), not the retired instance-wide
  // `enabled`. Mocking the old key left hasPassword false and the "keep" radio
  // unrendered.
  trpcMock.authStatus.mockResolvedValue({ hasOwnCredential: false }) // first run
  // The reachability step POSTs /auth/login after a `complete` that carried a password, so it
  // keeps a session through the guard that write just closed (POD-1148). Unstubbed, that call
  // hits the real global `fetch` and never settles inside `flush()`.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('reachablePort (POD-1583)', () => {
  it('names the port the instance is actually served on', () => {
    expect(reachablePort({ port: '18899' })).toBe(18899)
  })

  it('falls back to the default only when the location carries no explicit port', () => {
    // https://podium.example on 443: naming 443 would be wrong too, so fall back.
    expect(reachablePort({ port: '' })).toBe(18787)
    expect(reachablePort({})).toBe(18787)
  })

  it('still yields the default when the instance IS on the default port', () => {
    expect(reachablePort({ port: '18787' })).toBe(18787)
  })
})

describe('SetupView', () => {
  it('shows only the safe host handoff to an unconfigured remote browser', () => {
    render(
      <SetupView
        httpOrigin="https://podium.example"
        onSaved={() => {}}
        blockedState="remote-setup"
      />,
    )
    expect(screen.getByText(/finish setup on the server/i)).toBeTruthy()
    expect(screen.getByText('podium setup')).toBeTruthy()
    expect(screen.queryByText(/how should this install run/i)).toBeNull()
    expect(trpcMock.connect).not.toHaveBeenCalled()
  })

  it('renders activation pending as restart-only copy', () => {
    render(
      <SetupView
        httpOrigin="http://localhost:18787"
        onSaved={() => {}}
        blockedState="restart-required"
      />,
    )
    expect(screen.getByText(/setup is saved; podium needs to restart/i)).toBeTruthy()
    expect(screen.queryByText(/how should this install run/i)).toBeNull()
    expect(screen.getByRole('button', { name: /retry after restart/i })).toBeTruthy()
  })

  it('offers the native restart hook for activation pending in desktop', () => {
    const restart = vi.fn()
    vi.stubGlobal('__PODIUM_RESTART__', restart)
    render(
      <SetupView
        httpOrigin="http://localhost:18787"
        onSaved={() => {}}
        blockedState="restart-required"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^restart podium$/i }))
    expect(restart).toHaveBeenCalled()
  })

  it('applies the trusted local all-in-one default and continues without topology questions', async () => {
    const onSaved = vi.fn()
    render(<SetupView httpOrigin="http://localhost:18787" onSaved={onSaved} localDefault />)
    expect(screen.getByText(/starting podium on this machine/i)).toBeTruthy()
    expect(screen.queryByText(/how should this install run/i)).toBeNull()
    await act(async () => {
      await flush()
    })
    expect(trpcMock.connect).toHaveBeenCalledWith({ mode: 'all-in-one' })
    expect(onSaved).toHaveBeenCalled()
  })

  it('offers the advanced path when applying the local default fails', async () => {
    trpcMock.connect.mockRejectedValueOnce(new Error('config is read-only'))
    render(<SetupView httpOrigin="http://localhost:18787" onSaved={() => {}} localDefault />)
    expect((await screen.findByRole('alert')).textContent).toContain('config is read-only')
    fireEvent.click(screen.getByRole('button', { name: /open advanced setup/i }))
    expect(screen.getByText(/how should this install run/i)).toBeTruthy()
  })

  it('renders the four deployment modes', () => {
    render(<SetupView httpOrigin="http://localhost:18787" onSaved={() => {}} />)
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(4)
    expect(screen.getByText(/run podium on this machine/i)).toBeTruthy()
    expect(screen.getByText(/add this machine to a podium/i)).toBeTruthy()
    expect(screen.getByText(/open a podium running elsewhere/i)).toBeTruthy()
    expect(screen.getByText(/hub for your other machines/i)).toBeTruthy()
  })

  it('all-in-one requires choosing open mode before showing no-password acknowledgement', async () => {
    const onSaved = vi.fn()
    const { container } = render(
      <SetupView httpOrigin="http://localhost:18787" onSaved={onSaved} />,
    )
    const view = within(container)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /continue/i }))
      await flush()
    })

    expect(trpcMock.options).toHaveBeenCalled()
    expect(view.getByText('tailscale funnel 18787')).toBeTruthy()
    expect(
      (view.getByRole('radio', { name: /require a login password/i }) as HTMLInputElement).checked,
    ).toBe(true)
    expect(view.queryByText(/I understand that anyone who can reach this Podium URL/i)).toBeNull()

    fireEvent.change(view.getByLabelText(/podium url/i), {
      target: { value: 'https://box.ts.net' },
    })
    fireEvent.click(view.getByRole('radio', { name: /run without a podium password/i }))
    expect((view.getByRole('button', { name: /finish/i }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(view.getByText(/I understand that anyone who can reach this Podium URL/i))
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /finish/i }))
      await flush()
    })

    expect(trpcMock.complete).toHaveBeenCalledWith({
      publicUrl: 'https://box.ts.net',
      mode: 'all-in-one',
      networkOption: 'tailscale-funnel',
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
    fireEvent.change(view.getByLabelText(/podium url/i), {
      target: { value: 'https://box.ts.net' },
    })
    fireEvent.change(view.getByLabelText(/^login password$/i), {
      target: { value: 'launch-code' },
    })
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /finish/i }))
      await flush()
    })
    expect(trpcMock.complete).toHaveBeenCalledWith({
      publicUrl: 'https://box.ts.net',
      mode: 'all-in-one',
      networkOption: 'tailscale-funnel',
      password: 'launch-code',
    })
  })

  it('keeps the existing password when one is already set (no re-entry)', async () => {
    trpcMock.authStatus.mockResolvedValue({ hasOwnCredential: true }) // this account has a password
    const { container } = render(
      <SetupView httpOrigin="http://localhost:18787" onSaved={() => {}} />,
    )
    const view = within(container)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /continue/i }))
      await flush()
    })
    // Defaults to "Keep current password" — just set the URL and finish.
    expect(
      (view.getByRole('radio', { name: /keep current password/i }) as HTMLInputElement).checked,
    ).toBe(true)
    fireEvent.change(view.getByLabelText(/podium url/i), {
      target: { value: 'https://box.ts.net' },
    })
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /finish/i }))
      await flush()
    })
    // No password / no ack → the server keeps the existing one.
    expect(trpcMock.complete).toHaveBeenCalledWith({
      publicUrl: 'https://box.ts.net',
      mode: 'all-in-one',
      networkOption: 'tailscale-funnel',
    })
  })

  it('daemon join surfaces the quick-tunnel warning and waits for an explicit continue', async () => {
    // setup.join (core applyJoin) flags a rotating *.trycloudflare.com server URL.
    trpcMock.join.mockResolvedValue({
      name: 'this machine',
      warning:
        'This is a Cloudflare QUICK tunnel URL — it changes every time cloudflared restarts.',
    })
    const onSaved = vi.fn()
    const { container } = render(
      <SetupView httpOrigin="http://localhost:18787" onSaved={onSaved} />,
    )
    const view = within(container)
    fireEvent.click(view.getByRole('radio', { name: /add this machine to a podium/i }))
    fireEvent.change(view.getByLabelText(/^join code/i), { target: { value: 'JOINCODE123' } })
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /save/i }))
      await flush()
    })

    // Joined (config applied) but paused on the warning — no silent proceed.
    expect(trpcMock.join).toHaveBeenCalledWith({ code: 'JOINCODE123' })
    expect(view.getByRole('alert').textContent).toMatch(/quick tunnel/i)
    expect(onSaved).not.toHaveBeenCalled()

    fireEvent.click(view.getByRole('button', { name: /continue anyway/i }))
    expect(onSaved).toHaveBeenCalled()
  })

  it('reachability step flags a *.trycloudflare.com public URL (and not a stable one)', async () => {
    const { container } = render(
      <SetupView httpOrigin="http://localhost:18787" onSaved={() => {}} />,
    )
    const view = within(container)
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /continue/i }))
      await flush()
    })
    // Stable URL: no warning.
    fireEvent.change(view.getByLabelText(/podium url/i), {
      target: { value: 'https://box.ts.net' },
    })
    expect(view.queryByText(/quick tunnel/i)).toBeNull()
    // Quick-tunnel URL: inline warning, but the flow is not blocked.
    fireEvent.change(view.getByLabelText(/podium url/i), {
      target: { value: 'https://random-words.trycloudflare.com' },
    })
    expect(view.getByText(/quick tunnel/i)).toBeTruthy()
    expect((view.getByRole('button', { name: /finish/i }) as HTMLButtonElement).disabled).toBe(true) // still disabled only because no password picked yet — warning doesn't add a block
  })

  it('daemon mode takes one join code and applies it via setup.join', async () => {
    trpcMock.join.mockResolvedValue({ name: 'this machine' }) // stable URL → no warning
    const onSaved = vi.fn()
    const { container } = render(
      <SetupView httpOrigin="http://localhost:18787" onSaved={onSaved} />,
    )
    const view = within(container)

    // No join-code field for default all-in-one mode.
    expect(view.queryByLabelText(/^join code/i)).toBeNull()

    // Select daemon mode — a single join-code field appears (no separate URL / pair fields).
    fireEvent.click(view.getByRole('radio', { name: /add this machine to a podium/i }))
    expect(view.getByLabelText(/^join code/i)).toBeTruthy()
    expect(view.queryByLabelText(/^server url/i)).toBeNull()
    expect(view.queryByLabelText(/pairing code/i)).toBeNull()

    fireEvent.change(view.getByLabelText(/^join code/i), { target: { value: 'JOINCODE123' } })
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /save/i }))
      await flush()
    })

    expect(trpcMock.join).toHaveBeenCalledWith({ code: 'JOINCODE123' })
    expect(view.queryByText(/quick tunnel/i)).toBeNull() // stable URL → no warning
    expect(onSaved).toHaveBeenCalled()
  })

  it('client mode shows a server-url field, no join code', () => {
    const { container } = render(
      <SetupView httpOrigin="http://localhost:18787" onSaved={() => {}} />,
    )
    const view = within(container)
    fireEvent.click(view.getByRole('radio', { name: /open a podium running elsewhere/i }))
    expect(view.getByLabelText(/^server url/i)).toBeTruthy()
    expect(view.queryByLabelText(/^join code/i)).toBeNull()
  })

  it('client mode applies via setup.connect (not the legacy POST)', async () => {
    const onSaved = vi.fn()
    const { container } = render(
      <SetupView httpOrigin="http://localhost:18787" onSaved={onSaved} />,
    )
    const view = within(container)
    fireEvent.click(view.getByRole('radio', { name: /open a podium running elsewhere/i }))
    fireEvent.change(view.getByLabelText(/^server url/i), { target: { value: 'ws://host:18787' } })
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /save/i }))
      await flush()
    })
    expect(trpcMock.connect).toHaveBeenCalledWith({ mode: 'client', serverUrl: 'ws://host:18787' })
    expect(onSaved).toHaveBeenCalled()
  })

  it('server-only mode runs the reachability step and applies with mode=server', async () => {
    const onSaved = vi.fn()
    const { container } = render(
      <SetupView httpOrigin="http://localhost:18787" onSaved={onSaved} />,
    )
    const view = within(container)
    fireEvent.click(view.getByRole('radio', { name: /hub for your other machines/i }))
    // Server now goes through reachability (URL + password), like the CLI — not a bare connect.
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /continue/i }))
      await flush()
    })
    fireEvent.change(view.getByLabelText(/podium url/i), {
      target: { value: 'https://relay.ts.net' },
    })
    fireEvent.change(view.getByLabelText(/^login password$/i), { target: { value: 'pw' } })
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /finish/i }))
      await flush()
    })
    expect(trpcMock.complete).toHaveBeenCalledWith({
      publicUrl: 'https://relay.ts.net',
      mode: 'server',
      networkOption: 'tailscale-funnel',
      password: 'pw',
    })
    // …and takes a cookie for it before handing back, or the guard the password just enabled
    // locks this browser out of the instance it has only half finished configuring.
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/auth/login'),
      expect.objectContaining({ credentials: 'include' }),
    )
    expect(onSaved).toHaveBeenCalled()
  })

  describe('handoff to activation', () => {
    it('commits host setup without a separate telemetry tollbooth', async () => {
      const onSaved = vi.fn()
      const { container } = render(
        <SetupView httpOrigin="http://localhost:18787" onSaved={onSaved} />,
      )
      const view = within(container)
      await act(async () => {
        fireEvent.click(view.getByRole('button', { name: /continue/i }))
        await flush()
      })
      fireEvent.change(view.getByLabelText(/podium url/i), {
        target: { value: 'https://box.ts.net' },
      })
      fireEvent.change(view.getByLabelText(/^login password$/i), { target: { value: 'pw' } })
      await act(async () => {
        fireEvent.click(view.getByRole('button', { name: /finish/i }))
        await flush()
      })
      expect(trpcMock.complete).toHaveBeenCalledWith(
        expect.not.objectContaining({ telemetry: expect.anything() }),
      )
      expect(onSaved).toHaveBeenCalledOnce()
      expect(view.queryByText(/anonymous telemetry/i)).toBeNull()
    })
  })
})
