import { createHash } from 'node:crypto'
import type { ClientRuntime } from '@podium/client-core/engine'
import { readRuntimeStoreStats, storeStats } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import {
  createKernelReplica,
  createSideCache,
  entityForKind,
  memoryStorage,
  type ReplicaKind,
  type ReplicaRows,
  rowKey,
} from '@podium/client-core/replica'
import type { MobxPool } from '@podium/client-graph/pool'
import {
  asIssueId,
  asSessionId,
  asUserId,
  type IssueGitStateProjection,
  type IssueProjection,
  type IssueUserStateWire,
  type RepoProjection,
} from '@podium/model'
import type { EntityRecord } from '@podium/sync/replica'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { type ReactNode, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startCensus } from '../../../../tests/worklist/harness/src/mobx-census'
import type { MobilePool } from '../client/mobile-pool'
import type { MobileTrpc } from '../client/trpc'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const state = vi.hoisted(() => ({
  host: null as MobilePool | null,
  pool: null as MobxPool | null,
  runtime: null as ClientRuntime<MobileTrpc> | null,
  reads: 0,
  measuring: false,
  errors: [] as string[],
}))
vi.mock('../client/mobile-pool', async (original) => ({
  ...(await original<typeof import('../client/mobile-pool')>()),
  useMobilePool: () => {
    state.pool = state.host!.host.usePool()
    return state.pool
  },
  useMobilePoolProjection: (read: never, empty: never) =>
    state.host!.host.usePoolProjection(read, empty),
}))
// Preserve the relative-time output captured by the accepted control.
beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-03T19:30:00Z')))
afterEach(() => {
  cleanup()
  storeStats.enable(false)
  storeStats.reset()
  vi.restoreAllMocks()
})

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
  selectionAsync: vi.fn(async () => {}),
}))
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null, SearchBar: () => null },
  useLocalSearchParams: () => ({ issueId: 'root', missionId: 'root' }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn(), canGoBack: () => false }),
  usePathname: () => '/issue/root',
}))
// The real screen stays mounted; only its native tab navigator has no host.
vi.mock('expo-router/build/react-navigation/bottom-tabs', async () => {
  const { createContext } = await import('react')
  return { BottomTabBarHeightContext: createContext<number | undefined>(undefined) }
})
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 34, left: 0 }),
}))
// The agent panel reaches the server-profile gate, whose pairing module pulls
// expo-crypto — and expo-crypto's CJS build requires the `expo` package's
// TypeScript source, which Node cannot load in this lane. Nothing here pairs.
vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length),
  digest: async () => new ArrayBuffer(32),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
// Flow-typed RN icon source never parses in this lane; every glyph is a no-op.
// Named one by one because vitest validates a mock against the factory's OWN
// keys — when the task page's component tree grows an icon, this list grows.
vi.mock('lucide-react-native', () => ({
  AlertTriangle: () => null,
  ArrowRight: () => null,
  ArrowUp: () => null,
  CheckCircle2: () => null,
  ChevronDown: () => null,
  ChevronLeft: () => null,
  ChevronRight: () => null,
  ChevronUp: () => null,
  Circle: () => null,
  CircleDot: () => null,
  ClipboardPaste: () => null,
  ExternalLink: () => null,
  FileText: () => null,
  Flag: () => null,
  FlagOff: () => null,
  GitBranch: () => null,
  GitCommit: () => null,
  GitMerge: () => null,
  Link2: () => null,
  Mail: () => null,
  MessageCircleQuestion: () => null,
  Mic: () => null,
  MicOff: () => null,
  MoreHorizontal: () => null,
  Paperclip: () => null,
  Play: () => null,
  Plus: () => null,
  RefreshCw: () => null,
  Square: () => null,
  SquareTerminal: () => null,
  Trash2: () => null,
  Unlock: () => null,
  Users: () => null,
  X: () => null,
}))
// Status/priority glyphs draw with react-native-svg, whose RN source never
// parses in this lane; the geometry is not what this file is about.
vi.mock('react-native-svg', async () => {
  const { View } = await import('react-native')
  const Svg = ({ children }: { children?: ReactNode }) => <View>{children}</View>
  return {
    default: Svg,
    Svg,
    Circle: () => null,
    G: () => null,
    Line: () => null,
    Path: () => null,
    Rect: () => null,
  }
})
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))
// Only native drag geometry is mocked; the actual picker content stays mounted.
vi.mock('../components/BottomSheet', () => ({
  BottomSheet: ({
    visible,
    children,
    head,
    footer,
    virtualizedContent,
  }: {
    visible: boolean
    children?: ReactNode
    head?: ReactNode
    footer?: ReactNode
    virtualizedContent?: (scrollEnabled: boolean) => ReactNode
  }) =>
    visible ? (
      <div data-testid="page-sheet">
        {head}
        {children}
        {virtualizedContent?.(true)}
        {footer}
      </div>
    ) : null,
}))
vi.mock('../components/LaunchPlaceholders', () => ({
  BootstrapCrossfade: ({ children }: { children: ReactNode }) => <>{children}</>,
  DetailSkeleton: () => null,
  TasksSkeleton: () => null,
}))
// The real composer is chat furniture tested elsewhere; here it only has to be
// findable, so the test can say WHERE the page put it.
vi.mock('../components/Composer', async () => {
  const { View } = await import('react-native')
  return { Composer: () => <View testID="composer-stub" /> }
})

