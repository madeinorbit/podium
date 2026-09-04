import type { IssuePanelArtifact, IssueWire } from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * THE VIEWER MUST NOT BE BORN INSIDE THE SHEET'S MODAL.
 *
 * The artifact viewer is a `Modal`, and it used to render inside the sheet
 * body — itself inside the BottomSheet's `Modal`. iOS silently drops a modal
 * presented from within another, so tapping an artifact in the peek did
 * NOTHING: no viewer, no fetch, no error (2026-08-28; proven from the device's
 * own URL cache, which held rows for every artifact opened elsewhere and none
 * for these). This pins the shape of the fix: the row hands the artifact up,
 * the sheet closes first, and only then does the viewer take the screen.
 */

afterEach(cleanup)

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(async () => {}),
}))
// Ships untranspiled Flow; the whole barrel is stubbed through a Proxy so any
// glyph a child reaches for resolves — rows are found by label, not by icon.
vi.mock('lucide-react-native', () => ({
  Activity: () => null,
  AlarmClock: () => null,
  AlertTriangle: () => null,
  ArrowDown: () => null,
  ArrowDownToLine: () => null,
  ArrowRight: () => null,
  ArrowUp: () => null,
  Check: () => null,
  CheckCircle2: () => null,
  ChevronDown: () => null,
  ChevronLeft: () => null,
  ChevronRight: () => null,
  ChevronUp: () => null,
  ChevronsDownUp: () => null,
  ChevronsUpDown: () => null,
  Circle: () => null,
  CircleDot: () => null,
  ClipboardPaste: () => null,
  Cpu: () => null,
  Eraser: () => null,
  ExternalLink: () => null,
  FileText: () => null,
  Flag: () => null,
  FlagOff: () => null,
  Gauge: () => null,
  GitBranch: () => null,
  GitCommit: () => null,
  GitMerge: () => null,
  Globe: () => null,
  Image: () => null,
  Inbox: () => null,
  KanbanSquare: () => null,
  Layers: () => null,
  Lightbulb: () => null,
  Link2: () => null,
  Mail: () => null,
  Maximize2: () => null,
  MessageCircleQuestion: () => null,
  MessagesSquare: () => null,
  Mic: () => null,
  MicOff: () => null,
  Monitor: () => null,
  Moon: () => null,
  MoreHorizontal: () => null,
  MoreVertical: () => null,
  Paperclip: () => null,
  Pencil: () => null,
  Pin: () => null,
  Play: () => null,
  Plus: () => null,
  RefreshCw: () => null,
  RotateCcw: () => null,
  Rows3: () => null,
  Search: () => null,
  Settings: () => null,
  SkipForward: () => null,
  Smartphone: () => null,
  Square: () => null,
  SquareTerminal: () => null,
  Trash2: () => null,
  Unlock: () => null,
  Users: () => null,
  X: () => null,
}))
vi.mock('react-native-svg', async () => {
  const { View } = await import('react-native')
  return {
    __esModule: true,
    default: View,
    Svg: View,
    Circle: View,
    Line: View,
    Path: View,
    G: View,
  }
})
vi.mock('./WorkingMark', () => ({ WorkingMark: () => null }))
vi.mock('./AgentMark', () => ({ HarnessChip: () => null, AgentMark: () => null }))
vi.mock('./Composer', () => ({ Composer: () => null }))
vi.mock('../client/hooks', () => ({
  useHttpOrigin: () => 'https://podium.local',
  useTrpc: () => ({ issues: { addComment: { mutate: vi.fn(async () => {}) } } }),
  useStoreActions: () => ({ updateIssue: vi.fn(), closeIssue: vi.fn() }),
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
// The sheet itself is not under test — only WHERE the viewer is mounted
// relative to it, so the sheet renders its children inline.
vi.mock('./BottomSheet', async () => {
  const { View } = await import('react-native')
  return {
    BottomSheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? <View testID="sheet">{children}</View> : null,
    dismissThen: (close: () => void, action: () => void) => () => {
      close()
      action()
    },
  }
})
vi.mock('./ArtifactViewer', async () => {
  const { Text } = await import('react-native')
  return {
    ArtifactViewer: ({ url }: { url: string | null }) =>
      url ? <Text testID="viewer">{url}</Text> : null,
  }
})

const { TaskSheet } = await import('./TaskSheet')

const artifact = { path: 'report.html', addedAt: '2026-08-28T10:00:00.000Z' } as IssuePanelArtifact

const issue = {
  id: 'iss_1',
  repoPath: '/tmp/repo',
  worktreePath: '/tmp/repo',
  seq: 7,
  title: 'A task with evidence',
  prefix: 'POD',
  stage: 'doing',
  panel: { todos: [], artifacts: [artifact], deferred: [] },
  description: '',
  deps: [],
  dependents: [],
  blockedBy: [],
  blocks: [],
  relatesTo: [],
  sessions: [],
  labels: [],
  comments: [],
  createdAt: '2026-08-28T09:00:00.000Z',
  updatedAt: '2026-08-28T10:00:00.000Z',
} as unknown as IssueWire

describe('TaskSheet artifacts', () => {
  it('closes the sheet first, then opens the viewer outside it', async () => {
    const onClose = vi.fn()
    render(
      <TaskSheet
        issue={issue}
        issues={[issue]}
        sessions={[]}
        onClose={onClose}
        onOpenSession={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByLabelText('Open report.html'))

    // The dismissal is the FIRST thing that happens — the viewer waits for it.
    expect(onClose).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByTestId('viewer')).toBeTruthy())
    expect(screen.getByTestId('viewer').textContent).toContain('report.html')
  })
})
