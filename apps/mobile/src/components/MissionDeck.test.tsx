import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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

describe('MissionDeck', () => {
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
    expect(getComputedStyle(seat).backgroundColor).toBe('rgba(111, 157, 255, 0.13)')
    expect(getComputedStyle(seat).borderWidth).toBe('1px')
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

it.each([
  true,
  false,
])('shows phase lead and helpers under the fold, with children=%s', async (children) => {
  const phase = issue({
    id: asIssueId('phase'),
    parentId: root.id,
    type: 'phase',
    title: 'Phase crew',
    coordinatorSessionId: asSessionId('phase-lead'),
  })
  const child = issue({ id: asIssueId('child'), parentId: phase.id, title: 'Phase task' })
  const { props } = await mount(
    [root, phase, ...(children ? [child] : [])],
    [
      agent('phase-lead', phase.id, 'Phase lead', 'working'),
      agent('phase-helper', phase.id, 'Phase helper', 'idle'),
      { ...agent('archived', phase.id, 'Archived helper'), archived: true },
    ],
    'phase-helper',
  )
  // Phases are open by default. The shared seat rule omits archived sessions.
  const seats = screen.getAllByTestId('deck-agent')
  expect(seats).toHaveLength(2)
  if (!seats[0] || !seats[1]) throw new Error('Missing phase seats')
  fireEvent.click(seats[0])
  expect(props.onOpenSession).toHaveBeenLastCalledWith(
    expect.objectContaining({ sessionId: 'phase-lead' }),
  )
  fireEvent.click(seats[1])
  expect(props.onOpenSession).toHaveBeenLastCalledWith(
    expect.objectContaining({ sessionId: 'phase-helper' }),
  )
  expect(seats[1].getAttribute('aria-label')).toContain(', open')
  await act(async () => fireEvent.click(screen.getByTestId('deck-phase')))
  expect(screen.queryByTestId('deck-agent')).toBeNull()
  expect(screen.queryByText('Phase task')).toBeNull()
  await act(async () => fireEvent.click(screen.getByTestId('deck-phase')))
  expect(screen.getAllByTestId('deck-agent')).toHaveLength(2)
})

it('uses the desktop session label for an unnamed worktree boot title', async () => {
  await mount(
    [root],
    [
      {
        ...agent('boot', root.id, 'issue-165-ade-comparison-platform'),
        name: undefined,
        cwd: '/repo/issue-165-ade-comparison-platform',
      },
    ],
  )
  expect(screen.getByText('New session')).toBeTruthy()
  expect(screen.queryByText('issue-165-ade-comparison-platform')).toBeNull()
})

it('draws each phase crew once when an outer phase resumes after a nested phase', async () => {
  const outer = issue({ id: asIssueId('outer'), parentId: root.id, type: 'phase', title: 'Outer' })
  const nested = issue({
    id: asIssueId('nested'),
    parentId: outer.id,
    type: 'phase',
    title: 'Nested',
    seq: 2,
    sortKey: 'a',
  })
  const after = issue({
    id: asIssueId('after'),
    parentId: outer.id,
    title: 'After nested',
    seq: 3,
    sortKey: 'b',
  })
  await mount(
    [root, outer, nested, after],
    [
      agent('outer-helper', outer.id, 'Outer helper'),
      agent('nested-helper', nested.id, 'Nested helper'),
    ],
  )
  expect(screen.getAllByText('Outer helper')).toHaveLength(1)
  expect(screen.getAllByText('Nested helper')).toHaveLength(1)
  expect(screen.getByText('After nested')).toBeTruthy()
})

it('keeps dozens of wrapped proposals readable after filtering a long mission', async () => {
  const phase = issue({
    id: asIssueId('phase-long'),
    parentId: root.id,
    type: 'phase',
    title: 'Delivery',
    seq: 2,
  })
  const tasks = Array.from({ length: 60 }, (_, index) =>
    issue({
      id: asIssueId(`long-${index}`),
      parentId: phase.id,
      seq: index + 3,
      title:
        index % 3 === 0
          ? `Task ${index}: preserve conversation selection through background catch-up`
          : `Delivery task ${index}`,
      stage:
        index % 4 === 0
          ? 'done'
          : index % 4 === 1
            ? 'backlog'
            : index % 4 === 2
              ? 'review'
              : 'in_progress',
    }),
  )
  const proposals = Array.from({ length: 48 }, (_, index) =>
    issue({
      id: asIssueId(`proposed-${index}`),
      parentId: root.id,
      seq: index + 100,
      title: `Proposal ${index}: preserve task titles and metadata when a proposal wraps over multiple lines`,
      stage: 'proposed',
    }),
  )
  const sessions = tasks
    .filter((_, index) => index % 4 === 3)
    .map((task, index) => agent(`worker-${index}`, task.id, `Agent ${index}`, 'working'))
  await mount([root, phase, ...tasks, ...proposals], sessions)
  expect(screen.getAllByTestId('deck-task')).toHaveLength(60)
  expect(screen.getAllByTestId('deck-proposal')).toHaveLength(48)
  await act(async () => fireEvent.click(screen.getByTestId('deck-filter-up-next')))
  await act(async () => fireEvent.click(screen.getByTestId('deck-filter-all')))
  expect(screen.getAllByTestId('deck-task')).toHaveLength(60)
  expect(screen.getAllByTestId('deck-proposal')).toHaveLength(48)
  const capture = process.env.PODIUM_MOBILE_DECK_CAPTURE
  if (capture) {
    const css = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules, (rule) => rule.cssText))
      .join('\n')
    const fonts = [
      ['Geist_400Regular', 'geist/400Regular/Geist_400Regular.ttf'],
      ['Geist_500Medium', 'geist/500Medium/Geist_500Medium.ttf'],
      ['Geist_600SemiBold', 'geist/600SemiBold/Geist_600SemiBold.ttf'],
      ['GeistMono_400Regular', 'geist-mono/400Regular/GeistMono_400Regular.ttf'],
    ]
      .map(
        ([name, path]) =>
          `@font-face{font-family:${name};src:url(data:font/ttf;base64,${readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/@expo-google-fonts', path ?? '')).toString('base64')})}`,
      )
      .join('\n')
    writeFileSync(
      capture.replace(/\.html$/, '-long.html'),
      `<!doctype html><html><head><meta charset="utf-8"><title>Flight deck layout, 60 tasks and 48 proposals</title><style>${fonts}\n${css}\nhtml,body{width:402px;height:874px;margin:0;background:#16171a}body{display:flex}body>div{display:flex;flex:1;min-width:0}</style></head><body>${document.body.innerHTML}</body></html>`,
    )
  }
})
