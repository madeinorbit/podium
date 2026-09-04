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

async function mount(onContentHeight: (height: number) => void = () => {}) {
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
      onContentHeight={onContentHeight}
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

  it('reports its natural height, and a narrower view reports a shorter one', async () => {
    const heights: number[] = []
    await mount((height) => heights.push(height))
    const full = heights.at(-1)
    expect(full).toBeGreaterThan(0)
    // `Needs you` drops the quiet subtask, so the deck's own arithmetic must
    // come back smaller — this is the wire the panel's dynamic height rides on.
    fireEvent.click(screen.getByText('Needs you'))
    expect(heights.at(-1)).toBeLessThan(full as number)
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
   * it: `Full`, `Working` and `Needs you` drew the identical screen, and the bar
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

    /** The same agent, mid-turn — the one thing `Working` is about (POD-1452). */
    const busy = {
      ...idle,
      agentState: { phase: 'working', since: '2026-08-04T20:15:44.230Z' },
    } as unknown as SessionMeta

    const mountSolo = async (session: SessionMeta = idle) =>
      renderWithMobileStore(
        <MissionDeck
          root={solo}
          issues={[solo]}
          sessions={[session]}
          allWorktreePaths={[]}
          accent="#8b5cf6"
          currentSessionId={undefined}
          onOpenSession={() => {}}
          onOpenTask={() => {}}
          onLaunchAgent={() => {}}
          onTuckRoot={() => {}}
          onFileRoot={() => {}}
          onOpenDeparture={() => {}}
          onContentHeight={() => {}}
        />,
        { issues: [solo], sessions: [session] },
      )

    it('shows the agent in Full', async () => {
      await mountSolo()
      expect(screen.getByText('Agent menu entry semantics')).toBeTruthy()
    })

    it('drops the agent in Needs you and says which view emptied the deck', async () => {
      await mountSolo()
      fireEvent.click(screen.getByText('Needs you'))
      expect(screen.queryByText('Agent menu entry semantics')).toBeNull()
      expect(screen.getByText('No agent in this mission is asking for you.')).toBeTruthy()
    })

    /**
     * POD-1452. `Active` — as `Working` was called — kept this agent because the
     * TASK was open, and it asked nothing about the agent itself, so a
     * standing-by session and a finished one wearing its ✓ both read as live
     * work. The view filters agents now: this one is idle, so it goes, and the
     * line says which view removed it.
     */
    it('drops a standing-by agent in Working and says which view emptied the deck', async () => {
      await mountSolo()
      fireEvent.click(screen.getByText('Working'))
      expect(screen.queryByText('Agent menu entry semantics')).toBeNull()
      expect(screen.getByText('No agent in this mission is working right now.')).toBeTruthy()
    })

    it('keeps the same agent in Working once it is mid-turn', async () => {
      await mountSolo(busy)
      fireEvent.click(screen.getByText('Working'))
      expect(screen.getByText('Agent menu entry semantics')).toBeTruthy()
    })
  })
})
