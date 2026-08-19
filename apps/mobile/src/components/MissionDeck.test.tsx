import {
  asIssueId,
  asSessionId,
  type IssueWire,
  type IssueWireInput,
  type SessionMeta,
} from '@podium/model'
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
// Named one by one because vitest validates a mock against the factory's OWN
// keys — a Proxy's getter is never consulted — so when the deck's component
// tree grows an icon, this list is what has to grow with it.
vi.mock('lucide-react-native', () => ({
  ArrowDown: () => null,
  Check: () => null,
  ChevronDown: () => null,
  ChevronsDownUp: () => null,
  ChevronsUpDown: () => null,
  Plus: () => null,
  SquareTerminal: () => null,
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

  /**
   * THE ONE-TASK MISSION — POD-383, and the case the bar actually failed on.
   *
   * Most missions here are a single issue with an agent on it and no sub-tasks,
   * so the spine is empty and the whole deck IS the header's roster. That roster
   * was read with `matched` forced true, which meant no view could ever remove
   * it: `Full`, `Active` and `Needs you` drew the identical screen, and the bar
   * looked broken because on that mission it was.
   */
  describe('a mission with no sub-tasks and an idle agent', () => {
    const solo = issue({ id: asIssueId('solo'), seq: 9, stage: 'planning', title: 'Run now' })
    const idle = {
      sessionId: asSessionId('s-idle'),
      issueId: asIssueId('solo'),
      agentKind: 'claude-code',
      title: 'Agent menu entry semantics',
      name: 'Agent menu entry semantics',
      cwd: '/src/podium',
      status: 'live',
      controllerId: null,
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
      clientCount: 1,
      createdAt: '2026-08-04T20:15:44.230Z',
      lastActiveAt: '2026-08-04T20:15:44.230Z',
      origin: { kind: 'spawn' },
      archived: false,
      readAt: null,
      unread: false,
      agentState: { phase: 'idle', since: '2026-08-04T20:15:44.230Z' },
    } as unknown as SessionMeta

    const mountSolo = async () =>
      renderWithMobileStore(
        <MissionDeck
          root={solo}
          issues={[solo]}
          sessions={[idle]}
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
        { issues: [solo], sessions: [idle] },
      )

    it('shows the agent in Full', async () => {
      await mountSolo()
      expect(screen.getByText('Agent menu entry semantics')).toBeTruthy()
    })

    it('drops the agent in Needs you and says which view emptied the deck', async () => {
      await mountSolo()
      fireEvent.click(screen.getByText('Needs you'))
      expect(screen.queryByText('Agent menu entry semantics')).toBeNull()
      expect(screen.getByText('Nothing in this mission is asking for you.')).toBeTruthy()
    })

    /** `Active` is about work still in play, and this task is open with a live
     *  agent on it — so it stays, and the view is right to keep it. */
    it('keeps the agent in Active', async () => {
      await mountSolo()
      fireEvent.click(screen.getByText('Active'))
      expect(screen.getByText('Agent menu entry semantics')).toBeTruthy()
    })
  })
})
