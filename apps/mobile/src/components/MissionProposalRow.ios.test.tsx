import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { ROW_WINDOW_SIZE } from '@podium/client-graph/row-window'
import { asIssueId, asSessionId } from '@podium/model'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { observer } from 'mobx-react-lite'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useMissionOpening } from '../client/hooks'
import { renderWithMobileStore } from '../client/test-support'
import { ReducedMotionContext } from '../hooks/useReduceMotion'
import { ROW_PRIME_MS } from '../lib/use-row-prime'

const native = vi.hoisted(() => ({
  fontScale: 1,
  measure: new Map<string, (geometry: { height: number }) => void>(),
}))

vi.mock('react-native', async (original) => ({
  ...(await original<object>()),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: native.fontScale }),
}))

vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  ...Object.fromEntries(
    [
      'accessibilityAddTraits',
      'accessibilityElement',
      'accessibilityHidden',
      'accessibilityValue',
      'monospacedDigit',
      'onLongPressGesture',
      'accessibilityHint',
      'accessibilityIdentifier',
      'accessibilityLabel',
      'alignmentGuide',
      'background',
      'buttonStyle',
      'contentShape',
      'disabled',
      'font',
      'foregroundStyle',
      'frame',
      'lineLimit',
      'layoutPriority',
      'fixedSize',
      'padding',
      'listRowBackground',
      'listRowInsets',
      'listRowSeparator',
      'listRowSeparatorTint',
      'listSectionMargins',
      'listSectionSpacing',
      'listStyle',
      'scrollContentBackground',
      'tint',
      'onAppear',
      'onDisappear',
      'onGeometryChange',
    ].map((name) => [name, (value: unknown) => ({ name, value })]),
  ),
  shapes: { rectangle: () => ({}), roundedRectangle: () => ({}) },
  Animation: { default: 'default' },
  animation: (_preset: unknown, value: unknown) => ({ name: 'animation', value }),
}))

