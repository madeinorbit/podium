import type { IssueViewModel } from '@podium/client-core/replica'
import { ROW_WINDOW_SIZE } from '@podium/client-graph/row-window'
import { asIssueId } from '@podium/model'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { observer } from 'mobx-react-lite'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useMissionOpening } from '../client/hooks'
import { renderWithMobileStore } from '../client/test-support'
import { ReducedMotionContext } from '../hooks/useReduceMotion'
import { ROW_PRIME_MS } from '../lib/use-row-prime'

const native = vi.hoisted(() => ({
  measure: new Map<string, (geometry: { height: number }) => void>(),
}))

vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  ...Object.fromEntries(
    [
      'accessibilityElement',
      'accessibilityHint',
      'accessibilityIdentifier',
      'accessibilityLabel',
      'background',
      'buttonStyle',
      'contentShape',
      'disabled',
      'font',
      'foregroundStyle',
      'frame',
      'lineLimit',
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
  shapes: { rectangle: () => ({}) },
  Animation: { default: 'default' },
  animation: (_preset: unknown, value: unknown) => ({ name: 'animation', value }),
}))

vi.mock('@expo/ui', () => ({
  Host: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('@expo/ui/swift-ui', () => {
  type Props = { children?: ReactNode; modifiers?: { name: string; value: unknown }[] }
  const Box = ({ children }: Props) => <div>{children}</div>
  return {
    List: Box,
    RNHostView: Box,
    Section: ({ children, modifiers }: Props) => (
      <div
        data-testid={modifiers?.find((m) => m.name === 'accessibilityIdentifier')?.value as string}
        data-animation-value={modifiers?.find((m) => m.name === 'animation')?.value as number}
      >
        {children}
      </div>
    ),
    HStack: Box,
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
        <div data-testid={id} onMouseEnter={appear} onMouseLeave={disappear}>
          {children}
        </div>
      )
    },
    Spacer: ({ modifiers }: Props) => {
      const value = modifiers?.find((m) => m.name === 'frame')?.value as
        | { height?: number }
        | undefined
      return value?.height === undefined ? null : (
        <div data-testid="row-placeholder" data-height={value.height} />
      )
    },
    Image: () => null,
    Text: Box,
    Button: ({
      label,
      children,
      onPress,
      modifiers,
      role,
    }: Props & { label?: string; onPress: () => void; role?: string }) => (
      <button
        type="button"
        data-native-role={role}
        data-tint={modifiers?.find((m) => m.name === 'tint')?.value as string}
        disabled={modifiers?.some((m) => m.name === 'disabled' && m.value === true)}
        onClick={onPress}
      >
        {label ?? children}
      </button>
    ),
    ContextMenu: Object.assign(Box, {
      Trigger: Box,
      Items: ({ children }: Props) => <div data-testid="long-press-menu">{children}</div>,
    }),
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
vi.mock('./MissionProposalRow', () => import('./MissionProposalRow.ios'))
vi.mock('./MissionProposalSlot', () => import('./MissionProposalSlot.ios'))
vi.mock('./MissionDeckList', () => import('./MissionDeckList.ios'))
const { MissionDeck } = await import('./MissionDeck')
const Opened = observer(function Opened({ onPress }: { onPress: () => void }) {
  const { screen } = useMissionOpening('root')
  return screen?.ready ? (
    <MissionDeck
      screen={screen}
      currentSessionId={undefined}
      onOpenSession={() => {}}
      onOpenTask={onPress}
      onOpenTaskMenu={() => {}}
      onScreenProposals={() => {}}
    />
  ) : null
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  native.measure.clear()
})

async function mount(count = 1, reduceMotion = false) {
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
  ['leading', 'Start', 'start', 'Started'],
  ['leading', 'Backlog', 'promote', 'In backlog'],
  ['trailing', 'Dismiss', 'close', 'Dismissed'],
] as const)('native %s swipe %s calls the desktop action and shows its receipt', async (edge, label, command, receipt) => {
  const f = await mount()
  const group = screen.getByTestId(`swipe-${edge}`)
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

it('makes Start the leading full-swipe action and keeps Dismiss red without native optimistic deletion', async () => {
  await mount()
  const leading = screen.getByTestId('swipe-leading')
  expect(leading.dataset.fullSwipe).toBe('true')
  expect(
    within(leading)
      .getAllByRole('button')
      .map((button) => button.textContent),
  ).toEqual(['Start', 'Backlog'])
  const trailing = screen.getByTestId('swipe-trailing')
  expect(trailing.dataset.fullSwipe).toBe('false')
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

it.each([
  ['leading', 'Start', 'start', 'Starting…', 'Started', 'in_progress'],
  ['leading', 'Backlog', 'promote', 'Adding to backlog…', 'In backlog', 'backlog'],
  ['trailing', 'Dismiss', 'close', 'Dismissing…', 'Dismissed', 'done'],
] as const)('%s %s removes controls and retains the same cell through stage publication', async (edge, label, command, pending, receipt, stage) => {
  const f = await mount(3)
  vi.useFakeTimers()
  const slot = screen.getByTestId('deck-proposal-slot-proposal-1')
  const section = screen.getByTestId('deck-proposals')
  const originalOrder = [...section.children]
  const revision = section.dataset.animationValue
  let resolve = () => {}
  f.commands.issues[command].mutate.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done
      }),
  )
  fireEvent.click(
    within(within(slot).getByTestId(`swipe-${edge}`)).getByRole('button', { name: label }),
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
  expect([...screen.getByTestId('deck-proposals').children]).toEqual(originalOrder)
  expect(section.dataset.animationValue).toBe(revision)
  // The accepted tree above Proposed must not grow until the receipt expires.
  expect(screen.getAllByText('Proposal 1')).toHaveLength(1)
  expect(screen.queryByRole('tablist')).toBeNull()
  await act(async () => resolve())
  expect(within(slot).getByText(receipt)).toBeTruthy()
  await act(async () => vi.advanceTimersByTime(1799))
  expect(slot.isConnected).toBe(true)
  expect([...screen.getByTestId('deck-proposals').children]).toEqual(originalOrder)
  await act(async () => vi.advanceTimersByTime(1))
  expect(screen.queryByTestId('deck-proposal-slot-proposal-1')).toBeNull()
  expect(screen.getByTestId('deck-proposals')).toBe(section)
  expect(section.dataset.animationValue).not.toBe(revision)
  expect(screen.queryAllByText('Proposal 1')).toHaveLength(command === 'close' ? 0 : 1)
})

it('keeps the last positive content height when a receipt cell leaves and re-enters the row window', async () => {
  await mount(100)
  vi.useFakeTimers()
  await act(async () => vi.advanceTimersByTime(ROW_PRIME_MS + 1))
  const slot = screen.getByTestId('deck-proposal-slot-proposal-50')
  fireEvent.mouseEnter(slot)
  fireEvent.click(
    within(within(slot).getByTestId('swipe-leading')).getByRole('button', { name: 'Backlog' }),
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
  const section = screen.getByTestId('deck-proposals')
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
  fireEvent.click(within(group.getByTestId('swipe-leading')).getByRole('button', { name: 'Start' }))
  expect(await group.findByText('Started')).toBeTruthy()
})
