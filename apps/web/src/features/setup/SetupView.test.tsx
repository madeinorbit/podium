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
  authStatus: vi.fn(),
  // The host flow's telemetry sub-step probes for kill switches [spec:SP-f933].
  telemetryState: vi.fn(),
}))

vi.mock('@/app/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/trpc')>()
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
      auth: {
        status: { query: trpcMock.authStatus },
      },
      telemetry: {
        state: { query: trpcMock.telemetryState },
      },
    }),
  }
})

import { SetupView } from './SetupView'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/**
 * Walk the host flow's telemetry sub-step [spec:SP-f933]. The network step no
 * longer commits: it hands its payload to this step, which sends ONE
 * setup.complete for the whole wizard. `answer` leaves both tiers off (the
 * default) unless a tier is named.
 */
const finishTelemetry = async (
  view: ReturnType<typeof within>,
  answer: { usage?: boolean; crash?: boolean } = {},
): Promise<void> => {
  await act(async () => {
    await flush() // the step probes telemetry.state for kill switches first
  })
  // Click the LABEL TEXT, not the role=checkbox span: Base UI's checkbox is a
  // span + hidden input, and only the label click toggles it under happy-dom
  // (same approach as the no-password ack test above).
  await act(async () => {
    if (answer.usage) fireEvent.click(view.getByText(/send anonymous usage reports/i))
    if (answer.crash) fireEvent.click(view.getByText(/send crash reports/i))
    await flush()
  })
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: /finish/i }))
    await flush()
  })
}

