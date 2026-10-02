import type { IssueViewModel } from '@podium/client-core/replica'
import {
  asIssueId,
  asSessionId,
  asUserId,
  type IssueGitStateProjection,
  type IssueProjection,
  type IssueUserStateWire,
  type RepoProjection,
} from '@podium/model'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoreActions } from '../client/hooks'
import { useBooting, useIssue, useIssues, useStoreActions } from '../client/hooks'

afterEach(cleanup)

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
  selectionAsync: vi.fn(async () => {}),
}))
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
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
// Sheets drag with react-native-gesture-handler, whose native module has no
// host in this lane. Nothing here opens one.
vi.mock('../components/BottomSheet', () => ({
  BottomSheet: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? children : null,
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
const { IssuesScreen } = await import('./IssuesScreen')
const { MissionScreen } = await import('./MissionScreen')
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
const fixture = {
  issues: [],
  issueProjections: [projection],
  issueUserStates: [markers],
  issueGitStates: [git],
  repoProjections: [repo],
}
let latest: IssueViewModel | undefined
let actions: StoreActions
function Probe() {
  latest = useIssue('root')
  actions = useStoreActions()
  const issues = useIssues()
  const booting = useBooting()
  return <div data-testid="model">{JSON.stringify({ list: issues, detail: latest, booting })}</div>
}

describe('mobile normalized issue reads with no legacy issue rows', () => {
  it.each([
    ['issue list', IssuesScreen],
    ['mission', MissionScreen],
    ['issue detail', IssueScreen],
  ])('renders the %s screen from normalized homes', async (_name, Surface) => {
    const mounted = await renderWithMobileStore(<Surface />, fixture)
    expect(mounted.replica.rows('issues')).toEqual([])
    await waitFor(() =>
      expect(screen.getAllByText('Normalized mobile mission').length).toBeGreaterThan(0),
    )
    expect(screen.getAllByText(/POD-42/).length).toBeGreaterThan(0)
    if (Surface === IssueScreen) {
      expect(screen.getByText('The normalized description.')).toBeTruthy()
      expect(screen.getByText('Ship normalized mobile?')).toBeTruthy()
    }
  })

  it('joins repo/git/personal kinds, and exposes no legacy spellings', async () => {
    await renderWithMobileStore(<Probe />, fixture)
    expect(latest).toMatchObject({
      displayRef: 'POD-42',
      repoPath: '/normalized/podium',
      pinned: true,
      readAt: markers.readAt,
      gitState: { ahead: 2, merged: false },
      intentOrigin: 'agent',
      isDraftVessel: false,
      asked: { question: 'Ship normalized mobile?' },
    })
    expect(latest).not.toHaveProperty('draft')
    expect(latest).not.toHaveProperty('origin')
    expect(latest).not.toHaveProperty('humanQuestion')
    expect(screen.getByTestId('model').textContent).toContain('"booting":false')
  })

  it('renders before related kinds arrive, then follows evict and readmission', async () => {
    const { replica } = await renderWithMobileStore(<Probe />, { issueProjections: [projection] })
    expect(latest).toMatchObject({
      title: projection.title,
      pinned: false,
      readAt: null,
      repoPath: '',
    })
    await act(async () => replica.applyChanges('repos', [repo], []))
    expect(latest?.repoPath).toBe('/normalized/podium')
    await act(async () => replica.applyChanges('issueProjections', [], [projection.id]))
    expect(latest).toBeUndefined()
    await act(async () => replica.applyChanges('issueProjections', [projection], []))
    expect(latest?.title).toBe(projection.title)
  })

  it('paints normalized edits and rolls them back after a refused update', async () => {
    let refuse: (error: Error) => void = () => {}
    const pending = new Promise<never>((_resolve, reject) => {
      refuse = reject
    })
    const update = vi.fn(() => pending)
    await renderWithMobileStore(<Probe />, {
      ...fixture,
      api: { issues: { update: { mutate: update } } },
    })
    let completion: Promise<unknown> | undefined
    await act(async () => {
      completion = actions
        .updateIssue(projection.id, { title: 'Optimistic normalized title' })
        .catch(() => {})
    })
    expect(latest?.title).toBe('Optimistic normalized title')
    await waitFor(() => expect(update).toHaveBeenCalled())
    await act(async () => {
      refuse(
        Object.assign(new Error('forbidden'), { data: { code: 'FORBIDDEN', httpStatus: 403 } }),
      )
      await completion
    })
    await waitFor(() => expect(latest?.title).toBe(projection.title))
  })
})