vi.mock('@expo/ui', () => ({
  Host: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('@expo/ui/swift-ui', () => {
  type Props = {
    children?: ReactNode
    header?: ReactNode
    modifiers?: { name: string; value: unknown }[]
  }
  const Box = ({ children }: Props) => <div>{children}</div>
  return {
    List: Box,
    Group: Box,
    Menu: Box,
    Toggle: Box,
    RNHostView: ({ children, matchContents }: Props & { matchContents: unknown }) => (
      <div data-native-rn-host data-sizing={JSON.stringify(matchContents)}>
        {children}
      </div>
    ),
    Section: ({ children, header, modifiers }: Props) => (
      <div
        data-native-section
        data-testid={modifiers?.find((m) => m.name === 'accessibilityIdentifier')?.value as string}
        data-animation-value={modifiers?.find((m) => m.name === 'animation')?.value as number}
      >
        {header ? <div data-testid="native-section-header">{header}</div> : null}
        {children}
      </div>
    ),
    // The List's row Button opens the task. A long-press callback is only
    // present when the row has no native context menu.
    HStack: ({ children, modifiers }: Props) => {
      const find = (name: string) => modifiers?.find((m) => m.name === name)?.value
      const press = find('podiumListRowPress') as (() => void) | undefined
      const longPress = find('onLongPressGesture') as (() => void) | undefined
      return (
        // biome-ignore lint/a11y/noStaticElementInteractions: the native row Button is driven at this test boundary.
        // biome-ignore lint/a11y/useKeyWithClickEvents: as above.
        <div
          data-testid={find('accessibilityIdentifier') as string | undefined}
          data-label={find('accessibilityLabel') as string | undefined}
          data-row-press={press ? 'true' : undefined}
          onClick={press}
          onContextMenu={longPress}
        >
          {children}
        </div>
      )
    },
    VStack: ({ children, modifiers }: Props) => {
      const id = modifiers?.find((m) => m.name === 'accessibilityIdentifier')?.value as
        | string
        | undefined
      const appear = modifiers?.find((m) => m.name === 'onAppear')?.value as
        | (() => void)
        | undefined
      const disappear = modifiers?.find((m) => m.name === 'onDisappear')?.value as
        | (() => void)
        | undefined
      const measure = modifiers?.find((m) => m.name === 'onGeometryChange')?.value as
        | ((geometry: { height: number }) => void)
        | undefined
      if (id && measure) native.measure.set(id, measure)
      return (
        // biome-ignore lint/a11y/noStaticElementInteractions: native cell appearance events are driven at this test boundary.
        <div
          data-testid={id}
          data-layout-priority={
            modifiers?.find((m) => m.name === 'layoutPriority')?.value as number
          }
          onMouseEnter={appear}
          onMouseLeave={disappear}
        >
          {children}
        </div>
      )
    },
    Divider: () => <hr data-testid="row-separator" />,
    Spacer: ({ modifiers }: Props) => {
      const value = modifiers?.find((m) => m.name === 'frame')?.value as
        | { height?: number }
        | undefined
      return value?.height === undefined ? null : (
        <div data-testid="row-placeholder" data-height={value.height} />
      )
    },
    Image: ({ systemName, size, modifiers }: Props & { systemName: string; size?: number }) => (
      <span
        data-native-symbol={systemName}
        data-size={size}
        data-font={JSON.stringify(modifiers?.find((m) => m.name === 'font')?.value)}
      />
    ),
    Text: ({ children, modifiers }: Props) => (
      <div
        data-layout-priority={modifiers?.find((m) => m.name === 'layoutPriority')?.value as number}
        data-fixed-size={JSON.stringify(modifiers?.find((m) => m.name === 'fixedSize')?.value)}
        data-working-word={modifiers?.some((m) => m.name === 'podiumWorkingWordGlint') || undefined}
        data-line-limit={modifiers?.find((m) => m.name === 'lineLimit')?.value as number}
        data-fills-width={
          (modifiers?.find((m) => m.name === 'frame')?.value as { maxWidth?: number })?.maxWidth ===
          Infinity
        }
      >
        {children}
      </div>
    ),
    Button: ({
      label,
      children,
      onPress,
      modifiers,
      role,
    }: Props & { label?: string; onPress: () => void; role?: string }) => (
      <button
        type="button"
        data-testid={modifiers?.find((m) => m.name === 'accessibilityIdentifier')?.value as string}
        aria-label={
          label
            ? undefined
            : (modifiers?.find((m) => m.name === 'accessibilityLabel')?.value as string)
        }
        data-native-role={role}
        data-tint={modifiers?.find((m) => m.name === 'tint')?.value as string}
        disabled={modifiers?.some((m) => m.name === 'disabled' && m.value === true)}
        onClick={onPress}
      >
        {label ?? children}
      </button>
    ),
    ContextMenu: Object.assign(
      ({ children }: Props) => <div data-native-context-menu>{children}</div>,
      {
        Trigger: Box,
        Items: ({ children }: Props) => <div data-testid="long-press-menu">{children}</div>,
      },
    ),
    SwipeActions: Object.assign(Box, {
      Actions: ({
        edge,
        allowsFullSwipe,
        children,
      }: Props & { edge: string; allowsFullSwipe: boolean }) => (
        <div data-testid={`swipe-${edge}`} data-full-swipe={String(allowsFullSwipe)}>
          {children}
        </div>
      ),
    }),
  }
})

vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'light' } }))
vi.mock('./WorkingMark', () => ({ WorkingMark: () => null }))
vi.mock('./working-word-glint.ios', () => ({
  workingWordGlint: (seed: string) => ({ name: 'podiumWorkingWordGlint', value: seed }),
}))
vi.mock('./MissionProposalRow', () => import('./MissionProposalRow.ios'))
vi.mock('./MissionProposalSlot', () => import('./MissionProposalSlot.ios'))
vi.mock('./MissionDeckList', () => import('./MissionDeckList.ios'))
vi.mock('./MissionDeckRows', () => import('./MissionDeckRows.ios'))
vi.mock('./list-row-press.ios', () => ({
  listRowPress: (onOpen: () => void) => ({ name: 'podiumListRowPress', value: onOpen }),
}))
const { MissionDeck } = await import('./MissionDeck')
const Opened = observer(function Opened({
  onPress,
  onMenu = () => {},
}: {
  onPress: () => void
  onMenu?: () => void
}) {
  const { screen } = useMissionOpening('root')
  return screen?.ready ? (
    <MissionDeck
      screen={screen}
      currentSessionId={undefined}
      onOpenSession={() => {}}
      onOpenTask={onPress}
      onOpenTaskMenu={onMenu}
      onScreenProposals={() => {}}
    />
  ) : null
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  native.measure.clear()
  native.fontScale = 1
})

