import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { asIssueId, asSessionId } from '@podium/model'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { ViewProps } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMissionOpening } from '../client/hooks'
import { renderWithMobileStore } from '../client/test-support'

afterEach(cleanup)

const dimensions = vi.hoisted(() => ({ fontScale: 1 }))
const nativeShrink = vi.hoisted(() => new Map<string, number | undefined>())
vi.mock('react-native', async (original) => {
  const actual = await original<typeof import('react-native')>()
  return {
    ...actual,
    useWindowDimensions: () => ({ width: 402, height: 874, scale: 1, ...dimensions }),
    View: (props: ViewProps) => {
      if (props.testID === 'deck-vitals-text') {
        nativeShrink.set(props.testID, actual.StyleSheet.flatten(props.style)?.flexShrink)
      }
      return <actual.View {...props} />
    },
  }
})
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

  it('selects exactly one filter and exposes the separate Done toggle state', async () => {
    await mount()
    const selected = () =>
      screen.getAllByRole('tab').filter((tab) => tab.getAttribute('aria-selected') === 'true')
    expect(selected().map((tab) => tab.dataset.testid)).toEqual(['deck-filter-all'])
    const done = screen.getByTestId('deck-filter-done')
    expect(done.getAttribute('role')).toBe('switch')
    expect(done.getAttribute('aria-label')).toBe('Done tasks, 0')
    // Shown by default (desktop): the label names what a tap does.
    expect(done.getAttribute('aria-checked')).toBe('true')
    expect(done.textContent).toBe('Hide Done')
    await act(async () => fireEvent.click(done))
    expect(done.getAttribute('aria-label')).toBe('Done tasks, 0')
    expect(done.getAttribute('aria-checked')).toBe('false')
    expect(done.textContent).toBe('Show Done')
    // The selected segment's thumb is drawn inside its 44pt hit area.
    const thumb = screen.getByTestId('deck-filter-all').firstElementChild
    if (!(thumb instanceof HTMLElement)) throw new Error('Missing segment thumb')
    expect(getComputedStyle(thumb).backgroundColor).not.toBe('rgba(0, 0, 0, 0.00)')
    expect(getComputedStyle(done).backgroundColor).not.toBe(getComputedStyle(thumb).backgroundColor)
    await act(async () => fireEvent.click(screen.getByTestId('deck-filter-active')))
    expect(selected().map((tab) => tab.dataset.testid)).toEqual(['deck-filter-active'])
  })

  it('stacks the filters as full-size choice rows at accessibility text sizes', async () => {
    dimensions.fontScale = 1.8
    try {
      await mount()
      const tabs = screen.getAllByRole('tab')
      expect(tabs.map((tab) => tab.dataset.testid)).toEqual([
        'deck-filter-all',
        'deck-filter-needs-you',
        'deck-filter-active',
        'deck-filter-up-next',
      ])
      await act(async () => fireEvent.click(screen.getByTestId('deck-filter-active')))
      expect(
        screen
          .getAllByRole('tab')
          .filter((tab) => tab.getAttribute('aria-selected') === 'true')
          .map((tab) => tab.dataset.testid),
      ).toEqual(['deck-filter-active'])
    } finally {
      dimensions.fontScale = 1
    }
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

  it('hides completed rows and phases both ways while preserving mission counters and gauge', async () => {
    const phase = issue({
      id: asIssueId('build'),
      parentId: root.id,
      seq: 4,
      type: 'phase',
      title: 'Build',
    })
    const release = issue({
      id: asIssueId('release'),
      parentId: root.id,
      seq: 5,
      type: 'phase',
      title: 'Release',
    })
    const done = issue({
      id: asIssueId('done'),
      parentId: phase.id,
      seq: 6,
      stage: 'done',
      title: 'Market evidence',
    })
    const todo = { ...quiet, parentId: phase.id }
    const released = issue({
      id: asIssueId('released'),
      parentId: release.id,
      seq: 7,
      stage: 'done',
      title: 'Release notes',
    })
    await mount([root, phase, release, done, todo, released])
    const taskLabels = () =>
      screen.getAllByTestId('deck-task').map((row) => row.getAttribute('aria-label'))
    const shown = taskLabels()
    const gauge = screen.getByTestId('deck-gauge').innerHTML
    const buildCounter = () =>
      screen.getAllByTestId('deck-phase').find((row) => row.textContent?.includes('Build'))
        ?.textContent
    expect(buildCounter()).toContain('1/2')
    expect(screen.queryByTestId('deck-done-hidden')).toBeNull()

    await act(async () => fireEvent.click(screen.getByTestId('deck-filter-done')))
    expect(screen.queryByText('Market evidence')).toBeNull()
    expect(screen.queryByText('Release notes')).toBeNull()
    expect(screen.queryByText('Release')).toBeNull()
    expect(screen.getByText('Quiet subtask')).toBeTruthy()
    expect(buildCounter()).toContain('1/2')
    expect(screen.getByTestId('deck-filter-all').getAttribute('aria-label')).toBe('All, 3')
    expect(screen.getByTestId('deck-gauge').innerHTML).toBe(gauge)
    expect(screen.getByText('2 done hidden')).toBeTruthy()

    await act(async () => fireEvent.click(screen.getByTestId('deck-done-hidden')))
    expect(taskLabels()).toEqual(shown)
    expect(screen.queryByTestId('deck-done-hidden')).toBeNull()
    await act(async () => fireEvent.click(screen.getByTestId('deck-filter-done')))
    await act(async () => fireEvent.click(screen.getByTestId('deck-filter-done')))
    expect(taskLabels()).toEqual(shown)
    expect(screen.getByTestId('deck-gauge').innerHTML).toBe(gauge)
  })

  it('counts hidden done leaves in folded parents and reveals them from another filter', async () => {
    const parent = { ...quiet, title: 'Delivery' }
    const done = issue({
      id: asIssueId('nested-done'),
      parentId: parent.id,
      seq: 4,
      stage: 'done',
      title: 'Nested done',
    })
    const todo = issue({
      id: asIssueId('nested-todo'),
      parentId: parent.id,
      seq: 5,
      title: 'Nested todo',
    })
    await mount([root, parent, asking, done, todo])
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Collapse Delivery' })),
    )
    await act(async () => fireEvent.click(screen.getByTestId('deck-filter-needs-you')))
    expect(screen.getByText('1 done hidden')).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByTestId('deck-done-hidden')))
    expect(screen.getByTestId('deck-filter-all').getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByTestId('deck-done-hidden')).toBeNull()
    // Showing done preserves the person's existing fold preference.
    expect(screen.queryByText('Nested done')).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Expand Delivery' })))
    expect(screen.getByText('Nested done')).toBeTruthy()
  })

  it('omits the hidden footer when there is no completed work', async () => {
    await mount()
    await act(async () => fireEvent.click(screen.getByTestId('deck-filter-done')))
    expect(screen.queryByTestId('deck-done-hidden')).toBeNull()
  })

  it('names the root lead Coordinator and marks the open seat', async () => {
    const lead = {
      ...agent('s-lead', 'root', 'Mission lead', 'working'),
      observedModel: 'claude-opus-5-5',
    } as SessionView
    const withLead = { ...root, coordinatorSessionId: asSessionId('s-lead') } as IssueViewModel
    const { props } = await mount([withLead, quiet], [lead], 's-lead')
    const seat = screen.getByTestId('deck-seat')
    expect(seat.getAttribute('aria-label')).toBe('Coordinator, Working, open')
    // A full-bleed tint the card clips; no inner border or radius of its own.
    expect(getComputedStyle(seat).backgroundColor).toBe('rgba(111, 157, 255, 0.13)')
    expect(['', '0px']).toContain(getComputedStyle(seat).borderWidth)
    expect(['', '0px']).toContain(getComputedStyle(seat).borderRadius)
    expect(seat.textContent).toContain('Working · Opus 5.5')
    expect(seat.textContent).not.toContain('claude-opus')
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
        index === 56
          ? 'Tasks rows and video polish'
          : index % 3 === 0
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
  sessions.push({
    ...agent('completed-helper', 'long-56', 'Tasks and video polish'),
    status: 'hibernated',
  })
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

it.each([
  ['working', true],
  ['idle', false],
  ['errored', false],
])('marks task and seat rows from the shared %s word', async (phase, working) => {
  await mount(
    [root, quiet],
    [
      agent('root-seat', root.id, 'Root seat', phase),
      agent('task-seat', quiet.id, 'Task seat', phase),
    ],
  )
  const task = screen.getByTestId('deck-task')
  const seat = screen.getByTestId('deck-seat')
  expect(Boolean(within(task).queryByTestId('working-word'))).toBe(working)
  expect(Boolean(within(seat).queryByTestId('working-word'))).toBe(working)
  const expand = screen.queryByLabelText('Expand Quiet subtask')
  if (expand) await act(async () => fireEvent.click(expand))
  expect(Boolean(within(screen.getByTestId('deck-agent')).queryByTestId('working-word'))).toBe(
    working,
  )
})

it('keeps attention on a task while its working seat still gets the indicator', async () => {
  await mount(
    [root, { ...quiet, needsHuman: true }],
    [agent('worker', quiet.id, 'Worker', 'working')],
  )
  const task = screen.getByTestId('deck-task')
  expect(task.getAttribute('aria-label')).toContain('Needs you')
  expect(within(task).queryByTestId('working-word')).toBeNull()
  const expand = screen.queryByLabelText('Expand Quiet subtask')
  if (expand) await act(async () => fireEvent.click(expand))
  expect(within(screen.getByTestId('deck-agent')).getByTestId('working-word')).toBeTruthy()
})

it('uses the task word for shipping, even without a computing seat', async () => {
  await mount([root, { ...quiet, stage: 'shipping' }])
  expect(within(screen.getByTestId('deck-task')).getByTestId('working-word')).toBeTruthy()
})

it.each([
  1, 2.35,
])('keeps the done count and priority words beside the done toggle at scale %s', async (scale) => {
  dimensions.fontScale = scale
  const ready = issue({
    id: asIssueId('ready'),
    parentId: root.id,
    seq: 4,
    stage: 'backlog',
    title: 'Ready later',
  })
  try {
    await mount([root, quiet, asking, ready], [agent('worker', quiet.id, 'Worker', 'working')])
    const column = screen.getByTestId('deck-vitals-text')
    const word = within(column).getByTestId('working-word')
    const text = word.firstElementChild
    if (!(text instanceof HTMLElement)) throw new Error('Missing vitals text')
    expect(nativeShrink.get('deck-vitals-text')).toBe(1)
    expect(getComputedStyle(word).flexShrink).toBe('1')
    expect(getComputedStyle(text).whiteSpace).toBe(scale === 1 ? 'nowrap' : 'pre-wrap')
    expect(getComputedStyle(screen.getByTestId('deck-filter-done')).flexShrink).toBe('0')
    expect(column.textContent).toContain('1 needs you')
    expect(column.textContent).toContain('1 working')
    expect(column.textContent?.includes('up next')).toBe(scale > 1)
    expect(column.textContent).toMatch(/\d+\/\d+/)
  } finally {
    dimensions.fontScale = 1
  }
})
