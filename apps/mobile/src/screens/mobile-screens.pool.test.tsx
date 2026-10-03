/** Cumulative screen derivations, not a subscription guard: enable before bootstrap
 * and retain counts across updates, gestures, idle and provider rebuilds.
 * All data is synthetic. The real slice hooks/publisher are never mocked. */

import type { ClientRuntime } from '@podium/client-core/engine'
import { storeStats } from '@podium/client-core/perf'
import {
  createKernelReplica,
  createSideCache,
  entityForKind,
  issueViewModelProjectionStats,
  memoryStorage,
  type ReplicaKind,
  type ReplicaRows,
  rowKey,
} from '@podium/client-core/replica'
import { missionLegacyStats } from '@podium/client-core/viewmodels'
import type { EntityRecord } from '@podium/sync/replica'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { buildCorpus } from '../../../../packages/worklist-proto/harness/src/fixture'
import type { MobilePool } from '../client/mobile-pool'
import {
  ServerProfileContext,
  type ServerProfileContextValue,
} from '../client/server-profile-context'
import { renderWithMobileStore } from '../client/test-support'
import type { MobileTrpc } from '../client/trpc'

const state = vi.hoisted(() => ({
  host: null as MobilePool | null,
  missionId: '',
  paths: [] as string[][],
  runtime: null as ClientRuntime<MobileTrpc> | null,
  errors: [] as string[],
}))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return {
    useRouter: () => ({
      push: () => {},
      replace: () => {},
      back: () => {},
      dismissTo: () => {},
      canGoBack: () => false,
    }),
    useLocalSearchParams: () => ({ missionId: state.missionId }),
    usePathname: () => '/work',
    Stack: { SearchBar: () => null },
    useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
  }
})
// One real host/latch per app load. The provider supplies its own runtime.
vi.mock('../client/mobile-pool', async (importOriginal) => {
  const real = await importOriginal<typeof import('../client/mobile-pool')>()
  return {
    ...real,
    mobileDataLayer: () => state.host!.layer(),
    useMobilePool: () => state.host!.host.usePool(),
    useMobilePoolProjection: (read: never, empty: never) =>
      state.host!.host.usePoolProjection(read, empty),
    useMobileLaunchData: () => state.host!.host.usePoolProjection(readLaunch, null),
  }
})
function readLaunch(pool: Parameters<typeof commandLaunchViews>[0]) {
  const value = commandLaunchViews(pool).launch()
  return value && typeof value !== 'symbol' ? value : null
}

import { commandLaunchViews } from '@podium/client-graph/command-launch-views'

// Observe the real deck's inputs and keep its actual row rendering.
vi.mock('../components/MissionDeck', async (importOriginal) => {
  const real = await importOriginal<typeof import('../components/MissionDeck')>()
  return {
    MissionDeck: (props: ComponentProps<typeof real.MissionDeck>) => {
      state.paths.push(props.allWorktreePaths)
      return <real.MissionDeck {...props} />
    },
  }
})
// Native sheet/navigator containers are boundaries, not worklist readers.
vi.mock('../components/PressableScale', () => ({
  PressableScale: ({
    children,
    accessibilityLabel,
    onPress,
    onLongPress,
  }: {
    children: ReactNode
    accessibilityLabel?: string
    onPress?: () => void
    onLongPress?: () => void
  }) => (
    <button
      type="button"
      aria-label={accessibilityLabel}
      onClick={onPress}
      onContextMenu={onLongPress}
    >
      {children}
    </button>
  ),
}))
vi.mock('../components/Screen', () => ({
  Screen: ({
    title,
    subtitle,
    right,
    children,
  }: {
    title: string
    subtitle?: ReactNode
    right?: ReactNode
    children: ReactNode
  }) => (
    <div>
      {title}
      {subtitle}
      {right}
      {children}
    </div>
  ),
  HeaderButton: ({
    children,
    label,
    onPress,
  }: {
    children: ReactNode
    label: string
    onPress: () => void
  }) => (
    <button type="button" aria-label={label} onClick={onPress}>
      {children}
    </button>
  ),
}))
vi.mock('../components/LaunchPlaceholders', () => ({
  BootstrapCrossfade: ({ resolved, children }: { resolved: boolean; children: ReactNode }) => (
    <div data-resolved={resolved}>{children}</div>
  ),
  TasksSkeleton: () => null,
  DetailSkeleton: () => null,
  TranscriptSkeleton: () => null,
}))
vi.mock('../components/StorageNoticeAlert', () => ({ StorageNoticeAlert: () => null }))
vi.mock('../components/RefreshOffer', () => ({ RefreshOffer: () => null }))
vi.mock('../components/WorkspaceContinuityNotice', () => ({
  WorkspaceContinuityNotice: () => null,
}))
vi.mock('../components/PullToRefreshBoundary', () => ({
  PullToRefreshBoundary: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../components/BottomSheet', () => ({
  BottomSheet: ({
    visible,
    head,
    children,
    onClose,
  }: {
    visible: boolean
    head: ReactNode
    children: ReactNode
    onClose: () => void
  }) =>
    visible ? (
      <div>
        {head}
        {children}
        <button type="button" aria-label="Close sheet" onClick={onClose} />
      </div>
    ) : null,
}))
vi.mock('../components/ConfiguredIssueLaunchSheet', () => ({
  ConfiguredIssueLaunchSheet: () => null,
}))
vi.mock('../components/WorkIssueMenu', () => ({
  WorkIssueMenu: () => <div data-testid="work-menu" />,
}))
vi.mock('../hooks/useContentBottomInset', () => ({ useContentBottomInset: () => 0 }))
vi.mock('../hooks/useMinimizeTabBarOnScroll', () => ({ useMinimizeTabBarOnScroll: () => ({}) }))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('../hooks/useRefreshableTab', async () => {
  const { useRef } = await import('react')
  return {
    useRefreshableList: () => ({
      listRef: useRef(null),
      connected: true,
      refreshing: false,
      onRefresh: () => {},
    }),
    useRefreshableTab: () => ({
      listRef: useRef(null),
      refreshAccessibilityProps: {},
      connected: true,
      refreshing: false,
      onRefresh: () => {},
    }),
  }
})

