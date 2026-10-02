/**
 * PHONE SESSION PAGE NAMES ITS OFFLINE MACHINE (this issue).
 *
 * The desktop chat shows "machine '<name>' is offline — showing last known
 * transcript" from live machine presence (session.machineId -> the store's
 * machines list, via isMachineOfflineForLiveTerminal) and clears it on
 * reattach. The phone session page showed nothing — only "Idle" — while the
 * machine was detached.
 *
 * These tests pin the phone's copy: presence goes offline -> banner naming
 * the machine; back online -> gone. Both offline shapes count: supervisor
 * loss (online false) and supervised daemon loss (online true, daemon false).
 */
import type { MachineWire, SessionMeta } from '@podium/model'
import { asMachineId } from '@podium/model'
import { cleanup, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'

afterEach(cleanup)

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Error: 'error' },
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 34, left: 0 }),
}))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('expo-blur', async () => {
  const { View } = await import('react-native')
  return { BlurView: (props: object) => <View {...props} /> }
})
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))
vi.mock('./LaunchPlaceholders', () => ({
  BootstrapCrossfade: ({ children }: { children: ReactNode }) => <>{children}</>,
  TranscriptSkeleton: () => null,
}))
vi.mock('./PullToRefreshBoundary', () => ({
  PullToRefreshBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('./SessionLifecycle', () => ({ MobileSessionLifecycle: () => null }))
vi.mock('./TaskSheet', () => ({ TaskSheet: () => null }))
vi.mock('./ArtifactViewer', () => ({ ArtifactViewer: () => null }))
vi.mock('./Composer', () => ({ Composer: () => null }))
vi.mock('./TranscriptList', () => ({
  TranscriptList: () => <div data-testid="transcript-list" />,
}))

const { SessionConversation } = await import('./SessionConversation')
const { useSession } = await import('../client/hooks')

const session = {
  sessionId: 'sess-offline',
  agentKind: 'claude-code',
  cwd: '/repo',
  status: 'live',
  title: 'Agent',
  machineId: 'm1',
  machineName: 'desk',
} as unknown as SessionMeta

function machine(over: Partial<MachineWire>): MachineWire {
  return {
    id: 'm1',
    name: 'desk',
    hostname: 'desk',
    online: true,
    availability: { epoch: 'boot-1', server: false, daemon: true, supervisor: true },
    lastSeenAt: new Date(0).toISOString(),
    ...over,
  } as unknown as MachineWire
}

const ONLINE = [
  machine({
    online: true,
    availability: {
      epoch: 'boot-1',
      server: false,
      daemon: true,
      supervisor: true,
    } as unknown as MachineWire['availability'],
  }),
]
const OFFLINE_SUPERVISOR = [machine({ online: false })]
const OFFLINE_DAEMON = [
  machine({
    online: true,
    availability: {
      epoch: 'boot-1',
      server: false,
      daemon: false,
      supervisor: true,
    } as unknown as MachineWire['availability'],
  }),
]

async function renderLive(initial: MachineWire[]) {
  // The engine re-runs discovery.refreshRepos when the machines scope
  // signature (id:online) moves, and the test stub's refresh REPLACES the
  // machine list. If it kept answering the initial ONLINE list, an
  // online->offline emit would be immediately overwritten. Answer the latest
  // emitted list instead, so the transition under test survives the refresh.
  let current: MachineWire[] = initial
  const view = await renderWithMobileStore(
    <SessionConversation session={session} issue={undefined} />,
    {
      sessions: [session],
      machines: initial,
      api: {
        discovery: {
          refreshRepos: {
            mutate: async () => ({
              repositories: [],
              diagnostics: [],
              machines: current,
            }),
          },
        },
        sessions: {
          transcriptRead: { query: async () => ({ items: [], hasMore: false }) },
          answerAskUserQuestion: { mutate: async () => ({ ok: true }) },
        },
      },
    },
  )
  const emitMachines = (next: MachineWire[]) => {
    current = next
    view.emit('machines', next)
  }
  return { ...view, emitMachines }
}

describe('phone session offline banner (POD-4873)', () => {
  it('shows the offline banner when live presence goes offline, clears on reattach', async () => {
    const view = await renderLive(ONLINE)

    await waitFor(() => expect(screen.getByTestId('transcript-list')).toBeTruthy())
    expect(screen.queryByTestId('machine-offline-banner')).toBeNull()

    await act(async () => {
      view.emitMachines(OFFLINE_SUPERVISOR)
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.getByTestId('machine-offline-banner')).toBeTruthy())
    const banner = screen.getByTestId('machine-offline-banner')
    expect(banner.textContent).toContain('desk')
    expect(banner.textContent?.toLowerCase()).toContain('offline')
    expect(banner.textContent).toContain('showing last known transcript')

    await act(async () => {
      view.emitMachines(ONLINE)
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.queryByTestId('machine-offline-banner')).toBeNull())
  })

  it('shows the banner for a supervised daemon loss (online true, daemon false)', async () => {
    const view = await renderLive(ONLINE)

    await waitFor(() => expect(screen.getByTestId('transcript-list')).toBeTruthy())
    expect(screen.queryByTestId('machine-offline-banner')).toBeNull()

    await act(async () => {
      view.emitMachines(OFFLINE_DAEMON)
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.getByTestId('machine-offline-banner')).toBeTruthy())
    expect(screen.getByTestId('machine-offline-banner').textContent).toContain('desk')

    await act(async () => {
      view.emitMachines(ONLINE)
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.queryByTestId('machine-offline-banner')).toBeNull())
  })
})

describe('phone offline machine label from session homes', () => {
  function LiveConversation() {
    const row = useSession(session.sessionId)
    return row ? <SessionConversation session={row} issue={undefined} /> : null
  }

  it.each([
    false,
    true,
  ])('uses the replicated name and observes a rename, stripped=%s', async (stripped) => {
    const row = { ...session, machineName: 'Stale session label' }
    if (stripped) Reflect.deleteProperty(row, 'machineName')
    const { replica } = await renderWithMobileStore(<LiveConversation />, {
      sessions: [row],
      machines: [machine({ online: false, name: 'Stale live label' })],
      machineProjections: [
        { id: asMachineId('m1'), name: 'Replicated desk', loggedOutHarnesses: [] },
      ],
    })
    const stored = replica.rows('sessions')[0]
    expect(screen.getByTestId('machine-offline-banner').textContent).toContain('Replicated desk')
    expect(screen.getByTestId('machine-offline-banner').textContent).not.toContain('Stale')
    await act(async () => {
      replica.applyChanges(
        'machines',
        [{ id: asMachineId('m1'), name: 'Renamed desk', loggedOutHarnesses: [] }],
        [],
      )
    })
    expect(screen.getByTestId('machine-offline-banner').textContent).toContain('Renamed desk')
    expect(replica.rows('sessions')[0]).toBe(stored)
    await act(async () => {
      replica.applyChanges(
        'machines',
        [{ id: asMachineId('m1'), name: '', loggedOutHarnesses: [] }],
        [],
      )
    })
    expect(screen.getByTestId('machine-offline-banner').textContent).toContain('This machine')
  })

  it('falls back to the legacy session label before the machine home arrives', async () => {
    await renderWithMobileStore(<LiveConversation />, {
      sessions: [session],
      machines: OFFLINE_SUPERVISOR,
    })
    expect(screen.getByTestId('machine-offline-banner').textContent).toContain('desk')
  })
})
