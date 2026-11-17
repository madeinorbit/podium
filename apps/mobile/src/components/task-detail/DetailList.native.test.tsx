import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { MobxPool } from '@podium/client-graph/pool'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({ pool: null as MobxPool | null, scale: 1 }))
vi.mock('../../client/mobile-pool', () => ({ useMobilePool: () => host.pool }))
vi.mock('../../client/issue-opening', () => ({ useIssueOpening: () => null }))
vi.mock('react-native', async (original) => ({
  ...(await original<object>()),
  useWindowDimensions: () => ({ width: 320, height: 568, scale: 2, fontScale: host.scale }),
}))
vi.mock('../list-row-press.ios', () => ({ listRowPress: (rowPress: () => void) => ({ rowPress }) }))
vi.mock('../working-word-glint.ios', () => ({ workingWordGlint: (glint: string) => ({ glint }) }))
vi.mock('../StageGlyph', () => ({ StageGlyph: () => <span data-testid="stage-glyph" /> }))
vi.mock('./DetailList', () => import('./DetailList.ios'))
vi.mock('@expo/ui', () => ({
  Host: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@expo/ui/swift-ui/modifiers', () => {
  const names = [
    'accessibilityElement',
    'accessibilityIdentifier',
    'accessibilityLabel',
    'background',
    'buttonStyle',
    'disabled',
    'fixedSize',
    'font',
    'foregroundStyle',
    'frame',
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
  }
  const modifier = (props: Props, name: string) =>
    props.modifiers?.find((entry) => name in entry)?.[name]
  const Stack = (props: Props) => {
    const onClick = modifier(props, 'rowPress') as (() => void) | undefined
    return onClick ? (
      <button
        type="button"
        onClick={onClick}
        aria-label={modifier(props, 'accessibilityLabel') as string}
        data-testid={modifier(props, 'accessibilityIdentifier') as string}
      >
        {props.children}
      </button>
    ) : (
      <div>{props.children}</div>
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
    HStack: Stack,
    VStack: Stack,
    Button: (props: Props) => (
      <button type="button" onClick={props.onPress}>
        {props.children}
      </button>
    ),
    Text: (props: Props) => (
      <span data-glint={modifier(props, 'glint') as string}>{props.children}</span>
    ),
    Image: ({ systemName }: { systemName: string }) => <span data-symbol={systemName} />,
    RNHostView: ({ children }: Props) => <div data-testid="hosted-react">{children}</div>,
  }
})

import { DetailContent, DetailList } from './DetailList.ios'
import { IssueStartAction } from './IssueStartAction'
import { IssueSubIssuesSection } from './IssueSubIssues.ios'
import { TaskSessions } from './TaskSessions.ios'

afterEach(() => {
  cleanup()
  host.pool?.dispose()
  host.pool = null
  host.scale = 1
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
  } as IssueViewModel
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

it('uses a native inset-grouped list and opens all three live seats with the deck working word', () => {
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
  expect(screen.getByText('Needs you')).toBeTruthy()
  expect(screen.getByText('Codex · Coordinator')).toBeTruthy()
  for (const row of screen.getAllByTestId('issue-active-session')) fireEvent.click(row)
  expect(open.mock.calls.map(([id]) => id)).toEqual(['seat-0', 'seat-1', 'seat-2'])
  // Only the heading is hosted React. Session text stays in SwiftUI rows.
  expect(screen.getAllByTestId('hosted-react')).toHaveLength(1)
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
  render(
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
