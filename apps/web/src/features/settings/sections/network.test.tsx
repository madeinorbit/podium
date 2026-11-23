import '@/test-support/mock-core-store-handle'
import { CHECK_ERROR_SENTENCES, type CheckResult } from '@podium/runtime/connect-check'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import { type HostNetworkInfo, NetworkSettingsView } from '../network-view'
import { resetForcedSettingCache } from '../use-forced-setting'
import { AdvancedNetworkRows, NetworkSection } from './network'

const fixture = vi.hoisted(() => ({
  trpc: {} as Trpc,
  openTakeover: vi.fn(),
  closeTakeover: vi.fn(),
}))
vi.mock('../stable-access', () => ({ useSettingsTrpc: () => fixture.trpc }))
vi.mock('../settings-frame', () => ({ useSettingsFrame: () => fixture }))

afterEach(() => {
  cleanup()
  resetForcedSettingCache()
  vi.clearAllMocks()
})

async function network(overrides: Record<string, unknown> = {}) {
  const info = {
    mode: 'server',
    publicUrl: 'https://podium.example',
    publicUrlSource: 'file',
    networkOption: 'tailscale-serve',
    appUrl: null,
    allowedOrigins: [],
    stableLink: null,
    ...overrides,
  } as unknown as HostNetworkInfo
  fixture.trpc = {
    setup: {
      info: { query: vi.fn().mockResolvedValue(info) },
      provenance: {
        query: vi.fn().mockResolvedValue({
          publicUrl: { source: info.publicUrlSource, env: 'PODIUM_PUBLIC_URL' },
        }),
      },
    },
    connect: {
      check: {
        query: vi.fn().mockResolvedValue({ ok: true, url: info.publicUrl, resolvedTo: [] }),
      },
    },
  } as unknown as Trpc
  const view = new NetworkSettingsView(fixture.trpc)
  await view.refresh()
  return view
}

describe('Access address', () => {
  it('shows no host setup controls or installation details for a hosted workspace', async () => {
    const view = await network()
    vi.mocked(fixture.trpc.setup.info.query).mockResolvedValue({
      scope: 'workspace',
      transcriptLake: 'on',
      transcriptLakeSource: 'default',
    })
    await view.refresh()
    const { container } = render(
      <>
        <NetworkSection view={view} />
        <AdvancedNetworkRows view={view} />
      </>,
    )
    expect(container.childElementCount).toBe(0)
    expect(fixture.openTakeover).not.toHaveBeenCalled()
    view.close()
  })

  it.each([
    { ok: false, error: 'INVALID_URL', detail: 'must be on port 443' },
    { ok: false, error: 'PORT_UNSUPPORTED', detail: 'port is outside the probe allowlist' },
  ] satisfies CheckResult[])('labels a port the probe cannot check as unavailable: $error', async (verdict) => {
    const view = await network({ publicUrl: 'https://example.com:18787' })
    vi.mocked(fixture.trpc.connect.check.query).mockResolvedValue(verdict)
    render(<NetworkSection view={view} />)
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByText(/Check unavailable · Attempted/)).toBeTruthy()
    expect(screen.getByText(CHECK_ERROR_SENTENCES.PORT_UNSUPPORTED)).toBeTruthy()
    expect(screen.queryByText(/Not reachable from outside/)).toBeNull()
    expect(screen.queryByText(/not a usable URL|check for typos|must be on port 443/)).toBeNull()
    expect(fixture.trpc.connect.check.query).toHaveBeenCalledWith({
      url: 'https://example.com:18787',
    })
  })

  it('saves a changed non-443 address without an override when the deployed probe refuses its port', async () => {
    const view = await network({ publicUrl: 'https://example.com' })
    vi.mocked(fixture.trpc.connect.check.query).mockResolvedValue({
      ok: false,
      error: 'INVALID_URL',
      detail: 'must be on port 443',
    })
    const complete = vi.fn().mockResolvedValue({ mode: 'server' })
    Object.assign(fixture.trpc.setup, {
      options: { query: vi.fn().mockResolvedValue([]) },
      commandFor: { query: vi.fn().mockResolvedValue({ command: '', hint: '' }) },
      complete: { mutate: complete },
    })
    Object.assign(fixture.trpc, {
      auth: { status: { query: vi.fn().mockResolvedValue({ hasOwnCredential: true }) } },
    })
    render(<NetworkSection view={view} />)
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    render(fixture.openTakeover.mock.calls[0]?.[0].content)
    fireEvent.change(await screen.findByLabelText(/Podium URL/i), {
      target: { value: 'https://example.com:18787' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Check and save' }))
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ publicUrl: 'https://example.com:18787', confirmUrlChange: true }),
    )
    expect(fixture.closeTakeover).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /use this URL anyway/i })).toBeNull()
  })

  it('keeps a normal setup-saved address editable and opens a takeover with the rejoin warning', async () => {
    render(<NetworkSection view={await network()} />)
    expect(screen.getByText('https://podium.example')).toBeTruthy()
    expect(screen.getByText(/Tailscale Serve/)).toBeTruthy()
    expect(screen.queryByRole('radio')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    const flow = fixture.openTakeover.mock.calls[0]?.[0]
    expect(flow.title).toBe('Change address')
    render(flow.description)
    expect(screen.getByText(/Paired machines and phones must rejoin/)).toBeTruthy()
  })

  it('shows the deployment source instead of Change for an environment-owned address', async () => {
    render(<NetworkSection view={await network({ publicUrlSource: 'env' })} />)
    expect(await screen.findByText(/PODIUM_PUBLIC_URL is set/)).toBeTruthy()
    expect(screen.getByText('https://podium.example')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull()
  })

  it.each(['daemon', 'client'])('shows only the connected server on a %s machine', async (mode) => {
    render(<NetworkSection view={await network({ mode, serverUrl: 'https://upstream.example' })} />)
    expect(screen.getByText('https://upstream.example')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText('Reachable from outside')).toBeNull()
  })

  it('reports the outside verdict and its check time', async () => {
    render(<NetworkSection view={await network()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByText(/Reachable · Checked/)).toBeTruthy()
    expect(fixture.trpc.connect.check.query).toHaveBeenCalledWith({ url: 'https://podium.example' })
  })

  it('does not describe an unavailable probe as reachable', async () => {
    const view = await network()
    vi.mocked(fixture.trpc.connect.check.query).mockRejectedValue(new Error('offline'))
    render(<NetworkSection view={view} />)
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByText(/Check unavailable · Attempted/)).toBeTruthy()
  })

  it('shows Advanced defaults and the stable link only when Connect supplies one', async () => {
    const view = await network({ stableLink: 'https://connect.example/to/instance' })
    render(<AdvancedNetworkRows view={view} />)
    expect(screen.getByText('Same as Podium address')).toBeTruthy()
    expect(screen.getByText('None')).toBeTruthy()
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      'https://connect.example/to/instance',
    )
  })
})