vi.mock('../components/TaskSheet', () => ({ TaskSheet: () => null }))
vi.mock('../components/SessionConversation', () => ({ SessionConversation: () => null }))
vi.mock('../components/PullToRefreshBoundary', () => ({
  PullToRefreshBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('../components/RefreshOffer', () => ({ RefreshOffer: () => null }))
vi.mock('../hooks/useRefreshableTab', () => ({
  useRefreshableTab: () => ({
    connected: false,
    refreshing: false,
    onRefresh: async () => {},
    listRef: { current: null },
  }),
}))
vi.mock('../hooks/useMinimizeTabBarOnScroll', () => ({ useMinimizeTabBarOnScroll: () => () => {} }))

const { renderWithMobileStore } = await import('../client/test-support')
const { createMobilePool, useMobilePool } = await import('../client/mobile-pool')
const { IssueScreen } = await import('./IssueScreen')
const projection = {
  id: asIssueId('root'),
  seq: 42,
  title: 'Normalized mobile mission',
  description: { value: 'The normalized description.' },
  stage: 'in_progress',
  priority: 2,
  type: 'task',
  archived: false,
  audience: 'human',
  intentOrigin: 'agent',
  isDraftVessel: false,
  needsHuman: true,
  asked: {
    question: 'Ship normalized mobile?',
    options: ['Ship', 'Hold'],
    by: asSessionId('asker'),
    at: '2026-09-30T10:00:00Z',
  },
  parentBranch: 'integrate/4286-pilot',
  repoId: 'repo',
  labels: [],
  blockedByNotes: [],
  createdAt: '2026-09-30T10:00:00Z',
  updatedAt: '2026-09-30T10:00:00Z',
} as unknown as IssueProjection
const markers: IssueUserStateWire = {
  userId: asUserId('user:test'),
  entityId: projection.id,
  readAt: '2026-09-30T12:00:00Z',
  tuckedAt: null,
  pinned: true,
}
const git = {
  id: projection.id,
  branch: 'issue/42',
  ahead: 2,
  merged: false,
  shared: false,
  dirtyFiles: 0,
  updatedAt: '2026-09-30T10:00:00Z',
} as IssueGitStateProjection
const repo = { id: 'repo', prefix: 'POD', repoPath: '/normalized/podium' } as RepoProjection

function pageReplica(issues: IssueProjection[]) {
  const records = new Map<string, EntityRecord>()
  const install = <K extends ReplicaKind>(kind: K, rows: ReplicaRows[K][]) => {
    const entity = entityForKind(kind)
    for (const value of rows) {
      const entityId = rowKey(kind, value)
      records.set(`${entity}:${entityId}`, { entity, entityId, value, provenance: { seq: 1 } })
    }
  }
  install('issueProjections', issues)
  install('issueUserStates', [markers])
  install('issueGitStates', [git])
  install('repos', [repo])
  return createKernelReplica({
    cache: {
      readCursor: () => ({ seq: 1 }),
      readEntities: () => [...records.values()],
      read: (entity, id) => records.get(`${entity}:${id}`),
      durability: () => 'durable',
    },
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
}
function OpenPage() {
  state.runtime = useStoreHandle<MobileTrpc>() as ClientRuntime<MobileTrpc>
  useMobilePool()
  const [open, setOpen] = useState(false)
  return open ? (
    <IssueScreen />
  ) : (
    <button type="button" onClick={() => setOpen(true)}>
      Open task
    </button>
  )
}
function fingerprint(container: HTMLElement) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        text: container.textContent,
        labels: [...container.querySelectorAll('[aria-label]')].map((node) =>
          node.getAttribute('aria-label'),
        ),
        styles: [...container.querySelectorAll('[style]')].map((node) =>
          node.getAttribute('style'),
        ),
      }),
    )
    .digest('hex')
}
it('keeps accepted task output and closed-picker per-open work flat at 1x and 4x', async () => {
  const cells: {
    scale: number
    rowReads: number
    derivations: number
    neighbours: number
    selectors: number
  }[] = []
  for (const scale of [1, 4]) {
    state.host = createMobilePool(false)

    state.pool = null
    state.errors = []
    state.reads = 0
    state.measuring = false
    const history = Array.from({ length: 1_200 * scale }, (_, index) => ({
      ...projection,
      id: asIssueId(`page-history-${index}`),
      seq: 100 + index,
      title: `Historical task ${index}`,
      needsHuman: false,
      asked: undefined,
      stage: 'done' as const,
      closedAt: '2026-01-01T00:00:00Z',
      archived: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }))
    const mounted = await renderWithMobileStore(<OpenPage />, {
      replica: pageReplica([projection, ...history]),
      attachRuntime: (runtime) =>
        state.host!.host.attach(runtime, (error) => state.errors.push(error.message)),
    })
    await waitFor(() => expect(state.pool).not.toBeNull(), { timeout: 30_000 })
    expect(state.errors).toEqual([])
    const row = state.pool!.row.bind(state.pool!)
    const spy = vi.spyOn(state.pool!, 'row').mockImplementation(((
      ...args: Parameters<MobxPool['row']>
    ) => {
      if (state.measuring) state.reads++
      return row(...args)
    }) as MobxPool['row'])
    const census = startCensus({ sample: () => ({ rowReads: state.reads }) })
    storeStats.enable()
    storeStats.reset()
    census.enter('open task')
    state.measuring = true
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Open task' }))
      await waitFor(() => expect(screen.getByText('The normalized description.')).toBeTruthy())
      await act(async () => {})
      expect(screen.getAllByText('Normalized mobile mission').length).toBeGreaterThan(0)
      expect(screen.getByText('Ship normalized mobile?')).toBeTruthy()
      expect(screen.queryByTestId('page-sheet')).toBeNull()
      // The paged history view (cb0ea6c26f) exposes this fixture's missing
      // events transport as a retry control; the former hook hid the error.
      // Its text, label and style are the entire accepted-output difference.
      await waitFor(() => expect(screen.getByLabelText('Show earlier activity')).toBeTruthy())
      console.info('[accepted closed task]', scale, fingerprint(mounted.container))
      expect(fingerprint(mounted.container)).toMatchSnapshot(`accepted closed task at ${scale}x`)
      census.exit()
      const phase = census.snapshot().phases['open task']!
      const stats = readRuntimeStoreStats(state.runtime!)!
      cells.push({
        scale,
        rowReads: state.reads,
        derivations: phase.computedRuns + phase.reactionRuns,
        neighbours: 1,
        selectors: stats?.selectorRuns ?? 0,
      })
    } finally {
      state.measuring = false
      census.stop()
      spy.mockRestore()
      mounted.unmount()
      storeStats.enable(false)
      storeStats.reset()
    }
  }
  console.info('[task open work]', JSON.stringify(cells))
  const [base, larger] = cells
  for (const metric of ['rowReads', 'derivations'] as const) {
    expect(
      larger![metric],
      `task open: 4x/1x ${metric} exceeds visible-neighbourhood ratio`,
    ).toBeLessThanOrEqual((base![metric] * larger!.neighbours) / base!.neighbours)
  }
  expect(cells.map((cell) => cell.selectors)).toEqual([0, 0])
})

