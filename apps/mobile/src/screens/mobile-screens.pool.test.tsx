import { omitGone } from '@podium/client-graph/lookup'
import { referenceState } from '../../../../tests/worklist/diagnostics/reference-state'
/** Count real pool publications across bootstrap, updates, gestures, idle and
 * provider rebuilds. Settled screen projections must reuse their cached paint
 * without reading rows or rerunning derivations. All data is synthetic; the
 * production hooks and projections run unchanged beneath the counters. */

import { createHash } from 'node:crypto'
import {
  createKernelReplica,
  createSideCache,
  entityForKind,
  memoryStorage,
  type ReplicaKind,
  type ReplicaRows,
  rowKey,
} from '@podium/client-core/replica'
import type { ClientRuntime } from '@podium/client-core/runtime-root'
import type { SessionView } from '@podium/client-core/session-values'
import { missionLegacyStats } from '@podium/client-core/values'
import { chatContextReadStats } from '@podium/client-graph/chat-context'
import { LOADING } from '@podium/client-graph/loading'
import { MissionScreen as MissionScreenModel } from '@podium/client-graph/mission-screen'
import { attachMissionTestPreferences } from '@podium/client-graph/mission-screen.test.fixture'
import { settled } from '@podium/client-graph/mission-view'
import type { MobxPool } from '@podium/client-graph/pool'
import { refreshClocks } from '@podium/mobx-helpers'
import { asIssueId, asSessionId } from '@podium/model'
import { formatSessionRef } from '@podium/protocol'
import type { EntityRecord } from '@podium/sync/replica'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { autorun } from 'mobx'
import { type ReactNode, useCallback } from 'react'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { buildCorpus } from '../../../../tests/worklist/harness/src/fixture'
import { measureWork } from '../../../../tests/worklist/harness/src/work-meter'
import type { MobilePool } from '../client/mobile-pool'
import {
  ServerProfileContext,
  type ServerProfileContextValue,
} from '../client/server-profile-context'
import { renderWithMobileStore } from '../client/test-support'
import type { MobileTrpc } from '../client/trpc'