/** The proposals Section, the deck's last: it carries no identifier, which
 * SwiftUI would stamp over every proposal row's own. */
function proposalsSection(): HTMLElement {
  const section = [...document.querySelectorAll<HTMLElement>('[data-native-section]')].at(-1)
  if (!section) throw new Error('Missing proposals section')
  return section
}

async function mount(count = 1, reduceMotion = false, accepted = 0) {
  const root = {
    id: asIssueId('root'),
    seq: 1,
    repoPath: '/src/podium',
    title: 'Mission',
    stage: 'in_progress',
    priority: 2,
    labels: [],
    deps: [],
    dependents: [],
    needsHuman: false,
    childCount: 0,
    childDoneCount: 0,
    parentBranch: 'main',
    archived: false,
  } as unknown as IssueViewModel
  const proposal = {
    ...root,
    id: asIssueId('proposal'),
    seq: 1931,
    parentId: root.id,
    title: 'Usage-based add-on',
    stage: 'proposed',
  } as IssueViewModel
  const commands = {
    issues: {
      start: { mutate: vi.fn(async () => {}) },
      promote: { mutate: vi.fn(async () => {}) },
      close: { mutate: vi.fn(async () => {}) },
    },
  }
  const onPress = vi.fn()
  const view = await renderWithMobileStore(
    <ReducedMotionContext value={reduceMotion}>
      <Opened onPress={onPress} />
    </ReducedMotionContext>,
    {
      issues: [
        root,
        ...Array.from({ length: accepted }, (_, index) => ({
          ...root,
          id: asIssueId(`accepted-${index}`),
          parentId: root.id,
          title: `Accepted task ${index}`,
          seq: index + 2,
        })),
        ...Array.from({ length: count }, (_, index) =>
          count === 1
            ? proposal
            : {
                ...proposal,
                id: asIssueId(`proposal-${index}`),
                title: `Proposal ${index}`,
                seq: 1931 + index,
              },
        ),
      ],
      api: commands,
    },
  )
  return { ...view, commands, onPress }
}

it.each([
  ['Start', 'start', 'Started'],
  ['Backlog', 'promote', 'In backlog'],
  ['Dismiss', 'close', 'Dismissed'],
] as const)('a tap on the revealed swipe button %s calls the desktop action and shows its receipt', async (label, command, receipt) => {
  const f = await mount()
  const group = screen.getByTestId('swipe-trailing')
  fireEvent.click(within(group).getByRole('button', { name: label }))
  await waitFor(() => expect(f.commands.issues[command].mutate).toHaveBeenCalledOnce())
  expect(f.commands.issues[command].mutate).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'proposal',
      mutationId: expect.any(String),
      ...(command === 'close' ? { reason: 'declined' } : {}),
    }),
  )
  expect(await screen.findByText(receipt)).toBeTruthy()
  if (command === 'start') expect(f.commands.issues.promote.mutate).not.toHaveBeenCalled()
})

it('only reveals proposal actions on the trailing edge and never commits a full swipe', async () => {
  await mount()
  // A left-to-right flick on the deck page pages back to the chat; nothing may
  // sit under it, least of all Start [POD-2527].
  expect(screen.queryByTestId('swipe-leading')).toBeNull()
  const trailing = screen.getByTestId('swipe-trailing')
  expect(trailing.dataset.fullSwipe).toBe('false')
  expect(
    within(trailing)
      .getAllByRole('button')
      .map((button) => button.textContent),
  ).toEqual(['Start', 'Backlog', 'Dismiss'])
  const dismiss = within(trailing).getByRole('button', { name: 'Dismiss' })
  expect(dismiss.dataset.nativeRole).toBeUndefined()
  expect(dismiss.dataset.tint).toBe('#e5303f')
  expect(
    within(screen.getByTestId('long-press-menu')).getByRole('button', { name: 'Dismiss' }).dataset
      .nativeRole,
  ).toBe('destructive')
})

it.each([
  ['Start', 'start'],
  ['Add to backlog', 'promote'],
  ['Dismiss', 'close'],
] as const)('long-press %s calls the same command', async (label, command) => {
  const f = await mount()
  fireEvent.click(
    within(screen.getByTestId('long-press-menu')).getByRole('button', { name: label }),
  )
  await waitFor(() => expect(f.commands.issues[command].mutate).toHaveBeenCalledOnce())
})

