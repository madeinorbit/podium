import '@/test-support/mock-pool-store-handle'
import { asMachineId, type MachineWire } from '@podium/model'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeDesktopBridge } from '@/lib/nativeDesktop'
import { renderSettingsPool } from '@/test-support/mock-settings-pool-fixture'
import { SettingsOpening } from '../SettingsOpening'
import { SettingsControlsContext } from './shared'

const trpc = {
  setup: {
    channel: { query: vi.fn() },
    info: { query: vi.fn() },
    setChannel: { mutate: vi.fn() },
  },
  updates: {
    fleet: { query: vi.fn() },
    checkNow: { mutate: vi.fn() },
    proposal: { query: vi.fn().mockResolvedValue(null) },
    approveProposal: { mutate: vi.fn().mockResolvedValue(null) },
    repairPayload: { mutate: vi.fn() },
  },
  machines: { applyUpdate: { mutate: vi.fn() } },
  operations: { history: { query: vi.fn() }, active: { query: vi.fn().mockResolvedValue(null) } },
}

const firstMachine = {
  id: asMachineId('machine-ludovico'),
  name: 'ludovico',
  hostname: 'build.example',
  appVersion: '0.4.1',
  versionState: 'behind',
  updateChannelOverride: null,
  targetUnavailableReason: null,
  targetVersion: null,
} as MachineWire
const machines: MachineWire[] = [firstMachine]

// The update-status reader (POD-6683) builds its own plain-HTTP client; here it
// is the same fake, and the page's `/version` reads answer nothing.
vi.mock('@/app/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/trpc')>()),
  makeTrpc: () => trpc,
}))
vi.mock('@/lib/workspace-request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-request')>()),
  workspaceFetch: async () => ({ ok: false }),
}))

vi.mock('@/app/store', () => ({
  readFixture: (selector: (store: unknown) => unknown) => selector({ trpc, machines }),
}))

/** Settings → Labs "Podium development" (POD-1882). */
let developing = false
vi.mock('@/lib/use-feature', () => ({ useFeature: () => developing }))

let webVersion = '0.4.1'
let webDigest: string | undefined
vi.mock('@/lib/logging/build-version', () => ({
  pageBuildVersion: () => webVersion,
  pageBuildDigest: () => webDigest,
}))

const { UpdatesSection } = await import('./updates')
const { resetUpdateStatus, WATCHED_POLL_MS } = await import('@/lib/update-status')

/**
 * Move the DOCUMENT, not a stub of the source module.
 *
 * `uiSource()` decides the built-in-copy case from the page's own origin, so
 * driving that origin is what proves the row consults the real source rather
 * than naming one. A mocked module would leave a hard-coded "Live server" in
 * the component looking exactly as correct as the real call.
 */
let admin = true
function render(ui: ReactElement) {
  return renderSettingsPool(
    <SettingsOpening>
      <SettingsControlsContext.Provider
        value={{ permitted: { 'records.instancePreferences.edit': admin } }}
      >
        {ui}
      </SettingsControlsContext.Provider>
    </SettingsOpening>,
  )
}

