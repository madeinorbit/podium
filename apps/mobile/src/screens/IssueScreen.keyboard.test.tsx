/**
 * THE COMMENT COMPOSER RIDES THE KEYBOARD [2026-08-28 device feedback].
 *
 * On iOS the task page's pinned composer sat under the software keyboard: the
 * field took focus, the keyboard rose over it, and the comment was typed blind.
 * The chat screens never had the bug because SessionConversation wraps its
 * feed-plus-composer in a KeyboardAvoidingView; the task page now carries the
 * same wrapper. The avoidance itself is native-keyboard behaviour no DOM lane
 * can observe — what CAN be pinned is the wiring: the composer (and the error
 * band that docks with it) must live INSIDE the avoiding view, because a
 * composer rendered beside it is exactly the regression that shipped.
 */
import { asIssueId, type IssueWire, type IssueWireInput } from '@podium/model'
import { cleanup, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
  selectionAsync: vi.fn(async () => {}),
}))
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ issueId: 'root' }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn(), canGoBack: () => false }),
  usePathname: () => '/issue/root',
}))
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
}))
// The real composer is chat furniture tested elsewhere; here it only has to be
// findable, so the test can say WHERE the page put it.
vi.mock('../components/Composer', async () => {
  const { View } = await import('react-native')
  return { Composer: () => <View testID="composer-stub" /> }
})

const { renderWithMobileStore } = await import('../client/test-support')
const { IssueScreen } = await import('./IssueScreen')

const issue = (partial: Partial<IssueWireInput> = {}): IssueWire =>
  ({
    id: asIssueId('root'),
    repoPath: '/src/podium',
    seq: 1,
    priority: 2,
    stage: 'in_progress',
    title: 'A task',
    description: '',
    labels: [],
    deps: [],
    dependents: [],
    needsHuman: false,
    childCount: 0,
    childDoneCount: 0,
    parentBranch: 'main',
    archived: false,
    ...partial,
  }) as IssueWire

describe('task page keyboard avoidance', () => {
  it('pins the comment composer inside the keyboard-avoiding view', async () => {
    await renderWithMobileStore(<IssueScreen />, { issues: [issue()] })

    const avoider = await screen.findByTestId('issue-keyboard-avoider')
    const composer = await screen.findByTestId('composer-stub')
    expect(avoider.contains(composer)).toBe(true)
  })
})