it('opens details from the context menu', async () => {
  const f = await mount()
  fireEvent.click(
    within(screen.getByTestId('long-press-menu')).getByRole('button', { name: 'Open details' }),
  )
  expect(f.onPress).toHaveBeenCalledOnce()
  expect(f.commands.issues.start.mutate).not.toHaveBeenCalled()
})

it('gives proposal text the available width and sizes the ring with Dynamic Type', async () => {
  await mount()
  const title = screen.getByText('Usage-based add-on')
  expect(title.dataset.fillsWidth).toBe('true')
  expect(title.parentElement?.dataset.layoutPriority).toBe('1')
  const ring = title.parentElement?.parentElement?.querySelector('[data-native-symbol="circle"]')
  expect(ring?.getAttribute('data-size')).toBeNull()
  expect(JSON.parse(ring?.getAttribute('data-font') ?? 'null')).toEqual({ textStyle: 'footnote' })
})

it('keeps the POD-2403 completed leaf and hibernated seat readable through catch-up and folds', async () => {
  const root = {
    id: asIssueId('root'),
    seq: 2346,
    title: 'iOS App Redesign',
    stage: 'in_progress',
    repoPath: '/fixture',
    deps: [],
  } as unknown as IssueViewModel
  const completed = {
    ...root,
    id: asIssueId('completed'),
    parentId: root.id,
    seq: 2403,
    title: 'Tasks rows and video polish',
    stage: 'done',
    closedReason: 'done',
  } as IssueViewModel
  const helper = {
    sessionId: asSessionId('helper'),
    issueId: completed.id,
    agentKind: 'codex',
    title: 'Tasks and video polish',
    name: 'Tasks and video polish',
    cwd: '/fixture',
    status: 'hibernated',
    archived: false,
    origin: { kind: 'spawn' },
    createdAt: '2026-11-11T00:00:00Z',
    agentState: { phase: 'idle', idle: { kind: 'done' } },
  } as unknown as SessionView
  const open = vi.fn()
  const menu = vi.fn()
  const f = await renderWithMobileStore(<Opened onPress={open} onMenu={menu} />, {
    issues: [
      root,
      ...Array.from({ length: 60 }, (_, index) => ({
        ...completed,
        id: asIssueId(`sibling-${index}`),
        seq: 2404 + index,
        title: `Completed sibling ${index}`,
      })),
      completed,
    ],
    sessions: [helper],
  })
  const body = screen.getByText(completed.title).closest('[data-testid="deck-task"]')
  if (!(body instanceof HTMLElement)) throw new Error('Missing completed task body')
  // A native row: SwiftUI sizes the title from the cell's width, two lines at
  // most; no React view is measured for it [POD-2529].
  const title = screen.getByText(completed.title)
  expect(title.closest('[data-native-rn-host]')).toBeNull()
  expect(title.dataset.lineLimit).toBe('2')
  expect(title.dataset.fillsWidth).toBe('true')
  expect(within(body).getByText('Done')).toBeTruthy()
  expect(within(body).getByText(/2403/)).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByLabelText(`Expand ${completed.title}`)))
  expect(screen.getByText('Tasks and video polish')).toBeTruthy()
  // The chevron is its own button: it folds and never opens the task.
  expect(open).not.toHaveBeenCalled()
  const rows = f.replica.rows('issueProjections')
  await act(async () =>
    f.replica.applySnapshot(
      'issueProjections',
      rows.map((row) => ({ ...row })),
    ),
  )
  expect(screen.getByText(completed.title).closest('[data-testid="deck-task"]')).toBe(body)
  expect(within(body).getByText('Done')).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByLabelText(`Collapse ${completed.title}`)))
  expect(screen.queryByTestId('deck-agent')).toBeNull()
  await act(async () => fireEvent.click(screen.getByTestId('deck-filter-active')))
  await act(async () => fireEvent.click(screen.getByTestId('deck-filter-all')))
  expect(screen.getByText(completed.title)).toBeTruthy()
  expect(screen.getAllByTestId('deck-task')).toHaveLength(61)
  const row = screen.getByText(completed.title).closest('[data-testid="deck-task"]')
  if (!(row instanceof HTMLElement)) throw new Error('Missing completed task row')
  fireEvent.click(row)
  expect(open).toHaveBeenCalledOnce()
  fireEvent.contextMenu(row)
  expect(menu).not.toHaveBeenCalled()
  // UIKit owns the long press. Drive the native menu item to request its
  // specific sheet, still bound to this task after catch-up and filtering.
  const nativeMenu = row.closest('[data-native-context-menu]')
  if (!(nativeMenu instanceof HTMLElement)) throw new Error('Missing native task context menu')
  fireEvent.click(
    within(within(nativeMenu).getByTestId('long-press-menu')).getByRole('button', {
      name: 'Rename',
    }),
  )
  expect(menu).toHaveBeenCalledOnce()
  expect(menu).toHaveBeenCalledWith(expect.objectContaining({ id: completed.id }), {
    kind: 'rename',
  })
})