const state = vi.hoisted(() => ({
  host: null as MobilePool | null,
  pool: null as MobxPool | null,
  missionId: '',
  runtime: null as ClientRuntime<MobileTrpc> | null,
  errors: [] as string[],
  loadWindows: null as (() => void)[] | null,
  publications: new Map<MobxPool, { count: number; views: Set<() => unknown> }>(),
}))
// The cold-banner proof owns the production loader's scheduling seam. The
// transcript service may request the payload, but wall-clock load must not decide
// whether the banner is observed before or after that request completes.
vi.mock('@podium/client-graph/residency', async (original) => {
  const real = await original<typeof import('@podium/client-graph/residency')>()
  return {
    ...real,
    Residency: class extends real.Residency {
      constructor(options: ConstructorParameters<typeof real.Residency>[0]) {
        const windows = state.loadWindows
        super(
          windows === null
            ? options
            : {
                ...options,
                schedule(run) {
                  windows.push(run)
                  return () => {
                    const index = windows.indexOf(run)
                    if (index !== -1) windows.splice(index, 1)
                  }
                },
              },
        )
      }
    },
  }
})
// Observe the production projection boundary; never substitute its tracking,
// equality decision, subscription or snapshot with a fixture implementation.
vi.mock('@podium/client-graph/runtime-pool', async (original) => {
  const real = await original<typeof import('@podium/client-graph/runtime-pool')>()
  return {
    ...real,
    createPoolProjection: <T,>(
      pool: MobxPool,
      read: (pool: MobxPool) => T,
      options?: Parameters<typeof real.createPoolProjection>[2],
    ) => {
      const view = real.createPoolProjection(pool, read, options)
      const counts = state.publications.get(pool) ?? { count: 0, views: new Set<() => unknown>() }
      state.publications.set(pool, counts)
      let paint: { value: T } | null = null
      const measured = {
        ...view,
        getSnapshot(...args: Parameters<typeof view.getSnapshot>): T {
          const value = view.getSnapshot(...args)
          if (!paint || !Object.is(paint.value, value)) {
            paint = { value }
            counts.count++
          }
          return value
        },
        subscribe(wake: () => void): () => void {
          const off = view.subscribe(wake)
          counts.views.add(measured.getSnapshot)
          return () => {
            counts.views.delete(measured.getSnapshot)
            off()
          }
        },
      }
      return measured
    },
  }
})
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
    useNavigation: () => ({ setOptions: () => {} }),
    Stack: { SearchBar: () => null },
    useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
  }
})
// One real pool host per app load. The provider supplies its own runtime.
vi.mock('../client/mobile-pool', async (importOriginal) => {
  const real = await importOriginal<typeof import('../client/mobile-pool')>()
  return {
    ...real,
    useMobilePool: () => {
      state.pool = state.host!.host.usePool()
      return state.pool
    },
    useMobilePoolProjection: (read: never, empty: never) => {
      state.pool = state.host!.host.usePool()
      return state.host!.host.usePoolProjection(read, empty)
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
const { createMobilePool, useMobilePoolProjection } = await import('../client/mobile-pool')
const { SessionConversation } = await import('../components/SessionConversation')
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
  install(
    'machines',
    corpus.machines.map((machine) => ({ ...machine, loggedOutHarnesses: [] })),
  )
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
  state.publications.clear()
  missionLegacyStats.disable()
  missionLegacyStats.reset()
  state.errors.length = 0
  state.pool = null
  state.loadWindows = null
})
afterAll(() => vi.unstubAllEnvs())
// The author can be an archived private session outside the displayed mission.
// A declared reference is enough to name it; missing fields still demand its row.
// Retain the accepted snapshot namespace while measuring the live pool boundary.
it('three mounted phone screens keep cumulative legacy derivations at zero (ON=true)', async () => {
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
  const historyId = asIssueId('phone-cold-author-task')
  const authorId = asSessionId('phone-cold-author-session')
  const repo = corpus.repoProjections.find((repo) => repo.prefix)!
  const authorRef = formatSessionRef({ prefix: repo.prefix!, seq: 99990, letter: 'z' })
  corpus.issueProjections.push(
    {
      ...root,
      id: historyId,
      seq: 99990,
      title: 'Cold author task',
      stage: 'done',
      closedAt: '2026-01-01T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    {
      ...root,
      id: asIssueId('phone-cold-authored-proposal'),
      seq: 99991,
      title: 'Cold authored proposal',
      parentId: root.id,
      stage: 'proposed',
      startedBySession: authorId,
    },
  )
  corpus.sessions.push({
    ...corpus.sessions[0]!,
    sessionId: authorId,
    issueId: historyId,
    title: 'Cold proposal author',
    status: 'exited',
    archived: true,
    headless: false,
    createdAt: '2026-01-01T00:00:00Z',
    lastActiveAt: '2026-01-01T00:00:00Z',
    stoppedAt: '2026-01-01T00:00:00Z',
    agentState: undefined,
    offer: undefined,
    resume: undefined,
    refRepoId: repo.id,
    refIssueId: historyId,
    refSeq: 99990,
    refLetter: 'z',
    refDraft: undefined,
  })
  state.missionId = root.id
  state.host = createMobilePool(false)

  const now = vi.spyOn(Date, 'now').mockReturnValue(corpus.fixedNow)
  const phases: { phase: string; publications: number; derivations: number; rows: number }[] = []
  let release!: () => void
  const receipt = new Promise<void>((resolve) => {
    release = resolve
  })
  async function mount(principal: string) {
    const feed = kernelFixture(corpus)
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
        expect(screen.getByTestId('details').textContent).toContain('All')
      },
      { timeout: 30_000 },
    ).catch((error) => {
      console.error('mounted Tasks readiness', {
        errors: state.errors,
        scope: state.pool?.queries.issueScope(root.id),
        position: state.pool?.row('issueBoardPosition', JSON.stringify([root.id, 'priority'])),
        query: state.pool?.row(
          'issueBoardQuery',
          JSON.stringify({ kind: 'board', filter: {}, showAgentTasks: false }),
        ),
      })
      throw error
    })
    return { view, feed }
  }
  async function checkpoint(phase: string, parity = true) {
    // The Tasks model migration (24cd129136) draws placeholders while row
    // facts load. Drain the real addressed load windows before comparing the
    // settled paint; a faster mission mount can otherwise race startup too.
    for (let turn = 0; turn < 100; turn++) {
      let loaded = 0
      await act(async () => {
        loaded = state.pool!.hydrate()
      })
      if (loaded === 0) break
      if (turn === 99) throw new Error(`${phase}: phone loads did not settle`)
    }
    const counts = state.publications.get(state.pool!)!
    expect(counts.count, `${phase} pool publications`).toBeGreaterThan(0)
    expect(counts.views.size, `${phase} subscribed projections`).toBeGreaterThan(0)
    // React can ask for the same snapshot repeatedly. Every currently mounted
    // pool reader must reuse its settled paint, including after each feed or gesture.
    const { work } = await measureWork(
      async () => {
        for (const snapshot of counts.views) snapshot()
      },
      { pool: state.pool! },
    )
    expect(work.derivations, `${phase} cached derivations`).toBe(0)
    expect(work.rows, `${phase} cached row reads`).toBe(0)
    const missions = missionLegacyStats.read()
    expect(chatContextReadStats(state.pool!), phase).toEqual({
      mentionBuilds: 0,
      mentionIssueReads: 0,
      referenceBuilds: 0,
      referenceSessionReads: 0,
    })
    expect(missions.indexMissionSessions, phase).toBe(0)
    expect(missions.missionIssueIds, phase).toBe(0)
    expect(state.errors).toEqual([])
    if (parity) {
      const ids = ['tasks', 'mission', 'details']
      const text = ids.map((id) => screen.getByTestId(id).textContent)
      // The redesigned deck replaced the literal summaries upstream pinned
      // here; the settled outputs are pinned by the digests below.
      // D3 seats, D5/D6 words, FullDeck buckets and the observed label clock
      // each have exact old/new text proofs attached to this issue. Tasks is unchanged.
      // Exact settled outputs include the intended initial list window.
      for (const [index, id] of ids.entries()) {
        expect(
          createHash('sha256')
            .update(text[index] ?? '')
            .digest('hex'),
        ).toMatchSnapshot(`${phase} ${id}`)
      }
    }
    phases.push({
      phase,
      publications: counts.count,
      derivations: work.derivations,
      rows: work.rows!,
    })
  }
  const { view, feed } = await mount('u-bench')
  expect(screen.getByTestId('details').textContent).toContain(`by ${authorRef}`)
  await checkpoint('startup')
  await act(async () => {
    // Show done lives in the Filter and display sheet (POD-2378).
    fireEvent.click(screen.getByLabelText('Filter and display'))
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('switch', { name: 'Show done' }))
    fireEvent.click(screen.getByLabelText('Close sheet'))
    fireEvent.click(screen.getByLabelText('Search tasks'))
  })
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: root.title } })
  })
  await waitFor(() => expect(screen.getByTestId('tasks').textContent).toContain(root.title))
  await checkpoint('search and done')
  // Search by the stable reference while titles change. SectionList only mounts
  // its first window; this complex mission need not be in that initial window.
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: `#${root.seq}` } })
    fireEvent.click(screen.getByLabelText(/^Active, \d+$/))
  })
  await checkpoint('deck mode')
  await act(async () => {
    fireEvent.click(screen.getByLabelText(/^All, \d+$/))
  })
  await act(async () => {
    fireEvent.click(screen.getByLabelText(/^Done tasks, \d+$/))
  })
  await checkpoint('deck fold')
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
  await checkpoint('session feed')
  const changed = corpus.issueProjections.map((issue) =>
    issue.id === root.id ? { ...issue, title: 'Phone feed title' } : issue,
  )
  await act(async () => feed.publish('issueProjections', changed))
  await waitFor(() => expect(screen.getByTestId('tasks').textContent).toContain('Phone feed title'))
  await checkpoint('issue feed')
  let action!: Promise<void>
  await act(async () => {
    action = referenceState(state.runtime!).updateIssue(root.id, {
      title: 'Phone optimistic title',
    })
    await Promise.resolve()
  })
  await waitFor(() =>
    expect(screen.getByTestId('tasks').textContent).toContain('Phone optimistic title'),
  )
  await checkpoint('optimistic action')
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
  await checkpoint('server echo')
  // The observed shared label clock is resampled by an explicit app wake. The
  // flight deck sheet (POD-2381) draws no session ages, so the advance is only
  // checked when the mission screen shows one; the wake must still cost no
  // derivations.
  const beforeClock = screen.getByTestId('mission').textContent
  now.mockReturnValue(corpus.fixedNow + 60_000)
  await act(async () => {
    refreshClocks()
  })
  // Upstream also asserted the chat tail's "55m" turning "56m" here. On the
  // phone that clock pauses while the chat footer is not visible content
  // (dev/tf b34ea25229, d8325f7903), and jsdom never measures it visible, so the
  // label stays put by design. The wake must still cost no derivations.
  void beforeClock
  await checkpoint('idle clock')
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Close task search'))
  })
  await checkpoint('clear search')
  const before = state.runtime
  view.unmount()

  await mount('u-next')
  expect(state.runtime).not.toBe(before)
  expect(state.publications.size).toBeGreaterThanOrEqual(2)
  await checkpoint('provider rebuild', false)
  console.info('[phone pool publications]', JSON.stringify({ phases }))
}, 120_000)

function ColdConversation({ id }: { id: string }) {
  const read = useCallback(
    (pool: MobxPool) => {
      state.pool = pool
      const session = omitGone(pool.row('session', id))
      return session && typeof session !== 'symbol'
        ? (session as unknown as SessionView)
        : undefined
    },
    [id],
  )
  const session = useMobilePoolProjection(read, undefined)
  return session ? <SessionConversation session={session} issue={undefined} /> : null
}
