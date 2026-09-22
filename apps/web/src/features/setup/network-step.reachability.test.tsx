import { CHECK_ERROR_SENTENCES, type CheckResult } from '@podium/runtime/connect-check'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import {
  NetworkStep,
  reachabilityHintFor,
  type NetworkSaveController,
  type SetupCompleteInput,
} from './network-step'

/**
 * THE ADVISORY PROBE (POD-4535). The web setup screen runs `trpc.connect.check`
 * after the URL validates and before anything commits — and a failed probe is a
 * hint, never a gate: "i would still want people to ignore a negative
 * reachability result if they chose to do so."
 *
 * Every test below mocks the trpc client; none performs network I/O.
 */
function fakeTrpc(opts: {
  publicUrl?: string | null
  hasOwnCredential?: boolean
  complete?: ReturnType<typeof vi.fn>
  check?: (url: string) => Promise<CheckResult>
} = {}) {
  const complete = opts.complete ?? vi.fn().mockResolvedValue({ mode: 'all-in-one' })
  const trpc = {
    setup: {
      info: {
        query: vi.fn().mockResolvedValue({ publicUrl: opts.publicUrl ?? null, networkOption: null }),
      },
      options: {
        query: vi.fn().mockResolvedValue([
          { id: 'tailscale-funnel', label: 'Tailscale Funnel', note: 'Reachable anywhere.' },
        ]),
      },
      commandFor: {
        query: vi.fn().mockResolvedValue({ command: 'tailscale funnel 18787', hint: 'Paste it.' }),
      },
      complete: { mutate: complete },
    },
    auth: {
      status: {
        query: vi.fn().mockResolvedValue({ hasOwnCredential: opts.hasOwnCredential ?? false }),
      },
    },
  } as unknown as Trpc
  if (opts.check) {
    // Mirrors the router shape: trpc.connect.check.query({ url }).
    const check = opts.check
    ;(trpc as unknown as Record<string, unknown>).connect = {
      check: { query: vi.fn().mockImplementation(({ url }: { url: string }) => check(url)) },
    }
  }
  return trpc
}

const URL = 'https://box.tail.ts.net'
const FAIL: CheckResult = { ok: false, error: 'PORT_NOT_REACHABLE', detail: 'probe detail' }

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }),
  )
}