it.each([
  ['Start', 'start', 'Starting…', 'Started', 'in_progress'],
  ['Backlog', 'promote', 'Adding to backlog…', 'In backlog', 'backlog'],
  ['Dismiss', 'close', 'Dismissing…', 'Dismissed', 'done'],
] as const)('swipe %s removes controls and retains the same cell through stage publication', async (label, command, pending, receipt, stage) => {
  const f = await mount(3)
  vi.useFakeTimers()
  const slot = screen.getByTestId('deck-proposal-slot-proposal-1')
  const section = proposalsSection()
  const originalOrder = [...section.children].filter(
    (child) => child.getAttribute('data-testid') !== 'native-section-header',
  )
  const revision = section.dataset.animationValue
  let resolve = () => {}
  f.commands.issues[command].mutate.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done
      }),
  )
  fireEvent.click(
    within(within(slot).getByTestId('swipe-trailing')).getByRole('button', { name: label }),
  )
  expect(within(slot).getByText(pending)).toBeTruthy()
  expect(within(slot).queryByTestId('swipe-leading')).toBeNull()
  expect(within(slot).queryByTestId('swipe-trailing')).toBeNull()
  expect(within(slot).queryByTestId('long-press-menu')).toBeNull()
  const proposal = f.replica.rows('issueProjections').find((row) => row.id === 'proposal-1')
  if (!proposal) throw new Error('Missing middle proposal')
  await act(async () => {
    f.replica.applyChanges(
      'issueProjections',
      [
        {
          ...proposal,
          stage,
          ...(command === 'close' ? { closedReason: 'cancelled' as const } : {}),
        },
      ],
      [],
    )
  })
  expect(screen.getByTestId('deck-proposal-slot-proposal-1')).toBe(slot)
  expect(
    [...proposalsSection().children].filter(
      (child) => child.getAttribute('data-testid') !== 'native-section-header',
    ),
  ).toEqual(originalOrder)
  expect(section.dataset.animationValue).toBe(revision)
  // The accepted tree above Proposed must not grow until the receipt expires.
  expect(screen.getAllByText('Proposal 1')).toHaveLength(1)
  expect(screen.queryByRole('tablist')).toBeNull()
  await act(async () => resolve())
  expect(within(slot).getByText(receipt)).toBeTruthy()
  await act(async () => vi.advanceTimersByTime(1799))
  expect(slot.isConnected).toBe(true)
  expect(
    [...proposalsSection().children].filter(
      (child) => child.getAttribute('data-testid') !== 'native-section-header',
    ),
  ).toEqual(originalOrder)
  await act(async () => vi.advanceTimersByTime(1))
  expect(screen.queryByTestId('deck-proposal-slot-proposal-1')).toBeNull()
  expect(proposalsSection()).toBe(section)
  expect(section.dataset.animationValue).not.toBe(revision)
  expect(screen.queryAllByText('Proposal 1')).toHaveLength(command === 'close' ? 0 : 1)
})

it('draws the separator at the title column on every proposal but the first', async () => {
  await mount(3)
  const separators = (id: string) =>
    within(screen.getByTestId(`deck-proposal-slot-${id}`)).queryAllByTestId('row-separator')
  expect(separators('proposal-0')).toHaveLength(0)
  expect(separators('proposal-1')).toHaveLength(1)
  expect(separators('proposal-2')).toHaveLength(1)
})

