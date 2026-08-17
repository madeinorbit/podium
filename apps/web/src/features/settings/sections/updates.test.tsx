import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeDesktopBridge } from '@/lib/nativeDesktop'

const trpc = {
  setup: {
    channel: { query: vi.fn() },
    info: { query: vi.fn() },
    setChannel: { mutate: vi.fn() },
  },
  updates: { fleet: { query: vi.fn() }, checkNow: { mutate: vi.fn() } },
  operations: { history: { query: vi.fn() } },
}

const machines = [
  {
    id: 'machine-ludovico',
    name: 'ludovico',
    hostname: 'ludovico.local',
    appVersion: '0.4.1',
    versionState: 'behind',
    updateChannelOverride: null as string | null,
    targetUnavailableReason: null as string | null,
    targetVersion: null as string | null,
    supervised: false,
  },
]

vi.mock('@/app/store', () => ({
  useStoreSelector: (selector: (store: unknown) => unknown) => selector({ trpc, machines }),
}))

/** Settings → Experimental "Podium development" (POD-1882). */
let developing = false
vi.mock('@/lib/use-feature', () => ({ useFeature: () => developing }))

const { UpdatesSection } = await import('./updates')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  developing = false
  machines[0]!.updateChannelOverride = null
  machines[0]!.targetUnavailableReason = null
  machines[0]!.targetVersion = null
  machines[0]!.supervised = false
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

    render(<UpdatesSection />)

    expect(await screen.findByText('0.4.1')).toBeTruthy()
    expect(screen.getByText('0.4.2')).toBeTruthy()
    expect(screen.getByText('ludovico')).toBeTruthy()
    expect(screen.getByText('Behind target')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stable' }).getAttribute('aria-pressed')).toBe('true')
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
      expect(persist).toHaveBeenCalledWith('stable')
    })
    expect(screen.getByRole('button', { name: 'Stable' }).getAttribute('aria-pressed')).toBe('true')
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

    it('still shows Development when the fleet is ON dev and the flag is off', async () => {
      // Turning the flag off must not make the selector lie about where the fleet is.
      trpc.setup.channel.query.mockResolvedValue({ channel: 'dev', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      quietHistory()
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)

      render(<UpdatesSection />)

      const dev = await screen.findByRole('button', { name: 'Development' })
      expect(dev.getAttribute('aria-pressed')).toBe('true')
    })

    it('discloses a machine pinned away from the fleet default, flag or no flag', async () => {
      trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      quietHistory()
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
      machines[0]!.updateChannelOverride = 'dev'

      render(<UpdatesSection />)

      expect(await screen.findByText('Pinned: Development')).toBeTruthy()
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

      expect(await screen.findByText('Nothing published on Stable yet.')).toBeTruthy()
      expect(screen.getByText('checked 2h ago')).toBeTruthy()
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
          'Nothing to install from Development yet: The source checkout has 2 uncommitted changes.',
        ),
      ).toBeTruthy()
    })

    it('names the published version on a channel that answered', async () => {
      trpc.setup.channel.query.mockResolvedValue({ channel: 'dev', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      quietHistory()
      trpc.updates.fleet.query.mockResolvedValue({
        ...emptyFleet,
        targetVersion: '0.4.3',
        channelChecks: [{ channel: 'dev', checkedAt: Date.now(), outcome: { status: 'ok' } }],
      })

      render(<UpdatesSection />)

      expect(await screen.findByText('Podium 0.4.3 is published on Development.')).toBeTruthy()
      expect(screen.getByText('checked just now')).toBeTruthy()
    })

    it('never renders "No update target is configured." for a machine without one', async () => {
      trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      quietHistory()
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
      // The exact string the server throws, and the exact prefix this row used
      // to wrap it in, are the two things that must be gone.
      machines[0]!.targetUnavailableReason = 'No update target is configured.'

      render(<UpdatesSection />)

      expect(await screen.findByText('Nothing published on Stable yet.')).toBeTruthy()
      expect(document.body.textContent).not.toContain('No update target is configured.')
      expect(document.body.textContent).not.toContain('No target:')
    })

    it('says a supervised machine is the desktop app’s to update', async () => {
      trpc.setup.channel.query.mockResolvedValue({ channel: 'stable', envForced: false })
      trpc.setup.info.query.mockResolvedValue({ appVersion: '0.4.1' })
      quietHistory()
      trpc.updates.fleet.query.mockResolvedValue(emptyFleet)
      machines[0]!.supervised = true

      render(<UpdatesSection />)

      expect(await screen.findByText('Managed by Podium Desktop')).toBeTruthy()
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

      fireEvent.click(await screen.findByRole('button', { name: 'What happened?' }))

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
      expect(screen.getAllByText('0.4.1').length).toBe(2)
      expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy()
    })
  })
})