it('keeps parent target order literal and row reads bounded by its visible choices', async () => {
  const cells: { scale: number; rowReads: number; derivations: number; neighbours: number }[] = []
  for (const scale of [1, 4]) {
    state.host = createMobilePool(false)

    state.pool = null
    state.errors = []
    state.reads = 0
    state.measuring = false
    const history = Array.from({ length: 1_200 * scale }, (_, index) => ({
      ...projection,
      id: asIssueId(`page-history-${index}`),
      seq: 100 + index,
      title: `Historical task ${index}`,
      needsHuman: false,
      asked: undefined,
      stage: 'done' as const,
      closedAt: '2026-01-01T00:00:00Z',
      archived: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }))
    const mounted = await renderWithMobileStore(<OpenPage />, {
      replica: pageReplica([projection, ...history]),
      attachRuntime: (runtime) =>
        state.host!.host.attach(runtime, (error) => state.errors.push(error.message)),
    })
    await waitFor(() => expect(state.pool).not.toBeNull(), { timeout: 30_000 })
    fireEvent.click(screen.getByRole('button', { name: 'Open task' }))
    await waitFor(() => expect(screen.getByText('The normalized description.')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Set parent' })).toBeTruthy())
    const row = state.pool!.row.bind(state.pool!)
    const spy = vi.spyOn(state.pool!, 'row').mockImplementation(((
      ...args: Parameters<MobxPool['row']>
    ) => {
      if (state.measuring) state.reads++
      return row(...args)
    }) as MobxPool['row'])
    const census = startCensus({ sample: () => ({ rowReads: state.reads }) })
    census.enter('open parent targets')
    state.measuring = true
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Set parent' }))
      await waitFor(() => expect(screen.getByLabelText('Search parent')).toBeTruthy())
      const choices = screen.getAllByRole('button', { name: /^POD-\d+ Historical task / })
      expect(choices).toHaveLength(14)
      expect(choices.map((choice) => choice.getAttribute('aria-label'))).toEqual(
        Array.from({ length: 14 }, (_, at) => {
          const index = history.length - 1 - at
          return `POD-${100 + index} Historical task ${index}`
        }),
      )
      census.exit()
      const phase = census.snapshot().phases['open parent targets']!
      cells.push({
        scale,
        rowReads: state.reads,
        derivations: phase.computedRuns + phase.reactionRuns,
        neighbours: choices.length,
      })
      // The same archived targets remain searchable by title and display ref;
      // the expected values are literal, independent of the source question.
      state.measuring = false
      fireEvent.change(screen.getByLabelText('Search parent'), {
        target: { value: '  Historical task 1199  ' },
      })
      await waitFor(() =>
        expect(
          screen
            .getAllByRole('button', { name: /^POD-\d+ Historical task / })
            .map((choice) => choice.getAttribute('aria-label')),
        ).toEqual(['POD-1299 Historical task 1199']),
      )
      for (const query of ['#1299', 'pod 1299']) {
        fireEvent.change(screen.getByLabelText('Search parent'), { target: { value: query } })
        await waitFor(() =>
          expect(
            screen
              .getAllByRole('button', { name: /^POD-\d+ Historical task / })
              .map((choice) => choice.getAttribute('aria-label')),
          ).toEqual(['POD-1299 Historical task 1199']),
        )
      }
    } finally {
      state.measuring = false
      census.stop()
      spy.mockRestore()
      mounted.unmount()
    }
  }
  console.info('[parent picker open work]', JSON.stringify(cells))
  const [base, larger] = cells
  for (const metric of ['rowReads', 'derivations'] as const)
    expect(
      larger![metric],
      `parent picker: 4x/1x ${metric} exceeds visible-neighbourhood ratio`,
    ).toBeLessThanOrEqual((base![metric] * larger!.neighbours) / base!.neighbours)
}, 60_000)