it('keeps the last positive content height when a receipt cell leaves and re-enters the row window', async () => {
  await mount(100)
  vi.useFakeTimers()
  await act(async () => vi.advanceTimersByTime(ROW_PRIME_MS + 1))
  const slot = screen.getByTestId('deck-proposal-slot-proposal-50')
  fireEvent.mouseEnter(slot)
  fireEvent.click(
    within(within(slot).getByTestId('swipe-trailing')).getByRole('button', { name: 'Backlog' }),
  )
  await act(async () => {})
  expect(within(slot).getByText('In backlog')).toBeTruthy()
  act(() => native.measure.get('deck-proposal-slot-proposal-50')?.({ height: 88 }))
  act(() => native.measure.get('deck-proposal-slot-proposal-50')?.({ height: 0 }))
  fireEvent.mouseLeave(slot)
  fireEvent.mouseEnter(screen.getByTestId('deck-proposal-slot-proposal-0'))
  expect(within(slot).getByTestId('row-placeholder').dataset.height).toBe('88')
  act(() => native.measure.get('deck-proposal-slot-proposal-50')?.({ height: 44 }))
  expect(within(slot).getByTestId('row-placeholder').dataset.height).toBe('88')
  fireEvent.mouseEnter(slot)
  act(() => native.measure.get('deck-proposal-slot-proposal-50')?.({ height: 104 }))
  fireEvent.mouseLeave(slot)
  fireEvent.mouseEnter(screen.getByTestId('deck-proposal-slot-proposal-0'))
  expect(screen.getByTestId('deck-proposal-slot-proposal-50')).toBe(slot)
  expect(within(slot).getByTestId('row-placeholder').dataset.height).toBe('104')
})

it.each([
  false,
  true,
])('collapses the final receipt in the same section with reduced motion %s', async (reduceMotion) => {
  const f = await mount(1, reduceMotion)
  vi.useFakeTimers()
  const section = proposalsSection()
  // SwiftUI stamps a Section's identifier over its rows' own: it has none.
  expect(section.dataset.testid).toBeUndefined()
  const revision = section.dataset.animationValue
  expect(revision === undefined).toBe(reduceMotion)
  fireEvent.click(
    within(screen.getByTestId('swipe-trailing')).getByRole('button', { name: 'Dismiss' }),
  )
  await act(async () => {})
  expect(screen.getByText('Dismissed')).toBeTruthy()
  const proposal = f.replica.rows('issueProjections').find((row) => row.id === 'proposal')
  if (!proposal) throw new Error('Missing proposal')
  await act(async () =>
    f.replica.applyChanges(
      'issueProjections',
      [{ ...proposal, stage: 'done', closedReason: 'cancelled' }],
      [],
    ),
  )
  await act(async () => vi.advanceTimersByTime(1800))
  expect(section.isConnected).toBe(true)
  expect(section.children).toHaveLength(0)
  if (!reduceMotion) expect(section.dataset.animationValue).not.toBe(revision)
})

it('keeps native proposal action trees inside the shared 40-row window', async () => {
  await mount(700)
  expect(screen.getAllByTestId('long-press-menu')).toHaveLength(ROW_WINDOW_SIZE)
  expect(screen.getByText('Proposal 0')).toBeTruthy()
  expect(screen.queryByText('Proposal 500')).toBeNull()
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, ROW_PRIME_MS + 20)))
  await act(async () => fireEvent.mouseEnter(screen.getByTestId('deck-proposal-slot-proposal-500')))
  expect(screen.getAllByTestId('long-press-menu')).toHaveLength(ROW_WINDOW_SIZE)
  expect(screen.getByText('Proposal 500')).toBeTruthy()
  expect(screen.queryByText('Proposal 0')).toBeNull()
  const group = within(screen.getByTestId('deck-proposal-slot-proposal-500'))
  fireEvent.click(
    within(group.getByTestId('swipe-trailing')).getByRole('button', { name: 'Start' }),
  )
  expect(await group.findByText('Started')).toBeTruthy()
})