/** What setup.complete carries when the user declines both tiers. */
const DECLINED = { telemetry: { usage: 'off', crash: 'off' } }

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
  trpcMock.authStatus.mockResolvedValue({ enabled: false }) // no password by default (first run)
  // No kill switch by default → the telemetry sub-step asks.
  trpcMock.telemetryState.mockResolvedValue({
    usage: 'absent',
    crash: 'absent',
    endpoint: 'https://t',
  })
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

    fireEvent.change(view.getByLabelText(/public url/i), {
      target: { value: 'https://box.ts.net' },
    })
    fireEvent.click(view.getByRole('radio', { name: /run without a podium password/i }))
    expect((view.getByRole('button', { name: /finish/i }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(view.getByText(/I understand that anyone who can reach this Podium URL/i))
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /finish/i }))
      await flush()
    })

    await finishTelemetry(view)
    expect(trpcMock.complete).toHaveBeenCalledWith({
      publicUrl: 'https://box.ts.net',
      mode: 'all-in-one',
      acknowledgeNoPassword: true,
      ...DECLINED,
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
    fireEvent.change(view.getByLabelText(/^login password$/i), {
      target: { value: 'launch-code' },
    })
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /finish/i }))
      await flush()
    })
    await finishTelemetry(view)
    expect(trpcMock.complete).toHaveBeenCalledWith({
      publicUrl: 'https://box.ts.net',
      mode: 'all-in-one',
      password: 'launch-code',
      ...DECLINED,
    })
  })

  it('keeps the existing password when one is already set (no re-entry)', async () => {
    trpcMock.authStatus.mockResolvedValue({ enabled: true }) // a password already exists
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
    fireEvent.change(view.getByLabelText(/public url/i), {
      target: { value: 'https://box.ts.net' },
    })
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /finish/i }))
      await flush()
    })
    await finishTelemetry(view)
    // No password / no ack → the server keeps the existing one.
    expect(trpcMock.complete).toHaveBeenCalledWith({
      publicUrl: 'https://box.ts.net',
      mode: 'all-in-one',
      ...DECLINED,
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
    fireEvent.change(view.getByLabelText(/public url/i), {
      target: { value: 'https://box.ts.net' },
    })
    expect(view.queryByText(/quick tunnel/i)).toBeNull()
    // Quick-tunnel URL: inline warning, but the flow is not blocked.
    fireEvent.change(view.getByLabelText(/public url/i), {
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
    fireEvent.change(view.getByLabelText(/public url/i), {
      target: { value: 'https://relay.ts.net' },
    })
    fireEvent.change(view.getByLabelText(/^login password$/i), { target: { value: 'pw' } })
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /finish/i }))
      await flush()
    })
    await finishTelemetry(view)
    expect(trpcMock.complete).toHaveBeenCalledWith({
      publicUrl: 'https://relay.ts.net',
      mode: 'server',
      password: 'pw',
      ...DECLINED,
    })
    expect(onSaved).toHaveBeenCalled()
  })

  // ------------------------------------------------------------------
  // Telemetry sub-step [spec:SP-f933]
  // ------------------------------------------------------------------
  describe('telemetry sub-step', () => {
    /** Drive mode → network → the telemetry step. */
    const reachTelemetryStep = async (): Promise<ReturnType<typeof within>> => {
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
      fireEvent.change(view.getByLabelText(/^login password$/i), { target: { value: 'pw' } })
      await act(async () => {
        fireEvent.click(view.getByRole('button', { name: /finish/i }))
        await flush()
      })
      return view
    }

    it('nothing is committed until the telemetry step finishes (one atomic write)', async () => {
      await reachTelemetryStep()
      // The network step handed its payload up rather than writing it.
      expect(trpcMock.complete).not.toHaveBeenCalled()
    })

    it('shows the example report and the opt-out routes', async () => {
      const view = await reachTelemetryStep()
      await act(async () => {
        await flush()
      })
      expect(view.getByText(/anonymous telemetry \(opt-in\)/i)).toBeTruthy()
      expect(view.getByText(/"installAge": "1-7d"/)).toBeTruthy()
      expect(view.getByText(/podium telemetry off/)).toBeTruthy()
      expect(view.getByText(/dropped at ingest/i)).toBeTruthy()
    })

    it('defaults BOTH tiers to off', async () => {
      const view = await reachTelemetryStep()
      await act(async () => {
        await flush()
      })
      expect(
        view.getByRole('checkbox', { name: /usage reports/i }).getAttribute('aria-checked'),
      ).toBe('false')
      expect(
        view.getByRole('checkbox', { name: /crash reports/i }).getAttribute('aria-checked'),
      ).toBe('false')
      // The button says what finishing without touching anything will do.
      expect(view.getByRole('button', { name: /finish without telemetry/i })).toBeTruthy()
    })

    it('sends the opted-in tiers with the commit', async () => {
      const view = await reachTelemetryStep()
      await finishTelemetry(view, { usage: true })
      expect(trpcMock.complete).toHaveBeenCalledWith(
        expect.objectContaining({ telemetry: { usage: 'on', crash: 'off' } }),
      )
    })

    it('consents to each tier independently', async () => {
      const view = await reachTelemetryStep()
      await finishTelemetry(view, { crash: true })
      expect(trpcMock.complete).toHaveBeenCalledWith(
        expect.objectContaining({ telemetry: { usage: 'off', crash: 'on' } }),
      )
    })

    it('a kill switch SKIPS the step and commits with no telemetry answer at all', async () => {
      trpcMock.telemetryState.mockResolvedValue({
        usage: 'absent',
        crash: 'absent',
        endpoint: 'https://t',
        suppressedBy: 'DO_NOT_TRACK',
      })
      const view = await reachTelemetryStep()
      await act(async () => {
        await flush()
      })
      // Never asked → not even an explicit 'off' is recorded, and the rest of
      // the wizard still commits (a DO_NOT_TRACK box gets a working install).
      expect(view.queryByRole('checkbox', { name: /usage reports/i })).toBeNull()
      expect(trpcMock.complete).toHaveBeenCalledWith(
        expect.not.objectContaining({ telemetry: expect.anything() }),
      )
    })

    it('a failed state probe still lets the user through (never strands the wizard)', async () => {
      trpcMock.telemetryState.mockRejectedValue(new Error('offline'))
      const view = await reachTelemetryStep()
      await finishTelemetry(view)
      expect(trpcMock.complete).toHaveBeenCalledWith(expect.objectContaining(DECLINED))
    })
  })
})