vi.mock('expo-crypto', () => ({
  getRandomBytes: (size: number) => new Uint8Array(size),
  digest: async () => new ArrayBuffer(32),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}))
vi.mock('expo-clipboard', () => ({
  setStringAsync: async () => {},
  getStringAsync: async () => '',
  isPasteButtonAvailable: false,
  ClipboardPasteButton: () => null,
}))
vi.mock('expo-haptics', () => ({
  selectionAsync: async () => {},
  impactAsync: async () => {},
  notificationAsync: async () => {},
  ImpactFeedbackStyle: { Light: 'light' },
}))
vi.mock('../components/Composer', () => ({ Composer: () => <div data-testid="composer" /> }))
vi.mock('../hooks/useKeyboardHeight', () => ({ useKeyboardLift: () => 0 }))
vi.mock('expo-router/build/react-navigation/bottom-tabs', async () => {
  const { createContext } = await import('react')
  return { BottomTabBarHeightContext: createContext(undefined) }
})

vi.stubEnv('EXPO_OS', 'web')
const { createMobilePool } = await import('../client/mobile-pool')
const { IssuesScreen } = await import('./IssuesScreen')
const { MissionScreen } = await import('./MissionScreen')
const { MissionDetailsScreen } = await import('./MissionDetailsScreen')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function kernelFixture(corpus: ReturnType<typeof buildCorpus>) {
  const records = new Map<string, EntityRecord>()
  let seq = 1
  const key = (entity: string, id: string) => `${entity}:${id}`
  const install = <K extends ReplicaKind>(kind: K, rows: ReplicaRows[K][]) => {
    const entity = entityForKind(kind)
    for (const value of rows) {
      const entityId = rowKey(kind, value)
      records.set(key(entity, entityId), { entity, entityId, value, provenance: { seq } })
    }
  }
  install('issueProjections', corpus.issueProjections)
  install('issueUserStates', corpus.issueUserStates ?? [])
  install('issueGitStates', corpus.issueGitStates ?? [])
  install('repos', corpus.repoProjections)
  install('issueDeps', corpus.issueDeps)
  install('sessions', corpus.sessions)
  const replica = createKernelReplica({
    cache: {
      readCursor: () => ({ seq }),
      readEntities: () => [...records.values()],
      read: (entity, id) => records.get(key(entity, id)),
      durability: () => 'durable',
    },
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  return {
    replica,
    publish<K extends ReplicaKind>(kind: K, rows: ReplicaRows[K][]) {
      const entity = entityForKind(kind),
        keep = new Set(rows.map((row) => rowKey(kind, row)))
      replica.batch(() => {
        for (const [address, record] of records)
          if (record.entity === entity && !keep.has(record.entityId)) {
            records.delete(address)
            replica.onKernelEvent({ type: 'removed', entity, entityId: record.entityId })
          }
        for (const value of rows) {
          const entityId = rowKey(kind, value),
            address = key(entity, entityId)
          if (records.get(address)?.value === value) continue
          const record = { entity, entityId, value, provenance: { seq: ++seq } }
          records.set(address, record)
          replica.onKernelEvent({ type: 'upserted', record, readmitted: false })
        }
      })
    },
  }
}

const off = new Map<string, (string | null)[]>()
const profile: ServerProfileContextValue = {
  profile: {
    id: 'fixture',
    name: 'Phone fixture',
    httpOrigin: 'http://127.0.0.1:0',
    mode: 'open',
    transport: 'insecure-http',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  profiles: [],
  config: {
    httpOrigin: 'http://127.0.0.1:0',
    wsClientUrl: 'ws://127.0.0.1:0/client',
    override: true,
  },
  bearer: null,
  activation: 'verified',
  runtimeKey: 'phone-fixture',
  isEphemeralOverride: true,
  beginAddServer: () => {},
  switchProfile: async () => {},
  renameProfile: async () => {},
  removeProfile: async () => {},
  updateCredential: async () => {},
  recordUser: async () => {},
  revalidateOfflineProfile: async () => {},
}
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  storeStats.enable(false)
  storeStats.reset()
  missionLegacyStats.disable()
  missionLegacyStats.reset()
  state.paths.length = 0
  state.errors.length = 0
})
afterAll(() => vi.unstubAllEnvs())
it.each([
  false,
  true,
])('three mounted phone screens keep cumulative legacy derivations at zero (ON=%s)', async (on) => {
  storeStats.enable()
  storeStats.reset()
  missionLegacyStats.enable()
  missionLegacyStats.reset()
  const corpus = buildCorpus(1)
  const root = corpus.issueProjections
    .filter(
      (issue) =>
        !issue.parentId &&
        !issue.archived &&
        !issue.isDraftVessel &&
        issue.audience === 'human' &&
        issue.stage === 'in_progress' &&
        corpus.issueProjections.some(
          (child) => child.parentId === issue.id && !child.archived && !child.isDraftVessel,
        ),
    )
    .sort((a, b) => a.priority - b.priority || a.seq - b.seq)[0]!
  state.missionId = root.id
  let setting = on
  state.host = createMobilePool(false, () => ({ get: () => undefined, device: () => setting }))
  state.host.initialize({} as Parameters<MobilePool['initialize']>[0])
  const now = vi.spyOn(Date, 'now').mockReturnValue(corpus.fixedNow)
  const ticks: (() => void)[] = [],
    interval = globalThis.setInterval
  vi.spyOn(globalThis, 'setInterval').mockImplementation((handler, delay, ...args) => {
    if (delay === 60_000 && typeof handler === 'function') ticks.push(() => handler(...args))
    return interval(handler, delay, ...args)
  })
  const replicas: ReturnType<typeof kernelFixture>['replica'][] = []
  const phases: { phase: string; legacy: number; rows: number }[] = []
  let release!: () => void
  const receipt = new Promise<void>((resolve) => {
    release = resolve
  })
  async function mount(principal: string) {
    const feed = kernelFixture(corpus)
    replicas.push(feed.replica)
    const view = await renderWithMobileStore(
      <ServerProfileContext.Provider value={profile}>
        <div data-testid="tasks">
          <IssuesScreen />
        </div>
        <div data-testid="mission">
          <MissionScreen />
        </div>
        <div data-testid="details">
          <MissionDetailsScreen />
        </div>
      </ServerProfileContext.Provider>,
      {
        replica: feed.replica,
        principal,
        repos: corpus.repos,
        machines: corpus.machines,
        api: { issues: { update: { mutate: () => receipt } } },
        attachRuntime: (runtime) => {
          state.runtime = runtime
          return state.host!.host.attach(runtime, (cause) => state.errors.push(cause.message))
        },
      },
    )
    await waitFor(
      () => {
        expect(view.container.querySelectorAll('[data-resolved="false"]')).toHaveLength(0)
        expect(screen.getByLabelText(/In Progress, \d+ tasks/)).toBeDefined()
        expect(screen.getByTestId('details').textContent).toContain('Full')
      },
      { timeout: 30_000 },
    )
    return { view, feed }
  }
  function checkpoint(phase: string, parity = true) {
    const stats = storeStats.snapshot()
    expect(stats.enabled).toBe(true)
    expect(stats.dropped).toBe(0)
    expect(stats.runtimes.reduce((n, value) => n + value.publishes, 0)).toBeGreaterThan(0)
    let legacy = 0
    for (const name of ['tasks', 'mission', 'details', 'deck']) {
      const count = stats.runtimes.reduce(
        (n, value) => n + (value.slices[`mobileScreens.${name}`] ?? 0),
        0,
      )
      if (on) expect(count, `${phase} ${name}`).toBe(0)
      else expect(count, `${phase} ${name}`).toBeGreaterThan(0)
      legacy += count
    }
    const rows = replicas.reduce(
      (n, replica) => n + issueViewModelProjectionStats(replica).rowBuilds,
      0,
    )
    const missions = missionLegacyStats.read()
    if (on) {
      expect(rows, phase).toBe(0)
      expect(missions.indexMissionSessions, phase).toBe(0)
      expect(missions.missionIssueIds, phase).toBe(0)
    } else {
      expect(rows, phase).toBeGreaterThan(0)
      expect(missions.missionIssueIds, phase).toBeGreaterThan(0)
    }
    expect(state.errors).toEqual([])
    if (parity) {
      const text = ['tasks', 'mission', 'details'].map((id) => screen.getByTestId(id).textContent)
      if (on) expect(text, phase).toEqual(off.get(phase))
      else off.set(phase, text)
    }
    phases.push({ phase, legacy, rows })
  }
  const { view, feed } = await mount('u-bench')
  checkpoint('startup')
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Show done tasks'))
    fireEvent.click(screen.getByLabelText('Search tasks'))
  })
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: root.title } })
  })
  await waitFor(() => expect(screen.getByTestId('tasks').textContent).toContain(root.title))
  checkpoint('search and done')
  // Search by the stable reference while titles change. SectionList only mounts
  // its first window; this complex mission need not be in that initial window.
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: `#${root.seq}` } })
    fireEvent.click(screen.getByLabelText('Working'))
  })
  checkpoint('deck mode')
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Full'))
  })
  await act(async () => {
    fireEvent.click(screen.getByLabelText(/Fold every branch|Expand every branch/))
  })
  checkpoint('deck fold')
  const sessions = corpus.sessions.map((session, index) =>
    index === 0
      ? {
          ...session,
          title: 'Phone feed seat',
          lastActiveAt: new Date(corpus.fixedNow + 1_000).toISOString(),
        }
      : session,
  )
  await act(async () => feed.publish('sessions', sessions))
  checkpoint('session feed')
  const changed = corpus.issueProjections.map((issue) =>
    issue.id === root.id ? { ...issue, title: 'Phone feed title' } : issue,
  )
  await act(async () => feed.publish('issueProjections', changed))
  await waitFor(() => expect(screen.getByTestId('tasks').textContent).toContain('Phone feed title'))
  checkpoint('issue feed')
  let action!: Promise<void>
  await act(async () => {
    action = state.runtime!.getSnapshot().updateIssue(root.id, { title: 'Phone optimistic title' })
    await Promise.resolve()
  })
  await waitFor(() =>
    expect(screen.getByTestId('tasks').textContent).toContain('Phone optimistic title'),
  )
  checkpoint('optimistic action')
  await act(async () => {
    feed.publish(
      'issueProjections',
      changed.map((issue) =>
        issue.id === root.id ? { ...issue, title: 'Phone optimistic title' } : issue,
      ),
    )
    release()
    await action
  })
  checkpoint('server echo')
  const beforeClock = state.runtime!.getSnapshot().coarseNow
  expect(ticks.length).toBeGreaterThan(0)
  now.mockReturnValue(corpus.fixedNow + 60_000)
  await act(async () => {
    for (const tick of ticks) tick()
  })
  expect(state.runtime!.getSnapshot().coarseNow).toBeGreaterThan(beforeClock)
  checkpoint('idle clock')
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Close task search'))
  })
  checkpoint('clear search')
  const before = state.runtime
  view.unmount()
  setting = !on
  state.host.initialize({} as Parameters<MobilePool['initialize']>[0])
  expect(state.host.layer()).toBe(on ? 'pool' : 'legacy')
  await mount('u-next')
  expect(state.runtime).not.toBe(before)
  expect(storeStats.snapshot().runtimes.length).toBeGreaterThanOrEqual(2)
  checkpoint('provider rebuild', false)
  console.info('[phone legacy derivations]', JSON.stringify({ on, phases }))
}, 120_000)