it('draws each accepted task as its own native row and keeps the gauge outside rounded cells', async () => {
  const f = await mount(48, false, 60)
  const tasks = screen.getAllByTestId('deck-task')
  expect(tasks).toHaveLength(60)
  // Only the fixed-size stage glyph is a React view; every title, ref and word
  // is SwiftUI text that the List measures and recycles itself [POD-2529].
  for (const task of tasks) {
    expect(task.dataset.rowPress).toBe('true')
    for (const host of task.querySelectorAll('[data-native-rn-host]'))
      expect(host.textContent).toBe('')
  }
  expect(screen.getByText('Accepted task 7').closest('[data-native-rn-host]')).toBeNull()
  expect(
    screen.getByTestId('deck-gauge').closest('[data-testid="native-section-header"]'),
  ).toBeTruthy()
  expect(
    screen
      .getByTestId('deck-gauge')
      .closest('[data-native-rn-host]')
      ?.querySelector('[data-testid="deck-task"]'),
  ).toBeNull()
  const rows = f.replica.rows('issueProjections')
  // Resume catch-up can replace every projection while retaining the same native rows.
  await act(async () =>
    f.replica.applySnapshot(
      'issueProjections',
      rows.map((row) => ({
        ...row,
        ...(row.id === 'accepted-50'
          ? { title: 'Caught-up accepted task', stage: 'review' as const }
          : {}),
      })),
    ),
  )
  expect(screen.getAllByTestId('deck-task')).toHaveLength(60)
  const updated = screen.getByText('Caught-up accepted task').closest('[data-testid="deck-task"]')
  expect(updated).toBe(tasks[50])
  fireEvent.click(screen.getByTestId('deck-filter-active'))
  fireEvent.click(screen.getByTestId('deck-filter-all'))
  expect(screen.getAllByTestId('deck-task')).toHaveLength(60)
})

it.each([
  ['working', true, 'Working'],
  ['idle', false, 'Idle'],
  ['errored', false, 'Error'],
  ['needs-you', false, 'Needs you'],
] as const)('native task and seat words only glint in the shared working state, phase=%s', async (phase, working, label) => {
  native.fontScale = 2.35
  const root = {
    id: asIssueId('root'),
    seq: 1,
    title: 'Mission',
    stage: 'in_progress',
    repoPath: '/fixture',
    priority: 2,
    labels: [],
    deps: [],
    dependents: [],
    needsHuman: false,
    childCount: 0,
    childDoneCount: 0,
    parentBranch: 'main',
    archived: false,
  } as unknown as IssueViewModel
  const task = { ...root, id: asIssueId('task'), parentId: root.id, seq: 2, title: 'Task' }
  const worker = (id: string, issueId: typeof root.id) =>
    ({
      sessionId: asSessionId(id),
      issueId,
      agentKind: 'claude-code',
      observedModel: 'claude-opus-5-5',
      title: id,
      name: id,
      cwd: '/fixture',
      status: 'live',
      archived: false,
      origin: { kind: 'spawn' },
      createdAt: '2026-11-11T00:00:00Z',
      agentState: { phase: phase === 'needs-you' ? 'idle' : phase },
      ...(phase === 'needs-you'
        ? { offer: { message: 'Review', actions: [{ label: 'Accept', prompt: 'accept' }] } }
        : {}),
    }) as unknown as SessionView
  await renderWithMobileStore(
    <ReducedMotionContext value={true}>
      <Opened onPress={() => {}} />
    </ReducedMotionContext>,
    { issues: [root, task], sessions: [worker('lead', root.id), worker('helper', task.id)] },
  )
  const taskRow = screen.getByTestId('deck-task')
  const seatRow = screen.getByTestId('deck-seat')
  expect(Boolean(taskRow.querySelector('[data-working-word]'))).toBe(working)
  expect(Boolean(seatRow.querySelector('[data-working-word]'))).toBe(working)
  // The native title and state word stay outside every RN host, including at AX sizes.
  expect(screen.getByText('Task').closest('[data-native-rn-host]')).toBeNull()
  const expand = screen.queryByRole('button', { name: 'Expand Task' })
  if (expand) await act(async () => fireEvent.click(expand))
  expect(Boolean(screen.getByTestId('deck-agent').querySelector('[data-working-word]'))).toBe(
    working,
  )
  for (const row of [seatRow, screen.getByTestId('deck-agent')]) {
    const state = within(row).getByText(label)
    const model = within(row).getByText(/Opus 5\.5/)
    expect(state.dataset.layoutPriority).toBe('1')
    expect(JSON.parse(state.dataset.fixedSize ?? 'null')).toEqual({
      horizontal: true,
      vertical: false,
    })
    expect(model.dataset.layoutPriority).toBe('-1')
    expect(model.dataset.lineLimit).toBe('1')
  }
  expect(taskRow.querySelector('[data-native-rn-host] [data-working-word]')).toBeNull()
  expect(screen.queryByTestId('working-word-glint')).toBeNull()
})