const BROWSER_URL = 'http://podium.local/'
function pageServedFrom(url: string): void {
  ;(window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(url)
}

afterEach(() => {
  cleanup()
  resetUpdateStatus()
  vi.clearAllMocks()
  trpc.updates.proposal.query.mockReset().mockResolvedValue(null)
  trpc.updates.approveProposal.mutate.mockReset().mockResolvedValue(null)
  vi.unstubAllGlobals()
  vi.useRealTimers()
  pageServedFrom(BROWSER_URL)
  developing = false
  admin = true
  machines.splice(1)
  firstMachine.online = false
  firstMachine.transferable = false
  webVersion = '0.4.1'
  webDigest = undefined
  firstMachine.updateChannelOverride = null
  firstMachine.targetUnavailableReason = null
  firstMachine.targetVersion = null
  firstMachine.presenceSource = undefined
  firstMachine.deliveryCaps = undefined
  ;(globalThis as { __PODIUM_DESKTOP__?: NativeDesktopBridge }).__PODIUM_DESKTOP__ = undefined
})

const emptyFleet = {
  targetVersion: null,
  total: 0,
  behind: 0,
  converging: 0,
  failed: 0,
  machines: [],
  channelChecks: [],
}

/** History is read on every mount; most cases do not care what it says. */
function quietHistory(): void {
  trpc.operations.history.query.mockResolvedValue([])
}

describe('UpdatesSection', () => {
  it('tracks a moved proposal and approves exactly the SHA and version on screen', async () => {
    developing = true
    vi.useFakeTimers()
    trpc.setup.channel.query.mockResolvedValue({ channel: 'dev', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
    trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
    quietHistory()
    const first = {
      headSha: 'aaaaaaa',
      version: '0.4.2-dev.1+aaaaaaa',
      runningVersion: 'dev+7777777',
      branch: 'main',
      commits: [{ sha: 'aaaaaaa', summary: 'First proposal' }],
      addedMigrations: [],
      state: 'pending',
    }
    const latest = {
      ...first,
      headSha: 'bbbbbbb',
      version: '0.4.2-dev.2+bbbbbbb',
      commits: [{ sha: 'bbbbbbb', summary: 'Latest proposal' }],
    }
    trpc.updates.proposal.query.mockResolvedValueOnce(first).mockResolvedValue(latest)

    render(<UpdatesSection />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText('First proposal')).toBeTruthy()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WATCHED_POLL_MS)
    })
    expect(screen.getByText('Latest proposal')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Build and publish' }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(trpc.updates.approveProposal.mutate).toHaveBeenCalledWith({
      headSha: latest.headSha,
      version: latest.version,
    })
  })

  it('uses the server range and states an empty changelog without fleet data', async () => {
    developing = true
    trpc.setup.channel.query.mockResolvedValue({ channel: 'dev', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: 'dev+aaaaaaa' })
    trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
    quietHistory()
    trpc.updates.proposal.query.mockResolvedValue({
      headSha: 'aaaaaaa',
      version: '0.4.2-dev.1+aaaaaaa',
      runningVersion: 'dev+aaaaaaa',
      branch: 'main',
      commits: [],
      addedMigrations: [],
      state: 'pending',
    })

    render(<UpdatesSection />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('settings-release-proposal-server-transition').textContent).toContain(
      'Server: dev+aaaaaaa → dev.1 (aaaaaaa)',
    )
    expect(screen.getByText('No changes since what this server is running.')).toBeTruthy()
  })

  it('shows the running version, target, and per-machine version state', async () => {
    trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
    quietHistory()
    trpc.updates.fleet.query.mockResolvedValue({
      targetVersion: '0.4.2',
      total: 1,
      behind: 1,
      converging: 0,
      failed: 0,
      channelChecks: [],
      machines: [
        {
          id: 'machine-ludovico',
          version: '0.4.1',
          state: 'current',
          online: true,
          busy: false,
        },
      ],
    })

    firstMachine.targetVersion = '0.4.2'
    render(<UpdatesSection />)

    expect(await screen.findByText('0.4.1 → 0.4.2')).toBeTruthy()
    expect(screen.getByText('ludovico')).toBeTruthy()
    // Behind with nobody having accepted the offer is the mechanism working.
    expect(screen.getByText('Update waiting')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stable' }).getAttribute('aria-pressed')).toBe('true')
  })

  /**
   * Spec §2.2b's display rule, both halves: agreement collapses to ONE line, and
   * a divergence opens the whole breakdown with each row marked.
   */
  it('keeps one running-version line when every present component agrees', async () => {
    vi.stubGlobal('__PODIUM_DESKTOP__', { platform: 'linux', currentVersion: '0.4.1' })
    trpc.setup.channel.query.mockResolvedValue({ channel: 'edge', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
    quietHistory()
    trpc.updates.fleet.query.mockResolvedValue({
      ...emptyFleet,
      appVersion: '0.4.1',
      servedWebDigest: '47a01e3',
      servedMobileWeb: {
        present: true,
        appVersion: '0.4.1',
        digest: '47a01e3',
      },
    })

    render(<UpdatesSection />)

    await waitFor(() => expect(screen.getByTestId('running-version').textContent).toBe('0.4.1'))
    expect(screen.queryByTestId('component-version-breakdown')).toBeNull()
    expect(screen.getByTestId('running-version').textContent).toBe('0.4.1')
    expect(screen.queryByText('Server')).toBeNull()
    expect(screen.queryByText('Phone')).toBeNull()
    expect(screen.queryByText('Desktop app')).toBeNull()
  })

  it('keeps one running-version line when labels differ but build digests agree', async () => {
    webVersion = '0.1.1-edge.1'
    webDigest = 'a5f041c'
    trpc.setup.channel.query.mockResolvedValue({ channel: 'dev', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: 'dev+a5f041c' })
    quietHistory()
    trpc.updates.fleet.query.mockResolvedValue({
      ...emptyFleet,
      appVersion: 'dev+a5f041c',
      sourceDigest: 'a5f041c',
      servedWebDigest: 'a5f041c',
      servedMobileWeb: {
        present: true,
        appVersion: '0.1.1-edge.1',
        digest: 'a5f041c',
      },
    })

    render(<UpdatesSection />)

    await waitFor(() =>
      expect(screen.getByTestId('running-version').textContent).toBe('dev+a5f041c'),
    )
    expect(screen.queryByTestId('component-version-breakdown')).toBeNull()
  })

  it('marks a shell that trails its server on Development as expected', async () => {
    vi.stubGlobal('__PODIUM_DESKTOP__', { platform: 'macos', currentVersion: '0.1.0-edge.20' })
    trpc.setup.channel.query.mockResolvedValue({ channel: 'dev', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
    quietHistory()
    trpc.updates.fleet.query.mockResolvedValue({ ...emptyFleet, appVersion: '0.4.1' })

    render(<UpdatesSection />)

    expect(await screen.findByTestId('component-version-breakdown')).toBeTruthy()
    const desktop = screen.getByTestId('component-version-desktop')
    expect(desktop.textContent).toContain('0.1.0-edge.20')
    expect(desktop.textContent).toContain('Expected.')
    expect(desktop.textContent).toContain('Development runs the Edge app frame')
    // The shell's own version, never one inferred from the server beside it.
    expect(desktop.textContent).not.toContain('0.4.1')
  })

  it('shows a present phone export whose build identity is unavailable', async () => {
    trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
    quietHistory()
    trpc.updates.fleet.query.mockResolvedValue({
      ...emptyFleet,
      appVersion: '0.4.1',
      servedWebDigest: '47a01e3',
      servedMobileWeb: { present: true },
    })

    render(<UpdatesSection />)

    expect(await screen.findByTestId('component-version-breakdown')).toBeTruthy()
    expect(screen.getByText('Phone')).toBeTruthy()
    expect(screen.getByText('Build identity unavailable')).toBeTruthy()
  })

  it('names each component when the phone bundle comes from a different build', async () => {
    vi.stubGlobal('__PODIUM_DESKTOP__', { platform: 'linux', currentVersion: '0.4.1' })
    trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
    quietHistory()
    trpc.updates.fleet.query.mockResolvedValue({
      ...emptyFleet,
      appVersion: '0.4.1',
      servedWebDigest: '47a01e3',
      servedMobileWeb: {
        present: true,
        appVersion: '0.4.1',
        digest: 'aaaaaaa',
      },
    })

    render(<UpdatesSection />)

    expect(await screen.findByTestId('component-version-breakdown')).toBeTruthy()
    expect(screen.getByText('Server')).toBeTruthy()
    expect(screen.getByText('Interface')).toBeTruthy()
    expect(screen.getByText('Phone')).toBeTruthy()
    expect(screen.getByTestId('component-version-phone').textContent).toContain(
      'built from different source',
    )
    expect(screen.getByText('Desktop app')).toBeTruthy()
    expect(screen.queryByText('aaaaaaa')).toBeNull()
  })

  it('omits the desktop row outside the desktop shell', async () => {
    trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.2' })
    quietHistory()
    trpc.updates.fleet.query.mockResolvedValue({
      ...emptyFleet,
      appVersion: '0.4.2',
      servedWebDigest: '47a01e3',
      servedMobileWeb: {
        present: true,
        appVersion: '0.4.1',
        digest: '47a01e3',
      },
    })

    render(<UpdatesSection />)

    expect(await screen.findByTestId('component-version-breakdown')).toBeTruthy()
    expect(screen.getByText('Server')).toBeTruthy()
    expect(screen.getByText('Interface')).toBeTruthy()
    expect(screen.getByText('Phone')).toBeTruthy()
    expect(screen.queryByText('Desktop app')).toBeNull()
  })

  /**
   * A cached or built-in copy with matching build identity remains one line.
   * Source provenance alone does not open the version breakdown.
   */
  it('keeps a matching built-in copy on one line', async () => {
    pageServedFrom('tauri://localhost/')
    trpc.setup.channel.query.mockResolvedValue({ channel: 'edge', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
    quietHistory()
    trpc.updates.fleet.query.mockResolvedValue({ ...emptyFleet, appVersion: '0.4.1' })

    render(<UpdatesSection />)

    expect((await screen.findByTestId('running-version')).textContent).toBe('0.4.1')
    expect(screen.queryByTestId('component-version-breakdown')).toBeNull()
  })

  it('collapses on the same data when the page came from the server', async () => {
    // The twin of the case above, one fact apart: same versions, ordinary
    // origin. If the row stopped consulting the real source, one of this pair
    // would have to be wrong.
    trpc.setup.channel.query.mockResolvedValue({ channel: 'edge', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
    quietHistory()
    trpc.updates.fleet.query.mockResolvedValue({ ...emptyFleet, appVersion: '0.4.1' })

    render(<UpdatesSection />)

    expect((await screen.findByTestId('running-version')).textContent).toBe('0.4.1')
    expect(screen.queryByTestId('component-version-breakdown')).toBeNull()
  })

  it('shows every version in the operator display form', async () => {
    // POD-2502: a minted development version reads `dev.8 (77f0e91)`, never the
    // raw lineage string, and that holds for every row this panel prints.
    vi.stubGlobal('__PODIUM_DESKTOP__', { platform: 'macos', currentVersion: '0.1.1-edge.4' })
    trpc.setup.channel.query.mockResolvedValue({ channel: 'dev', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: '0.1.1-dev.7+ab12cd3' })
    quietHistory()
    webVersion = '0.1.1-dev.7+ab12cd3'
    trpc.updates.fleet.query.mockResolvedValue({
      ...emptyFleet,
      appVersion: '0.1.1-dev.7+ab12cd3',
      targetVersion: '0.1.1-dev.8+77f0e91',
    })

    firstMachine.targetVersion = '0.1.1-dev.8+77f0e91'
    render(<UpdatesSection />)

    expect((await screen.findByTestId('component-version-server')).textContent).toContain(
      'dev.7 (ab12cd3)',
    )
    expect(screen.getByTestId('component-version-interface').textContent).toContain(
      'dev.7 (ab12cd3)',
    )
    expect(screen.getByTestId('update-machine-machine-ludovico').textContent).toContain(
      'dev.8 (77f0e91)',
    )
    expect(document.body.textContent).not.toContain('0.1.1-dev.7+ab12cd3')
    expect(document.body.textContent).not.toContain('0.1.1-dev.8+77f0e91')
  })

  it('says where the running interface came from', async () => {
    trpc.setup.channel.query.mockResolvedValue({ channel: 'edge', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.2' })
    quietHistory()
    trpc.updates.fleet.query.mockResolvedValue({ ...emptyFleet, appVersion: '0.4.2' })
    // A page whose build trails the server it is talking to: mid-rollout, and
    // the row has to say so rather than look like a fault.
    webVersion = '0.4.1'

    render(<UpdatesSection />)

    const source = await screen.findByTestId('component-version-interface')
    expect(source.textContent).toContain('0.4.1')
    expect(source.textContent).toContain('Expected.')
    expect(source.textContent).toContain('Reloading')
  })

  it('keeps the channel selector writable', async () => {
    trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: 'dev+abc1234' })
    quietHistory()
    trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
    trpc.setup.setChannel.mutate.mockResolvedValue({ channel: 'edge', envForced: false })

    render(<UpdatesSection />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edge' }))

    await waitFor(() =>
      expect(trpc.setup.setChannel.mutate).toHaveBeenCalledWith({ channel: 'edge' }),
    )
    expect(screen.getByRole('button', { name: 'Edge' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('dev+abc1234')).toBeTruthy()
  })

  it('persists a stable switch into the native shell', async () => {
    const persist = vi.fn(async () => {})
    ;(globalThis as { __PODIUM_DESKTOP__?: NativeDesktopBridge }).__PODIUM_DESKTOP__ = {
      platform: 'macos',
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      setUpdateChannel: persist,
    }
    trpc.setup.channel.query.mockResolvedValue({ channel: 'edge', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1-edge.1' })
    quietHistory()
    trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
    trpc.setup.setChannel.mutate.mockResolvedValue({ channel: 'stable', envForced: false })

    render(<UpdatesSection />)
    fireEvent.click(await screen.findByRole('button', { name: 'Stable' }))

    await waitFor(() => {
      expect(trpc.setup.setChannel.mutate).toHaveBeenCalledWith({ channel: 'stable' })
      expect(persist).toHaveBeenCalledWith('stable', undefined)
    })
    expect(screen.getByRole('button', { name: 'Stable' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('repairs this Mac payload through its ordinary machine grant', async () => {
    ;(globalThis as { __PODIUM_DESKTOP__?: NativeDesktopBridge }).__PODIUM_DESKTOP__ = {
      platform: 'macos',
      launchMode: 'all-in-one',
      machineId: asMachineId('machine-ludovico'),
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    }
    trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
    quietHistory()
    trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
    trpc.updates.repairPayload.mutate.mockResolvedValue({
      outcome: { result: 'granted', version: '0.4.1' },
      fleet: emptyFleet,
    })

    render(<UpdatesSection />)
    fireEvent.click(await screen.findByRole('button', { name: 'Repair' }))

    await waitFor(() =>
      expect(trpc.updates.repairPayload.mutate).toHaveBeenCalledWith({
        id: 'machine-ludovico',
      }),
    )
    expect(
      await screen.findByText(
        'Repair granted. Podium will download the current payload and restart.',
      ),
    ).toBeTruthy()
  })

  /**
   * POD-5973. A VPS-connected desktop is a `client` to the page, and since POD-3431 it runs its
   * supervisor from a local payload — the row stays. Only a shell with no payload at all (a
   * 0.1.0 client: no `repairPayload`) leaves it out.
   */
  it.each([
    { label: 'a client shell that owns a payload', repairPayload: true, shown: true },
    { label: 'a client shell with no payload', repairPayload: false, shown: false },
  ])('offers payload repair to $label: $shown', async ({ repairPayload, shown }) => {
    ;(globalThis as { __PODIUM_DESKTOP__?: NativeDesktopBridge }).__PODIUM_DESKTOP__ = {
      platform: 'macos',
      launchMode: 'client',
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      ...(repairPayload ? { repairPayload: vi.fn(async () => {}) } : {}),
    }
    trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
    quietHistory()
    trpc.updates.fleet.query.mockResolvedValue(emptyFleet)

    render(<UpdatesSection />)
    await screen.findByRole('button', { name: 'Stable' })

    expect(screen.queryByRole('button', { name: 'Repair' }) !== null).toBe(shown)
  })

  /**
   * POD-1882. The fleet-default selector is ordinary operation, so it is always
   * here; only Development is gated. These four cases are the whole contract.
   */
  describe('Podium development gating', () => {
    it('offers only the released channels without the flag', async () => {
      trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      quietHistory()
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)

      render(<UpdatesSection />)

      expect(await screen.findByRole('button', { name: 'Stable' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Edge' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Development' })).toBeNull()
    })

    it('adds Development with the flag on, and can select it', async () => {
      developing = true
      trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      quietHistory()
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
      trpc.setup.setChannel.mutate.mockResolvedValue({ channel: 'dev', envForced: false })

      render(<UpdatesSection />)
      fireEvent.click(await screen.findByRole('button', { name: 'Development' }))

      await waitFor(() =>
        expect(trpc.setup.setChannel.mutate).toHaveBeenCalledWith({ channel: 'dev' }),
      )
      expect(screen.getByRole('button', { name: 'Development' }).getAttribute('aria-pressed')).toBe(
        'true',
      )
    })

    it('discloses a selected Development channel without offering it as an option', async () => {
      // Turning the flag off must not make the selector lie about where the fleet is.
      trpc.setup.channel.query.mockResolvedValue({ channel: 'dev', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      quietHistory()
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)

      render(<UpdatesSection />)

      expect(await screen.findByText('Development')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Development' })).toBeNull()
    })

    it('shows a machine channel pin with the development lab', async () => {
      developing = true
      trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      quietHistory()
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
      firstMachine.updateChannelOverride = 'dev'

      render(<UpdatesSection />)

      expect(await screen.findByText(/Pinned: Development/)).toBeTruthy()
    })
  })

  /**
   * Spec §6.3's last rule, as a gate: an internal precondition never reaches the
   * user. Both banned strings are fed in as the state that used to produce them.
   */
  describe('copy rules', () => {
    it('explains a channel with no trusted target in prose, never the precondition', async () => {
      trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      quietHistory()
      trpc.updates.fleet.query.mockResolvedValue({
        ...emptyFleet,
        channelChecks: [
          {
            channel: 'stable',
            checkedAt: Date.now() - 7_200_000,
            outcome: { status: 'unavailable', reason: 'stable target resolver is not configured.' },
          },
        ],
      })

      render(<UpdatesSection />)

      expect(await screen.findByText('2h ago · Nothing published on Stable yet.')).toBeTruthy()
      expect(screen.queryByText(/is not configured/)).toBeNull()
    })

    it('keeps a reason that is a real fact, inside a sentence', async () => {
      trpc.setup.channel.query.mockResolvedValue({ channel: 'dev', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      quietHistory()
      trpc.updates.fleet.query.mockResolvedValue({
        ...emptyFleet,
        channelChecks: [
          {
            channel: 'dev',
            checkedAt: Date.now() - 30_000,
            outcome: {
              status: 'unavailable',
              reason: 'The source checkout has 2 uncommitted changes.',
            },
          },
        ],
      })

      render(<UpdatesSection />)

      expect(
        await screen.findByText(
          /Nothing to install from Development yet: The source checkout has 2 uncommitted changes./,
        ),
      ).toBeTruthy()
    })

    it('collapses a successful channel check to one line', async () => {
      trpc.setup.channel.query.mockResolvedValue({ channel: 'dev', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      quietHistory()
      trpc.updates.fleet.query.mockResolvedValue({
        ...emptyFleet,
        targetVersion: '0.4.3',
        channelChecks: [{ channel: 'dev', checkedAt: Date.now(), outcome: { status: 'ok' } }],
      })

      render(<UpdatesSection />)

      expect(await screen.findByText('just now')).toBeTruthy()
    })

    it('never renders "No update target is configured." for a machine without one', async () => {
      trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      quietHistory()
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
      // The exact string the server throws, and the exact prefix this row used
      // to wrap it in, are the two things that must be gone.
      firstMachine.targetUnavailableReason = 'No update target is configured.'

      render(<UpdatesSection />)

      expect(await screen.findByText('Nothing published on Stable yet.')).toBeTruthy()
      expect(document.body.textContent).not.toContain('No update target is configured.')
      expect(document.body.textContent).not.toContain('No target:')
    })

    it('shows a capable supervisor as an ordinary fleet update', async () => {
      trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      quietHistory()
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
      firstMachine.targetVersion = '0.4.2'
      firstMachine.presenceSource = 'supervisor'
      firstMachine.deliveryCaps = ['update.delivery.feed']

      render(<UpdatesSection />)

      expect(await screen.findByText('Update waiting')).toBeTruthy()
      expect(document.body.textContent).not.toContain('Managed by Podium Desktop')
    })

    /**
     * §8c decision 14: nothing applies itself, so a machine sitting behind its
     * target is waiting for a person. A machine that TOOK the update and never
     * arrived is the different case, and only that one wears the warning.
     */
    it('separates a machine waiting to be updated from one that is stuck', async () => {
      trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.2' })
      quietHistory()
      trpc.updates.fleet.query.mockResolvedValue({
        ...emptyFleet,
        appVersion: '0.4.2',
        targetVersion: '0.4.2',
        allMachines: [
          {
            id: 'machine-ludovico',
            version: '0.4.1',
            state: 'stuck',
            online: true,
            busy: false,
            reason: {
              message: 'No report for 60 s after it said restarting; last phase: activating.',
              source: 'coordinator',
              at: 1000,
            },
          },
        ],
      })

      render(<UpdatesSection />)

      expect(await screen.findByText('Failed')).toBeTruthy()
      expect(screen.queryByText('Update available')).toBeNull()
      expect(
        screen.getByText('No report for 60 s after it said restarting; last phase: activating.'),
      ).toBeTruthy()
      expect(screen.getByText('inferred by the coordinator')).toBeTruthy()
    })
  })

  /** Spec §9.2: the cadence is shown, and a human can force it. */
  describe('Check now', () => {
    it('checks every channel and says it just happened', async () => {
      trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      quietHistory()
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
      trpc.updates.checkNow.mutate.mockResolvedValue([
        { channel: 'stable', checkedAt: Date.now(), outcome: { status: 'ok' } },
      ])

      render(<UpdatesSection />)
      fireEvent.click(await screen.findByRole('button', { name: 'Check now' }))

      await waitFor(() => expect(trpc.updates.checkNow.mutate).toHaveBeenCalled())
      expect(await screen.findByText('Checked just now.')).toBeTruthy()
    })

    it('does not pretend a rate-limited check was fresh', async () => {
      // The service returns the RECORDED outcome inside its 30 s window. The
      // answer is true; it is just not new, and the button has to say which.
      trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      quietHistory()
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
      trpc.updates.checkNow.mutate.mockResolvedValue([
        { channel: 'stable', checkedAt: Date.now() - 1_500_000, outcome: { status: 'ok' } },
      ])

      render(<UpdatesSection />)
      fireEvent.click(await screen.findByRole('button', { name: 'Check now' }))

      expect(
        await screen.findByText('Already checked 25m ago — that answer still stands.'),
      ).toBeTruthy()
    })

    it('reports a check that could not be made', async () => {
      trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      quietHistory()
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
      trpc.updates.checkNow.mutate.mockRejectedValue(new Error('the release feed did not answer'))

      render(<UpdatesSection />)
      fireEvent.click(await screen.findByRole('button', { name: 'Check now' }))

      expect(
        await screen.findByText(
          'Podium could not check for updates: the release feed did not answer',
        ),
      ).toBeTruthy()
    })
  })

  /** Spec §3.7: "did the update finish last night?" is answerable here. */
  describe('operation history', () => {
    it('lists past operations with target, when, outcome and duration', async () => {
      trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.3' })
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
      const startedAt = Date.now() - 36_000_000
      trpc.operations.history.query.mockResolvedValue([
        {
          id: 'op_01j',
          kind: 'update',
          state: 'done',
          details: { target: { version: '0.4.3' } },
          startedAt,
          finishedAt: startedAt + 240_000,
        },
      ])

      render(<UpdatesSection />)

      expect(await screen.findByText('Podium 0.4.3')).toBeTruthy()
      expect(screen.getByText('Finished')).toBeTruthy()
      expect(screen.getByText('10h ago · took 4 min')).toBeTruthy()
      expect(trpc.operations.history.query).toHaveBeenCalledWith({ kind: 'update', limit: 20 })
    })

    it('opens a failed operation into what happened, the next action, and the detail', async () => {
      trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.2' })
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
      trpc.operations.history.query.mockResolvedValue([
        {
          id: 'op_01k',
          kind: 'update',
          state: 'failed',
          details: { target: { version: '0.4.3' } },
          startedAt: Date.now() - 3_600_000,
          finishedAt: Date.now() - 3_500_000,
          error: {
            code: 'machine-dirty-checkout',
            message: 'vmi has local edits',
            detail: 'git status reported 3 modified files',
            places: ['vmi'],
          },
        },
      ])

      render(<UpdatesSection />)

      fireEvent.click(await screen.findByRole('button', { name: 'Why?' }))

      expect(screen.getByText(/local files or edits that prevent a safe update/)).toBeTruthy()
      expect(screen.getByText(/Commit, stash, move, or locally exclude/)).toBeTruthy()
      // The operation id travels with the copyable detail — that is what
      // "share the last failed update" needs (§3.7).
      expect(screen.getByText(/operation: op_01k/)).toBeTruthy()
    })

    it('says nothing has run yet rather than showing an empty table', async () => {
      trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
      quietHistory()

      render(<UpdatesSection />)

      expect(await screen.findByText('No updates have been run on this server yet.')).toBeTruthy()
    })

    it('keeps the rest of the page when the server has no history at all', async () => {
      // A server older than the operations table answers NOT_FOUND. That costs
      // this page the list and nothing else (P8).
      trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
      trpc.operations.history.query.mockRejectedValue(new Error('No procedure found'))

      render(<UpdatesSection />)

      expect(
        await screen.findByText('This server does not keep a record of past updates.'),
      ).toBeTruthy()
      // The running version and the machine both still report 0.4.1.
      expect(screen.getByTestId('running-version').textContent).toBe('0.4.1')
      expect(screen.getByTestId('update-machine-machine-ludovico').textContent).toContain('0.4.1')
      expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy()
    })
  })
})

/**
 * `updateScope: 'fleet-only'` (PDM-26). The deployment replaces the server
 * binary itself, so the section says who owns it rather than leaving an
 * operator to wonder why the fleet moves and the server never does.
 */
describe('a deployment that owns the server binary', () => {
  it('says server updates are the deployment’s, and machines still follow the feed', async () => {
    trpc.setup.channel.query.mockResolvedValue({
      channel: 'stable',
      envForced: false,
      updateScope: 'fleet-only',
    })
    trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
    trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
    quietHistory()

    render(<UpdatesSection />)

    expect(await screen.findByText(/Server updates are managed by this deployment/)).toBeTruthy()
  })

  it('says nothing under the default scope', async () => {
    trpc.setup.channel.query.mockResolvedValue({
      channel: 'stable',
      envForced: false,
      updateScope: 'all',
    })
    trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
    trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
    quietHistory()

    render(<UpdatesSection />)

    await screen.findByText('Update channel')
    expect(screen.queryByText(/Server updates are managed by this deployment/)).toBeNull()
  })

  it('a server too old to report a scope is treated as “all”', async () => {
    trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
    trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
    quietHistory()

    render(<UpdatesSection />)

    await screen.findByText('Update channel')
    expect(screen.queryByText(/Server updates are managed by this deployment/)).toBeNull()
  })
})

describe('Updates permissions and batch actions', () => {
  function ready() {
    trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
    trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
    quietHistory()
  }

  it('shows channel and history read-only for a member who manages no machines', async () => {
    ready()
    admin = false
    render(<UpdatesSection />)
    await screen.findByText('Stable')
    expect(screen.queryByRole('button', { name: 'Stable' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Apply update to/ })).toBeNull()
    expect(screen.getByText('History')).toBeTruthy()
  })

  it('updates every waiting online manageable machine, with row outcomes for partial failure', async () => {
    ready()
    Object.assign(firstMachine, { targetVersion: '0.4.2', online: true, transferable: true })
    const second = { ...firstMachine, id: asMachineId('second'), name: 'Second' }
    machines.push(
      second,
      { ...second, id: asMachineId('offline'), online: false },
      { ...second, id: asMachineId('current'), appVersion: '0.4.2' },
      { ...second, id: asMachineId('not-mine'), transferable: false },
    )
    trpc.machines.applyUpdate.mutate.mockImplementation(async ({ id }: { id: string }) => {
      if (id === 'second') throw new Error('Second could not download')
      return { outcome: { result: 'granted', version: '0.4.2' } }
    })
    render(<UpdatesSection />)
    fireEvent.click(await screen.findByRole('button', { name: 'Update 2 machines' }))
    await waitFor(() => expect(trpc.machines.applyUpdate.mutate).toHaveBeenCalledTimes(2))
    expect(trpc.machines.applyUpdate.mutate).toHaveBeenCalledWith({ id: 'machine-ludovico' })
    expect(trpc.machines.applyUpdate.mutate).toHaveBeenCalledWith({ id: 'second' })
    expect(await screen.findByText('Second could not download')).toBeTruthy()
    expect(screen.getByText('Updating ludovico to 0.4.2…')).toBeTruthy()
    expect(screen.getByTestId('update-machine-offline').textContent).toContain('Offline')
  })

  it('hides development publishing and channel pins when the lab is off', async () => {
    ready()
    firstMachine.updateChannelOverride = 'dev'
    trpc.updates.proposal.query.mockResolvedValue({
      headSha: 'aaaaaaa',
      version: '0.4.2-dev.1+aaaaaaa',
      branch: 'main',
      commits: [],
      addedMigrations: [],
      state: 'pending',
    })
    render(<UpdatesSection />)
    await screen.findByRole('button', { name: 'Stable' })
    expect(screen.queryByText('Development release')).toBeNull()
    expect(screen.queryByText(/Pinned:/)).toBeNull()
  })
})

describe('forced update channel', () => {
  it('discloses the override and prevents a channel write', async () => {
    trpc.setup.channel.query.mockResolvedValue({
      channel: 'edge',
      envForced: true,
      channelSource: 'file',
    })
    trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
    trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
    quietHistory()
    render(<UpdatesSection />)
    const stable = await screen.findByRole('button', { name: 'Stable' })
    expect(stable.hasAttribute('disabled')).toBe(true)
    fireEvent.click(stable)
    expect(trpc.setup.setChannel.mutate).not.toHaveBeenCalled()
    expect(screen.getByText(/config.json overrides/)).toBeTruthy()
  })
})

describe('member desktop recovery', () => {
  it('repairs the local installation through the native bridge without an admin command', async () => {
    admin = false
    const repair = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as { __PODIUM_DESKTOP__?: NativeDesktopBridge }).__PODIUM_DESKTOP__ = {
      currentVersion: '0.4.1',
      launchMode: 'client',
      platform: 'macos',
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      repairPayload: repair,
    }
    trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
    trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
    trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
    quietHistory()
    render(<UpdatesSection />)
    fireEvent.click(await screen.findByRole('button', { name: 'Repair' }))
    await waitFor(() => expect(repair).toHaveBeenCalledOnce())
    expect(trpc.updates.repairPayload.mutate).not.toHaveBeenCalled()
  })
})