/** Fill the fresh-instance form (password mode) and press the private button. */
async function fillAndSubmit(): Promise<void> {
  fireEvent.change(await screen.findByLabelText(/podium url/i), { target: { value: URL } })
  fireEvent.change(screen.getByLabelText(/^login password$/i), { target: { value: 'hunter2' } })
  fireEvent.click(screen.getByRole('button', { name: /^(finish|save network settings)$/i }))
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('reachabilityHintFor', () => {
  it('has no opinion on ok, CONNECT_UNAVAILABLE, or no answer', () => {
    expect(reachabilityHintFor(undefined)).toBeNull()
    expect(reachabilityHintFor({ ok: true, url: URL, resolvedTo: [] })).toBeNull()
    expect(
      reachabilityHintFor({ ok: false, error: 'CONNECT_UNAVAILABLE', detail: 'down' }),
    ).toBeNull()
  })

  it('says a failed code in the shared sentence, keeping the probe detail', () => {
    const hint = reachabilityHintFor({ ok: false, error: 'DNS_FAILED', detail: 'probe detail' })
    expect(hint).toContain(CHECK_ERROR_SENTENCES.DNS_FAILED)
    expect(hint).toContain('probe detail')
  })

  it('names an unrecognised code instead of rendering undefined', () => {
    const hint = reachabilityHintFor(
      { ok: false, error: 'SOME_FUTURE_CODE', detail: '' } as unknown as CheckResult,
    )
    expect(hint).toContain('SOME_FUTURE_CODE')
    expect(hint).not.toContain('undefined')
  })
})

describe('NetworkStep advisory probe', () => {
  it('shows the check while it runs, then commits silently on ok', async () => {
    stubFetch()
    let resolveCheck!: (v: CheckResult) => void
    const gate = new Promise<CheckResult>((res) => {
      resolveCheck = res
    })
    const complete = vi.fn().mockResolvedValue({ mode: 'all-in-one' })
    const trpc = fakeTrpc({ complete, check: () => gate })
    const onSaved = vi.fn()
    render(<NetworkStep embedded trpc={trpc} onSaved={onSaved} />)

    fireEvent.change(await screen.findByLabelText(/podium url/i), { target: { value: URL } })
    fireEvent.change(screen.getByLabelText(/^login password$/i), { target: { value: 'hunter2' } })
    fireEvent.click(screen.getByRole('button', { name: /save network settings/i }))

    // The round trip is a second or two: say so, on every commit path.
    expect(await screen.findByText(/checking that this url is reachable/i)).toBeTruthy()
    expect(complete).not.toHaveBeenCalled()
    resolveCheck({ ok: true, url: URL, resolvedTo: [] })

    // ok → proceed. No celebration UI, no extra click.
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    expect(onSaved).toHaveBeenCalled()
    expect(screen.queryByText(/use this url anyway/i)).toBeNull()
    expect(screen.queryByText(/checking that this url is reachable/i)).toBeNull()
  })

  it('a failed probe commits nothing until the override is taken', async () => {
    stubFetch()
    const complete = vi.fn().mockResolvedValue({ mode: 'all-in-one' })
    const trpc = fakeTrpc({ complete, check: async () => FAIL })
    const onSaved = vi.fn()
    render(<NetworkStep embedded trpc={trpc} onSaved={onSaved} />)
    await fillAndSubmit()

    // The shared sentence, plus the one-click override. The safe path (fix the
    // URL, then save again) stays the prominent primary button.
    expect(await screen.findByText(CHECK_ERROR_SENTENCES.PORT_NOT_REACHABLE, { exact: false })).toBeTruthy()
    const override = await screen.findByRole('button', { name: /use this url anyway/i })
    expect(override).toBeTruthy()
    expect(complete).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()

    // Still on the URL field, with what was typed intact.
    const input = screen.getByLabelText(/podium url/i) as HTMLInputElement
    expect(input.value).toBe(URL)

    await act(async () => {
      fireEvent.click(override)
    })
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    expect(onSaved).toHaveBeenCalled()
  })

  it('the override commits exactly what a silent run would have committed (immediate path)', async () => {
    stubFetch()
    const fillPassword = async (): Promise<void> => {
      fireEvent.change(await screen.findByLabelText(/podium url/i), { target: { value: URL } })
      fireEvent.change(screen.getByLabelText(/^login password$/i), { target: { value: 'hunter2' } })
    }

    const okComplete = vi.fn().mockResolvedValue({ mode: 'all-in-one' })
    render(
      <NetworkStep
        embedded
        trpc={fakeTrpc({ complete: okComplete, check: async (url) => ({ ok: true, url, resolvedTo: [] }) })}
        onSaved={vi.fn()}
      />,
    )
    await fillPassword()
    fireEvent.click(screen.getByRole('button', { name: /save network settings/i }))
    await waitFor(() => expect(okComplete).toHaveBeenCalledTimes(1))
    const silentPayload = okComplete.mock.calls[0]?.[0] as SetupCompleteInput
    cleanup()

    const overrideComplete = vi.fn().mockResolvedValue({ mode: 'all-in-one' })
    render(
      <NetworkStep
        embedded
        trpc={fakeTrpc({ complete: overrideComplete, check: async () => FAIL })}
        onSaved={vi.fn()}
      />,
    )
    await fillPassword()
    fireEvent.click(screen.getByRole('button', { name: /save network settings/i }))
    fireEvent.click(await screen.findByRole('button', { name: /use this url anyway/i }))
    await waitFor(() => expect(overrideComplete).toHaveBeenCalledTimes(1))
    expect(overrideComplete.mock.calls[0]?.[0]).toEqual(silentPayload)
  })

  it('the check is advisory on the deferred onCollected path too', async () => {
    stubFetch()
    const collected: SetupCompleteInput[] = []
    const trpc = fakeTrpc({ check: async () => FAIL })
    render(
      <NetworkStep
        trpc={trpc}
        mode="all-in-one"
        onSaved={vi.fn()}
        onCollected={(p) => {
          collected.push(p)
        }}
      />,
    )
    fireEvent.change(await screen.findByLabelText(/podium url/i), { target: { value: URL } })
    fireEvent.change(screen.getByLabelText(/^login password$/i), { target: { value: 'hunter2' } })
    fireEvent.click(screen.getByRole('button', { name: /^finish$/i }))

    expect(await screen.findByRole('button', { name: /use this url anyway/i })).toBeTruthy()
    // Override NOT taken: nothing handed up, nothing written.
    expect(collected).toHaveLength(0)
    expect(trpc.setup.complete.mutate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /use this url anyway/i }))
    await waitFor(() => expect(collected).toHaveLength(1))
    expect(collected[0]).toMatchObject({ publicUrl: URL, mode: 'all-in-one', password: 'hunter2' })
    expect(trpc.setup.complete.mutate).not.toHaveBeenCalled()
  })

  it('the check is advisory on the embedded save-bar path too', async () => {
    stubFetch()
    let controller: NetworkSaveController | null = null
    const complete = vi.fn().mockResolvedValue({ mode: 'all-in-one' })
    const trpc = fakeTrpc({ complete, check: async () => FAIL })
    const onSaved = vi.fn()
    render(
      <NetworkStep
        embedded
        trpc={trpc}
        onSaved={onSaved}
        onSaveStateChange={(s) => {
          controller = s
        }}
      />,
    )
    fireEvent.change(await screen.findByLabelText(/podium url/i), { target: { value: URL } })
    fireEvent.change(screen.getByLabelText(/^login password$/i), { target: { value: 'hunter2' } })
    await waitFor(() => expect(controller).not.toBeNull())

    // The shared save bar drives the same `finish`: it probes, warns, and waits.
    await act(async () => {
      await controller?.save()
    })
    expect(await screen.findByRole('button', { name: /use this url anyway/i })).toBeTruthy()
    expect(complete).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()

    // The override commits unchanged — the same values the silent run writes.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /use this url anyway/i }))
    })
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ publicUrl: URL, password: 'hunter2' })
    expect(onSaved).toHaveBeenCalled()
  })

  it('CONNECT_UNAVAILABLE adds no UI at all', async () => {
    stubFetch()
    const complete = vi.fn().mockResolvedValue({ mode: 'all-in-one' })
    const onSaved = vi.fn()
    render(
      <NetworkStep
        embedded
        trpc={fakeTrpc({
          complete,
          check: async () => ({ ok: false, error: 'CONNECT_UNAVAILABLE', detail: 'down' }),
        })}
        onSaved={onSaved}
      />,
    )
    await fillAndSubmit()
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    expect(onSaved).toHaveBeenCalled()
    expect(screen.queryByText(/use this url anyway/i)).toBeNull()
    expect(screen.queryByText(/checking that this url is reachable/i)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a rejecting query adds no UI at all', async () => {
    stubFetch()
    const complete = vi.fn().mockResolvedValue({ mode: 'all-in-one' })
    const onSaved = vi.fn()
    render(
      <NetworkStep
        embedded
        trpc={fakeTrpc({
          complete,
          check: async () => {
            throw new Error('cloud unreachable')
          },
        })}
        onSaved={onSaved}
      />,
    )
    await fillAndSubmit()
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    expect(onSaved).toHaveBeenCalled()
    expect(screen.queryByText(/use this url anyway/i)).toBeNull()
    expect(screen.queryByText(/checking that this url is reachable/i)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a client without connect.check adds no UI at all', async () => {
    stubFetch()
    const complete = vi.fn().mockResolvedValue({ mode: 'all-in-one' })
    const onSaved = vi.fn()
    // No `check` key at all: Connect off, or no installation identity yet.
    render(<NetworkStep embedded trpc={fakeTrpc({ complete })} onSaved={onSaved} />)
    await fillAndSubmit()
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    expect(onSaved).toHaveBeenCalled()
    expect(screen.queryByText(/use this url anyway/i)).toBeNull()
    expect(screen.queryByText(/checking that this url is reachable/i)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('an unrecognised code names itself, never undefined', async () => {
    stubFetch()
    const trpc = fakeTrpc({
      check: async () =>
        ({ ok: false, error: 'SOME_FUTURE_CODE', detail: '' }) as unknown as CheckResult,
    })
    render(<NetworkStep embedded trpc={trpc} onSaved={vi.fn()} />)
    await fillAndSubmit()
    const warning = await screen.findByText(/SOME_FUTURE_CODE/)
    expect(warning.textContent).not.toContain('undefined')
    expect(trpc.setup.complete.mutate).not.toHaveBeenCalled()
  })

  it('renders the shared sentence, not a web-owned copy', async () => {
    stubFetch()
    const original = CHECK_ERROR_SENTENCES.DNS_FAILED
    CHECK_ERROR_SENTENCES.DNS_FAILED = 'SENTINEL_DNS_XYZ_SHARED'
    try {
      const trpc = fakeTrpc({ check: async () => ({ ok: false, error: 'DNS_FAILED', detail: '' }) })
      render(<NetworkStep embedded trpc={trpc} onSaved={vi.fn()} />)
      await fillAndSubmit()
      // Read at call time from the shared map: moving the sentence moves the web.
      expect(await screen.findByText(/SENTINEL_DNS_XYZ_SHARED/)).toBeTruthy()
    } finally {
      CHECK_ERROR_SENTENCES.DNS_FAILED = original
    }
  })
})
