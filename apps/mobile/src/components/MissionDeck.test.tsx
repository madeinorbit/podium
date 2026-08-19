import { asIssueId, type IssueWire, type IssueWireInput } from '@podium/model'
import { cleanup, fireEvent, screen } from '@testing-library/react'
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
// Flow-typed RN icon source never parses in this lane; every glyph is a no-op.
vi.mock('lucide-react-native', () => ({
  ArrowDown: () => null,
  Check: () => null,
  ChevronDown: () => null,
  ChevronsDownUp: () => null,
  ChevronsUpDown: () => null,
  Plus: () => null,
  X: () => null,
}))

// The spine draws its rails with react-native-svg, whose RN source never parses
// in this lane; the geometry is not what this file is about.
vi.mock('react-native-svg', () => ({
  default: ({ children }: { children?: unknown }) => children ?? null,
  Line: () => null,
  Circle: () => null,
  Path: () => null,
  Rect: () => null,
  G: () => null,
}))

const { MissionDeck } = await import('./MissionDeck')

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

const root = issue({ id: asIssueId('root'), seq: 1, title: 'The mission' })
const quiet = issue({
  id: asIssueId('quiet'),
  parentId: asIssueId('root'),
  seq: 2,
  title: 'Quiet subtask',
})
const asking = issue({
  id: asIssueId('asking'),
  parentId: asIssueId('root'),
  seq: 3,
  stage: 'review',
  title: 'Asking subtask',
})

async function mount() {
  return renderWithMobileStore(
    <MissionDeck
      root={root}
      issues={[root, quiet, asking]}
      sessions={[]}
      allWorktreePaths={[]}
      accent="#8b5cf6"
      currentSessionId={undefined}
      onOpenSession={() => {}}
      onOpenTask={() => {}}
      onLaunchAgent={() => {}}
      onTuckRoot={() => {}}
      onFileRoot={() => {}}
      onOpenDeparture={() => {}}
    />,
    { issues: [root, quiet, asking] },
  )
}

describe('MissionDeck view bar', () => {
  it('shows every task in Full', async () => {
    await mount()
    expect(screen.getByText('Quiet subtask')).toBeTruthy()
    expect(screen.getByText('Asking subtask')).toBeTruthy()
  })

  it('drops the tasks that are not asking when Needs you is chosen', async () => {
    await mount()
    fireEvent.click(screen.getByText('Needs you'))
    expect(screen.getByText('Asking subtask')).toBeTruthy()
    expect(screen.queryByText('Quiet subtask')).toBeNull()
  })
})
