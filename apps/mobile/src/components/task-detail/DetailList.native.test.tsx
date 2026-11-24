import { modelName } from '@podium/client-core/agent-models'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { MobxPool } from '@podium/client-graph/pool'
import { TaskCostModel } from '@podium/client-graph/task-cost-model'
import type { TaskCostComparisonWire } from '@podium/model'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({
  pool: null as MobxPool | null,
  scale: 1,
  listeners: new Set<() => void>(),
}))
vi.mock('../../client/mobile-pool', () => ({ useMobilePool: () => host.pool }))
vi.mock('../../client/issue-opening', () => ({ useIssueOpening: () => null }))
vi.mock('react-native', async (original) => {
  const { useSyncExternalStore } = await import('react')
  return {
    ...(await original<object>()),
    useWindowDimensions: () => {
      const fontScale = useSyncExternalStore(
        (listener) => {
          host.listeners.add(listener)
          return () => host.listeners.delete(listener)
        },
        () => host.scale,
      )
      return { width: 320, height: 568, scale: 2, fontScale }
    },
  }
})
vi.mock('../list-row-press.ios', () => ({
  listRowPress: (rowPress: () => void) => ({ rowPress }),
  contentVisibility: (onChange: (visible: boolean) => void) => ({ onChange }),
}))
vi.mock('../working-word-glint.ios', () => ({ workingWordGlint: (glint: string) => ({ glint }) }))
vi.mock('../StageGlyph', () => ({ StageGlyph: () => <span data-testid="stage-glyph" /> }))
vi.mock('./DetailList', () => import('./DetailList.ios'))
vi.mock('@expo/ui', () => ({
  Host: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@expo/ui/swift-ui/modifiers', () => {
  const names = [
    'accessibilityElement',
    'accessibilityHidden',
    'accessibilityIdentifier',
    'accessibilityLabel',
    'accessibilityValue',
    'alignmentGuide',
    'background',
    'buttonStyle',
    'disabled',
    'fixedSize',
    'font',
    'foregroundStyle',
    'frame',
    'layoutPriority',
    'lineLimit',
    'listRowBackground',
    'listRowInsets',
    'listSectionSpacing',
    'listStyle',
    'monospacedDigit',
    'opacity',
    'padding',
    'scrollContentBackground',
    'scrollDismissesKeyboard',
    'tint',
  ]
  return Object.fromEntries(names.map((name) => [name, (value: unknown) => ({ [name]: value })]))
})
vi.mock('@expo/ui/swift-ui', () => {
  type Props = {
    children?: ReactNode
    modifiers?: Array<Record<string, unknown>>
    onPress?: () => void
    alignment?: string
    spacing?: number
  }
  const modifier = (props: Props, name: string) =>
    props.modifiers?.find((entry) => name in entry)?.[name]
  const stack = (kind: string) => (props: Props) => {
    const onClick = modifier(props, 'rowPress') as (() => void) | undefined
    const traits = {
      'data-stack': kind,
      'data-alignment': props.alignment,
      'data-spacing': props.spacing,
      'data-modifiers': JSON.stringify(props.modifiers),
      'data-testid': modifier(props, 'accessibilityIdentifier') as string,
    }
    return onClick ? (
      <button
        {...traits}
        type="button"
        onClick={onClick}
        aria-label={modifier(props, 'accessibilityLabel') as string}
      >
        {props.children}
      </button>
    ) : (
      <div {...traits}>{props.children}</div>
    )
  }
  return {
    List: (props: Props) => (
      <div data-testid="native-list" data-list-style={modifier(props, 'listStyle') as string}>
        {props.children}
      </div>
    ),
    Section: ({ children, header, title }: Props & { header?: ReactNode; title?: string }) => (
      <section>
        {header}
        <h2>{title}</h2>
        {children}
      </section>
    ),
    HStack: stack('horizontal'),
    VStack: stack('vertical'),
    Button: (props: Props) => (
      <button
        type="button"
        onClick={props.onPress}
        aria-label={modifier(props, 'accessibilityLabel') as string}
      >
        {props.children}
      </button>
    ),
    Text: (props: Props) => (
      <span
        data-glint={modifier(props, 'glint') as string}
        data-ink={JSON.stringify(modifier(props, 'foregroundStyle'))}
      >
        {props.children}
      </span>
    ),
    Rectangle: () => <span />,
    Image: ({ systemName }: { systemName: string }) => <span data-symbol={systemName} />,
    RNHostView: ({ children }: Props) => <div data-testid="hosted-react">{children}</div>,
  }
})

import { deckWordColor } from '../deck-colors'
import { CostReading } from './CostReading.ios'
import { DetailContent, DetailList } from './DetailList.ios'
import { IssueStartAction } from './IssueStartAction'
import { IssueSubIssuesSection } from './IssueSubIssues.ios'
import { TaskSessions } from './TaskSessions.ios'

let cost: TaskCostModel | undefined

afterEach(() => {
  cleanup()
  host.pool?.dispose()
  host.pool = null
  host.scale = 1
  host.listeners.clear()
  cost?.close()
  cost = undefined
})
const stamp = '2026-11-17T12:00:00Z'
function issue(id = 'task', extra = {}) {
  return {
    id,
    title: 'Issue detail',
    seq: 1,
    prefix: 'POD',
    repoPath: '/fixture',
    stage: 'backlog',
    type: 'task',
    deps: [],
    createdAt: stamp,
    updatedAt: stamp,
    ...extra,
  } as unknown as IssueViewModel
}
function attach(record: IssueViewModel, sessions: SessionView[] = []) {
  host.pool = new MobxPool({ selectedIssueId: record.id, coarseNow: Date.parse(stamp) })
  host.pool.apply({
    type: 'replace',
    rows: [
      { kind: 'issue', id: record.id, value: record },
      ...sessions.map((session) => ({
        kind: 'session' as const,
        id: session.sessionId,
        value: session,
      })),
    ],
  })
}

it.each([
  1, 3.12,
])('uses two native session lines and opens all live seats with the deck working word at %sx', (scale) => {
  host.scale = scale
  const record = issue('task', { stage: 'in_progress', coordinatorSessionId: 'seat-0' })
  const sessions = Array.from({ length: 3 }, (_, index) => ({
    sessionId: `seat-${index}`,
    issueId: record.id,
    title: `Session ${index + 1}`,
    agentKind: 'codex',
    status: 'live',
    createdAt: stamp,
    lastActiveAt: stamp,
    agentState: { phase: index === 0 ? 'working' : 'idle', since: stamp },
    ...(index === 0 ? { requestedModel: 'gpt-6.1-sol' } : {}),
    ...(index === 1
      ? {
          offer: {
            createdAt: stamp,
            message: 'Ready',
            actions: [{ label: 'Review', prompt: 'Review' }],
          },
        }
      : {}),
  })) as SessionView[]
  attach(record, sessions)
  const open = vi.fn()
  render(
    <DetailList>
      <DetailContent>
        <span>Task title</span>
      </DetailContent>
      <TaskSessions issue={record} sessions={sessions} onOpenSession={open} />
    </DetailList>,
  )
  expect(screen.getByTestId('native-list').dataset.listStyle).toBe('insetGrouped')
  expect(screen.getAllByTestId('issue-active-session')).toHaveLength(3)
  expect(screen.getByText('Working').dataset.glint).toBe('seat-0')
  expect(screen.getByText('Working').dataset.ink).toBe(JSON.stringify(deckWordColor('working')))
  expect(screen.getByText('Needs you').dataset.ink).toBe(JSON.stringify(deckWordColor('needs-you')))
  const rows = screen.getAllByTestId('issue-active-session')
  const body = rows[0].querySelector('[data-stack="vertical"]') as HTMLElement
  expect(Array.from(body.children, (line) => line.textContent)).toEqual([
    'Session 1',
    `Working · ${modelName('codex', 'gpt-6.1-sol')} · Coordinator`,
  ])
  expect(rows[1].textContent).toBe('Session 2Needs you · Agent')
  expect(rows[1].textContent).not.toMatch(/Auto|Codex/)
  expect(rows[0].getAttribute('aria-label')).toContain('Codex · Coordinator')
  expect(rows[0].dataset.alignment).toBe('center')
  for (const row of screen.getAllByTestId('issue-active-session')) fireEvent.click(row)
  expect(open.mock.calls.map(([id]) => id)).toEqual(['seat-0', 'seat-1', 'seat-2'])
  // Only the heading is hosted React. Session text stays in SwiftUI rows.
  expect(screen.getAllByTestId('hosted-react')).toHaveLength(1)

  act(() =>
    host.pool?.apply({
      type: 'update',
      rows: [
        {
          kind: 'session',
          id: 'seat-0',
          value: {
            ...sessions[0],
            agentState: { phase: 'idle', since: stamp },
            offer: {
              createdAt: stamp,
              message: 'Ready',
              actions: [{ label: 'Review', prompt: 'Review' }],
            },
          },
        },
      ],
    }),
  )
  expect(within(rows[0]).queryByText('Working')).toBeNull()
  const updated = within(rows[0]).getByText('Needs you')
  expect(updated.dataset.ink).toBe(JSON.stringify(deckWordColor('needs-you')))
  expect(updated.dataset.glint).toBeUndefined()
})

it('makes the whole two-line cost reading tappable with a 4pt subtitle gap through AX5', async () => {
  const answer: TaskCostComparisonWire = {
    task: {
      issueId: 'task' as never,
      state: 'costed',
      own: { models: [], messages: 0, sessionCount: 1 },
      rollup: {
        models: [
          {
            model: 'claude-opus-5',
            inputTokens: 2_000_000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            cacheCreation1hTokens: 0,
            messages: 25,
          },
        ],
        messages: 25,
        sessionCount: 1,
      },
      descendantCount: 0,
      provisional: true,
      floor: 'partial',
      harnesses: ['codex'],
      uncostedSessionCount: 1,
      sessions: [],
    },
    cohort: { taskCount: 0, medianUsdPerReply: null },
  }
  const readingCost = new TaskCostModel(async () => answer, 'task', false)
  cost = readingCost
  cost.open()
  cost.setVisible(true)
  const contents = () => (
    <DetailList>
      <CostReading model={readingCost} />
    </DetailList>
  )
  const view = render(contents())
  await waitFor(() => expect(screen.getByText('≈$10')).toBeTruthy())
  const reading = screen.getByTestId('issue-cost')
  const button = screen.getByRole('button', {
    name: /Estimated cost so far, ≈\$10.*Show cost details/,
  })
  const subtitle = screen.getByText('Estimate at list price · partial')
  expect(reading.parentElement).toBe(button)
  expect(button.contains(screen.getByText('Estimated cost so far'))).toBe(true)
  expect(reading.dataset.spacing).toBe('4')
  expect(subtitle.parentElement).toBe(reading)
  expect(reading.querySelector('button')).toBeNull()
  fireEvent.click(button)
  expect(screen.getByText('≥ floor · all Codex · 1 session unread')).toBeTruthy()
  for (const scale of [3.12, 1]) {
    act(() => {
      host.scale = scale
      for (const listener of host.listeners) listener()
    })
    view.rerender(contents())
    expect(reading.dataset.spacing).toBe('4')
    const titleLine = screen.getByText('Estimated cost so far').parentElement as HTMLElement
    expect(titleLine.dataset.stack).toBe(scale > 1.35 ? 'vertical' : 'horizontal')
    expect(titleLine.dataset.alignment).toBe(scale > 1.35 ? 'leading' : 'firstTextBaseline')
    expect(screen.getByText(/at list price for the same tokens/)).toBeTruthy()
  }
})

it('keeps AX5 titles intrinsic and folds long sub-task lists without changing their order', () => {
  host.scale = 3.12
  const record = issue()
  const children = Array.from({ length: 7 }, (_, index) =>
    issue(`child-${index}`, {
      title: `Sub-task ${index + 1} with a long title that wraps`,
      seq: index + 2,
    }),
  )
  const open = vi.fn()
  const view = render(
    <DetailList>
      <IssueSubIssuesSection
        issue={record}
        subIssues={children}
        busy={false}
        commands={{} as never}
        onOpen={open}
        onStatus={() => {}}
      />
    </DetailList>,
  )
  expect(screen.getAllByTestId('issue-sub-task')).toHaveLength(4)
  fireEvent.click(screen.getByRole('button', { name: 'See all 7 sub-tasks' }))
  expect(screen.getAllByTestId('issue-sub-task')).toHaveLength(7)
  const previousGroup = screen.getByRole('heading', { name: 'Sub-tasks · 7' }).parentElement
  host.scale = 1
  view.rerender(
    <DetailList>
      <IssueSubIssuesSection
        issue={record}
        subIssues={children}
        busy={false}
        commands={{} as never}
        onOpen={open}
        onStatus={() => {}}
      />
    </DetailList>,
  )
  expect(screen.getByRole('heading', { name: 'Sub-tasks · 7' }).parentElement).not.toBe(
    previousGroup,
  )
  expect(screen.getAllByTestId('issue-sub-task')).toHaveLength(7)
  fireEvent.click(screen.getAllByTestId('issue-sub-task')[6])
  expect(open).toHaveBeenCalledExactlyOnceWith('child-6')
})

it('opens the existing Start Agent sheet only while the shared issue model has not begun work', () => {
  const record = issue()
  attach(record)
  const launch = vi.fn()
  render(
    <DetailList>
      <IssueStartAction issue={record} onStart={launch} />
    </DetailList>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Start with agent' }))
  expect(launch).toHaveBeenCalledOnce()
  act(() =>
    host.pool!.apply({
      type: 'update',
      rows: [{ kind: 'issue', id: record.id, value: { ...record, stage: 'in_progress' } }],
    }),
  )
  expect(screen.queryByRole('button', { name: 'Start with agent' })).toBeNull()
})

it('applies row insets outside the native row Button so the List honours them', () => {
  const record = issue('task', { coordinatorSessionId: 'seat-0' })
  const session = {
    sessionId: 'seat-0',
    issueId: record.id,
    title: 'Coordinator',
    agentKind: 'claude',
    status: 'live',
    createdAt: stamp,
    lastActiveAt: stamp,
    agentState: { phase: 'idle', since: stamp },
  } as unknown as SessionView
  attach(record, [session])
  render(
    <DetailList>
      <TaskSessions issue={record} sessions={[session]} onOpenSession={() => {}} />
      <IssueSubIssuesSection
        issue={record}
        subIssues={[issue('child', { seq: 2 })]}
        busy={false}
        commands={{} as never}
        onOpen={() => {}}
        onStatus={() => {}}
      />
    </DetailList>,
  )
  for (const id of ['issue-active-session', 'issue-sub-task']) {
    const names = (
      JSON.parse(screen.getByTestId(id).dataset.modifiers ?? '[]') as Array<Record<string, unknown>>
    ).map((entry) => Object.keys(entry)[0])
    expect(names.indexOf('listRowInsets'), id).toBeGreaterThan(names.indexOf('rowPress'))
    expect(names, id).toContain('alignmentGuide')
  }
})
