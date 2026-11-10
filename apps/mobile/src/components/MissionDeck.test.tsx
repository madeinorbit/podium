import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { asIssueId, asSessionId } from '@podium/model'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMissionOpening } from '../client/hooks'
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
vi.mock('./WorkingMark', () => ({ WorkingMark: () => null }))

const { MissionDeck } = await import('./MissionDeck')
const { observer } = await import('mobx-react-lite')

/** The details route's root: one opening of the mission, the deck under it. */
const Opened = observer(function Opened({
  rootId,
  ...props
}: Omit<ComponentProps<typeof MissionDeck>, 'screen'> & { rootId: string }) {
  const { screen } = useMissionOpening(rootId)
  return screen?.ready ? <MissionDeck {...props} screen={screen} /> : null
})

const issue = (partial: Partial<IssueViewModel> = {}): IssueViewModel =>
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
  }) as IssueViewModel

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
  needsHuman: true,
  title: 'Asking subtask',
})

const handlers = () => ({
  onOpenSession: vi.fn(),
  onOpenTask: vi.fn(),
  onOpenTaskMenu: vi.fn(),
  onScreenProposals: vi.fn(),
})

const agent = (id: string, issueId: string, title: string, phase = 'idle') =>
  ({
    sessionId: asSessionId(id),
    issueId: asIssueId(issueId),
    agentKind: 'claude-code',
    title,
    name: title,
    cwd: '/src/podium',
    status: 'live',
    createdAt: '2026-08-04T20:15:44.230Z',
    lastActiveAt: '2026-08-04T20:15:44.230Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    agentState: { phase, since: '2026-08-04T20:15:44.230Z' },
  }) as unknown as SessionView

async function mount(
  issues: IssueViewModel[] = [root, quiet, asking],
  sessions: SessionView[] = [],
  currentSessionId?: string,
) {
  const props = handlers()
  const view = await renderWithMobileStore(
    <Opened rootId={root.id} currentSessionId={currentSessionId} {...props} />,
    { issues, sessions },
  )
  return { ...view, props }
}

describe('MissionDeck sheet', () => {
  it('draws the mission title and every task with its state word', async () => {
    await mount()
    expect(screen.getByRole('heading').textContent).toBe('The mission')
    const tasks = screen.getAllByTestId('deck-task').map((row) => row.getAttribute('aria-label'))
    expect(tasks.some((label) => label?.includes('Quiet subtask'))).toBe(true)
    expect(tasks.some((label) => label?.includes('Asking subtask'))).toBe(true)
  })

  it('narrows to Needs you, and All brings everything back', async () => {
    await mount()
    await act(async () => fireEvent.click(screen.getByTestId('deck-filter-needs-you')))
    expect(screen.getByText('Asking subtask')).toBeTruthy()
    expect(screen.queryByText('Quiet subtask')).toBeNull()
    await act(async () => fireEvent.click(screen.getByTestId('deck-filter-all')))
    expect(screen.getByText('Quiet subtask')).toBeTruthy()
  })

  it('counts each filter from the Full deck', async () => {
    await mount()
    expect(screen.getByTestId('deck-filter-all').getAttribute('aria-label')).toBe('All, 2')
    expect(screen.getByTestId('deck-filter-needs-you').getAttribute('aria-label')).toBe(
      'Needs you, 1',
    )
  })

  it('opens a task on tap and its menu on long press', async () => {
    const { props } = await mount()
    const row = screen
      .getAllByTestId('deck-task')
      .find((el) => el.getAttribute('aria-label')?.includes('Quiet subtask'))
    if (!row) throw new Error('quiet row')
    fireEvent.click(row)
    expect(props.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'quiet' }))
  })

  it('heads a phase with its done counter', async () => {
    const phase = issue({
      id: asIssueId('phase'),
      parentId: root.id,
      seq: 4,
      title: 'Pricing',
      type: 'phase',
    } as Partial<IssueViewModel>)
    const done = issue({
      id: asIssueId('p-done'),
      parentId: asIssueId('phase'),
      seq: 5,
      stage: 'done',
      title: 'Market evidence',
    })
    const todo = issue({
      id: asIssueId('p-todo'),
      parentId: asIssueId('phase'),
      seq: 6,
      title: 'Packaging tiers',
    })
    await mount([root, phase, done, todo])
    const heading = screen.getByTestId('deck-phase')
    expect(heading.textContent).toContain('Pricing')
    expect(heading.textContent).toContain('1/2')
  })

  it('names the root lead Coordinator and marks the open seat', async () => {
    const lead = agent('s-lead', 'root', 'Mission lead', 'working')
    const withLead = { ...root, coordinatorSessionId: asSessionId('s-lead') } as IssueViewModel
    const { props } = await mount([withLead, quiet], [lead], 's-lead')
    const seat = screen.getByTestId('deck-seat')
    expect(seat.getAttribute('aria-label')).toBe('Coordinator, Working, open')
    fireEvent.click(seat)
    expect(props.onOpenSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's-lead' }),
    )
  })

  it('lists proposals under a counted, foldable row with a Screen action', async () => {
    const proposal = issue({
      id: asIssueId('proposal'),
      parentId: root.id,
      seq: 7,
      stage: 'proposed',
      title: 'Agent proposal',
    })
    const { props } = await mount([root, quiet, proposal])
    expect(screen.getByText('Agent proposal')).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByLabelText('Proposals, 1')))
    expect(screen.queryByText('Agent proposal')).toBeNull()
    fireEvent.click(screen.getByLabelText('Screen proposals'))
    expect(props.onScreenProposals).toHaveBeenCalledOnce()
  })

  it('says so when a mission has nothing on it yet', async () => {
    const solo = issue({ id: asIssueId('root'), seq: 9, title: 'Run now' })
    await mount([solo])
    expect(screen.getByText('No tasks or agents on this mission yet.')).toBeTruthy()
  })
})

it('keeps a sibling outside a nested phase in its own card', async () => {
  const parent = { ...quiet, needsHuman: true }
  const phase = issue({
    id: asIssueId('nested-phase'),
    parentId: quiet.id,
    type: 'phase',
    title: 'Nested phase',
    seq: 4,
  })
  const child = issue({
    id: asIssueId('nested-child'),
    parentId: phase.id,
    title: 'Inside phase',
    seq: 5,
  })
  await mount([root, parent, phase, child, asking])
  const phaseGroup = screen.getByTestId('deck-group-nested-phase')
  expect(phaseGroup.textContent).toContain('Inside phase')
  expect(phaseGroup.textContent).not.toContain('Asking subtask')
  expect(
    screen
      .getAllByTestId('deck-group-loose')
      .some((group) => group.textContent?.includes('Asking subtask')),
  ).toBe(true)
})

it('expands and folds a working leaf seat without opening its task', async () => {
  const { props } = await mount(
    [root, quiet],
    [agent('worker', quiet.id, 'Leaf worker', 'working')],
  )
  expect(screen.queryByTestId('deck-agent')).toBeNull()
  await act(async () => fireEvent.click(screen.getByLabelText('Expand Quiet subtask')))
  const seat = screen.getByTestId('deck-agent')
  expect(seat.textContent).toContain('Leaf worker')
  expect(props.onOpenTask).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(screen.getByLabelText('Collapse Quiet subtask')))
  expect(screen.queryByTestId('deck-agent')).toBeNull()
})
