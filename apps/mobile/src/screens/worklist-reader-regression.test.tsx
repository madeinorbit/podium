import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
/** Cumulative derivations, not a subscription guard: enable before bootstrap
 * and retain counts across updates, gestures, idle and provider rebuilds.
 * All data is synthetic. The real slice hooks/publisher are never mocked. */

import type { ClientRuntime } from '@podium/client-core/engine'
import { storeStats } from '@podium/client-core/perf'
import {
  createKernelReplica,
  createSideCache,
  entityForKind,
  memoryStorage,
  type ReplicaKind,
  type ReplicaRows,
  rowKey,
} from '@podium/client-core/replica'
import { reposToViews, reposVisibleOnMachines } from '@podium/client-core/values'
import type { EntityRecord } from '@podium/sync/replica'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { buildCorpus } from '../../../../packages/worklist-proto/harness/src/fixture'
import type { MobilePool } from '../client/mobile-pool'
import { renderWithMobileStore } from '../client/test-support'
import type { MobileTrpc } from '../client/trpc'

const state = vi.hoisted(() => ({
  host: null as MobilePool | null,
  missionId: '',
  runtime: null as ClientRuntime<MobileTrpc> | null,
  errors: [] as string[],
}))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return {
    useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, dismissTo: () => {} }),
    useLocalSearchParams: () => ({ missionId: state.missionId }),
    usePathname: () => '/work',
    Stack: { SearchBar: () => null },
    useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
  }
})
// One real host per app load. The provider supplies its own runtime.
vi.mock('../client/mobile-pool', async (importOriginal) => {
  const real = await importOriginal<typeof import('../client/mobile-pool')>()
  return {
    ...real,
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
  WorkSkeleton: () => null,
  DetailSkeleton: () => null,
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
    useRefreshableTab: () => ({
      listRef: useRef(null),
      refreshAccessibilityProps: {},
      connected: true,
      refreshing: false,
      onRefresh: () => {},
    }),
  }
})
vi.stubEnv('EXPO_OS', 'web')
const { createMobilePool } = await import('../client/mobile-pool')
const { WorkScreen } = await import('./WorkScreen')
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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  storeStats.enable(false)
  storeStats.reset()
  state.errors.length = 0
})

afterAll(() => vi.unstubAllEnvs())

describe('mobile pool-only worklist regressions', () => {
  it('cumulative startup, gestures, feed, optimistic echo, idle and rebuild', async () => {
    storeStats.reset()
    storeStats.enable()
    const corpus = buildCorpus(1)
    const projects = reposToViews(reposVisibleOnMachines(corpus.repos, corpus.machines))
    corpus.pins = {
      panels: [],
      repos: [projects.at(-1)!.path, projects[0]!.path],
      worktrees: [projects[0]!.worktrees[0]!.path],
    }
    const root = corpus.issueProjections.find((issue) => !issue.parentId)!
    state.missionId = root.id
    state.host = createMobilePool(false)

    const now = vi.spyOn(Date, 'now').mockReturnValue(corpus.fixedNow)
    const ticks: (() => void)[] = []
    const realInterval = globalThis.setInterval
    vi.spyOn(globalThis, 'setInterval').mockImplementation((handler, delay, ...args) => {
      if (delay === 60_000 && typeof handler === 'function') ticks.push(() => handler(...args))
      return realInterval(handler, delay, ...args)
    })
    const phases: { phase: string; worklist: number }[] = []
    function checkpoint(phase: string) {
      const stats = storeStats.snapshot()
      expect(stats.enabled).toBe(true)
      expect(stats.dropped).toBe(0)
      expect(stats.runtimes.reduce((sum, runtime) => sum + runtime.publishes, 0)).toBeGreaterThan(0)
      const worklist = stats.runtimes.reduce(
        (sum, runtime) => sum + (runtime.slices.worklist ?? 0),
        0,
      )
      expect(worklist, phase).toBe(0)
      phases.push({ phase, worklist })
      expect(state.errors).toEqual([])
    }
    let release!: () => void
    const receipt = new Promise<void>((resolve) => {
      release = resolve
    })
    async function mount(principal: string) {
      const feed = kernelFixture(corpus)
      const view = await renderWithMobileStore(
        <>
          <WorkScreen />
          <MissionDetailsScreen />
        </>,
        {
          replica: feed.replica,
          principal,
          repos: corpus.repos,
          machines: corpus.machines,
          api: {
            pins: { list: { query: async () => corpus.pins } },
            issues: { update: { mutate: () => receipt } },
          },
          attachRuntime: (runtime) => {
            state.runtime = runtime
            return state.host!.host.attach(runtime, (cause) => {
              state.errors.push(cause.message)
            })
          },
        },
      )
      await waitFor(
        () => expect(view.container.querySelector('[data-resolved="true"]')).not.toBeNull(),
        { timeout: 30_000 },
      )
      return { view, feed }
    }
    const { view, feed } = await mount('u-bench')
    checkpoint('bootstrap and mission details')

    fireEvent.click(screen.getByLabelText('New work'))
    await waitFor(() => expect(screen.getAllByLabelText(/^Start in /).length).toBe(1))
    checkpoint('launch sheet')
    fireEvent.click(screen.getByLabelText('Close sheet'))
    checkpoint('close launch sheet')
    fireEvent.click(screen.getByLabelText('Search work'))
    checkpoint('search')

    const sessions = corpus.sessions.map((session, index) =>
      index === 0
        ? {
            ...session,
            title: 'Incoming mobile session',
            lastActiveAt: new Date(corpus.fixedNow + 1_000).toISOString(),
          }
        : session,
    )
    await act(async () => {
      feed.publish('sessions', sessions)
    })
    checkpoint('incoming session update')
    const changed = corpus.issueProjections.map((issue) =>
      issue.id === root.id ? { ...issue, title: 'Mobile feed title' } : issue,
    )
    await act(async () => {
      feed.publish('issueProjections', changed)
    })
    await waitFor(() => expect(view.container.textContent).toContain('Mobile feed title'))
    checkpoint('incoming issue update')

    let action!: Promise<void>
    await act(async () => {
      action = referenceState(state.runtime!)
        .updateIssue(root.id, { title: 'Mobile optimistic title' })
      await Promise.resolve()
    })
    await waitFor(() => expect(view.container.textContent).toContain('Mobile optimistic title'))
    checkpoint('optimistic edit through store action')
    await act(async () => {
      feed.publish(
        'issueProjections',
        changed.map((issue) =>
          issue.id === root.id ? { ...issue, title: 'Mobile optimistic title' } : issue,
        ),
      )
      release()
      await action
    })
    checkpoint('server echo')

    const clockBefore = referenceState(state.runtime!).coarseNow
    expect(ticks.length).toBeGreaterThan(0)
    now.mockReturnValue(corpus.fixedNow + 60_000)
    await act(async () => {
      for (const tick of ticks) tick()
    })
    expect(referenceState(state.runtime!).coarseNow).toBeGreaterThan(clockBefore)
    checkpoint('real idle clock callback')

    const before = state.runtime
    view.unmount()

    await mount('u-next')
    expect(state.runtime).not.toBe(before)
    expect(storeStats.snapshot().runtimes.length).toBeGreaterThanOrEqual(2)
    checkpoint('principal/provider rebuild')
    console.info('[mobile worklist derivations]', JSON.stringify({ phases }))
  }, 120_000)
})
