import type { IssueViewModel } from '@podium/client-core/replica'
import { ROW_WINDOW_SIZE } from '@podium/client-graph/row-window'
import { asIssueId } from '@podium/model'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { observer } from 'mobx-react-lite'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useMissionOpening } from '../client/hooks'
import { renderWithMobileStore } from '../client/test-support'
import { ROW_PRIME_MS } from '../lib/use-row-prime'

vi.mock('@expo/ui/swift-ui/modifiers', () =>
  Object.fromEntries(
    [
      'accessibilityElement',
      'accessibilityHint',
      'accessibilityIdentifier',
      'accessibilityLabel',
      'buttonStyle',
      'contentShape',
      'disabled',
      'font',
      'foregroundStyle',
      'frame',
      'lineLimit',
      'listRowBackground',
      'listRowInsets',
      'listRowSeparatorTint',
      'tint',
      'onAppear',
      'onDisappear',
      'onGeometryChange',
    ]
      .map((name) => [name, (value: unknown) => ({ name, value })])
      .concat([['shapes', { rectangle: () => ({}) }] as never]),
  ),
)

vi.mock('@expo/ui/swift-ui', () => {
  type Props = { children?: ReactNode; modifiers?: { name: string; value: unknown }[] }
  const Box = ({ children }: Props) => <div>{children}</div>
  return {
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
      return (
        // biome-ignore lint/a11y/noStaticElementInteractions: native cell appearance events are driven at this test boundary.
        <div data-testid={id} onMouseEnter={appear} onMouseLeave={disappear}>
          {children}
        </div>
      )
    },
    Spacer: () => null,
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
afterEach(cleanup)

async function mount(count = 1) {
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
  await renderWithMobileStore(<Opened onPress={onPress} />, {
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
  })
  return { commands, onPress }
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

it('makes Start the leading full-swipe action and Dismiss a native destructive action', async () => {
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
  expect(within(trailing).getByRole('button', { name: 'Dismiss' }).dataset.nativeRole).toBe(
    'destructive',
  )
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
