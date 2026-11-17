import type { IssueViewModel } from '@podium/client-core/replica'
import { asIssueId } from '@podium/model'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { observer } from 'mobx-react-lite'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useMissionOpening } from '../client/hooks'
import { renderWithMobileStore } from '../client/test-support'
import { ReducedMotionContext } from '../hooks/useReduceMotion'

type Modifier = { name: string; value: unknown }
type Props = { children?: ReactNode; modifiers?: Modifier[]; header?: ReactNode }
const value = (props: Props, name: string) => props.modifiers?.find((m) => m.name === name)?.value

vi.mock('@expo/ui', () => ({ Host: ({ children }: Props) => <div>{children}</div> }))
vi.mock('@expo/ui/swift-ui', () => {
  const Box = ({ children }: Props) => <div>{children}</div>
  return {
    Button: (props: Props & { label?: string; systemImage?: string; onPress: () => void }) => (
      <button
        type="button"
        data-testid={value(props, 'accessibilityIdentifier') as string}
        aria-label={value(props, 'accessibilityLabel') as string}
        data-value={value(props, 'accessibilityValue') as string}
        data-symbol={props.systemImage}
        onClick={props.onPress}
      >
        {props.label ?? props.children}
      </button>
    ),
    HStack: Box,
    VStack: Box,
    RNHostView: Box,
    Spacer: () => null,
    Text: ({ children }: Props) => <span>{children}</span>,
    Section: ({ children, header }: Props) => (
      <section>
        {header}
        {children}
      </section>
    ),
    Group: (props: Props) => (
      <div data-testid="task-animation" data-revision={value(props, 'animation') as number}>
        {props.children}
      </div>
    ),
    List: (props: Props) => (
      <div data-testid="native-list" data-revision={value(props, 'animation') as number}>
        {props.children}
      </div>
    ),
  }
})
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  ...Object.fromEntries(
    [
      'accessibilityAddTraits',
      'accessibilityHint',
      'accessibilityIdentifier',
      'accessibilityLabel',
      'accessibilityValue',
      'background',
      'buttonStyle',
      'fixedSize',
      'font',
      'foregroundStyle',
      'frame',
      'listRowInsets',
      'listSectionMargins',
      'listSectionSpacing',
      'listStyle',
      'scrollContentBackground',
      'tint',
    ].map((name) => [name, (value: unknown) => ({ name, value })]),
  ),
  Animation: { default: 'default' },
  animation: (_preset: unknown, value: unknown) => ({ name: 'animation', value }),
}))
vi.mock('./MissionDeckList', () => import('./MissionDeckList.ios'))

const { DoneHidden, DoneToggle } = await import('./MissionDeckDone.ios')
const { DeckTasks, MissionDeckList } = await import('./MissionDeckList.ios')

afterEach(cleanup)

const Controls = observer(function Controls() {
  const { screen } = useMissionOpening('root')
  if (!screen?.full.ready) return null
  const full = screen.full
  return (
    <>
      <DoneToggle full={full} />
      <MissionDeckList>
        <DeckTasks ids={full.rowIds}>
          {full.rowIds.map((id) => (
            <div key={id} data-testid={`task-${id}`} />
          ))}
          <DoneHidden full={full} />
        </DeckTasks>
      </MissionDeckList>
    </>
  )
})

async function mount(reduceMotion = false, phaseOnly = false) {
  const issue = (id: string, patch: Partial<IssueViewModel> = {}) =>
    ({
      id: asIssueId(id),
      seq: id.length,
      title: id,
      repoPath: '/src/podium',
      stage: 'backlog',
      deps: [],
      dependents: [],
      ...patch,
    }) as IssueViewModel
  return renderWithMobileStore(
    <ReducedMotionContext.Provider value={reduceMotion}>
      <Controls />
    </ReducedMotionContext.Provider>,
    {
      issues: [
        issue('root'),
        issue('done', {
          parentId: asIssueId('root'),
          stage: 'done',
          ...(phaseOnly ? { type: 'phase' } : {}),
        }),
        issue('todo', { parentId: asIssueId('root') }),
      ],
    },
  )
}

it('shows the native toggle state and reveals hidden work through the footer', async () => {
  await mount()
  const toggle = screen.getByTestId('deck-filter-done')
  expect(toggle.getAttribute('aria-label')).toBe('Done tasks, 1')
  expect(toggle.dataset.symbol).toBe('checkmark.circle.fill')
  expect(toggle.dataset.value).toBe('Shown')
  expect(screen.queryByTestId('deck-done-hidden')).toBeNull()
  await act(async () => fireEvent.click(toggle))
  expect(toggle.getAttribute('aria-label')).toBe('Done tasks, 1')
  expect(toggle.dataset.symbol).toBe('checkmark.circle')
  expect(toggle.dataset.value).toBe('Hidden')
  expect(screen.queryByTestId('task-done')).toBeNull()
  expect(screen.getByTestId('task-todo')).toBeTruthy()
  const footer = screen.getByTestId('deck-done-hidden')
  expect(footer.getAttribute('aria-label')).toBe('1 done hidden')
  await act(async () => fireEvent.click(footer))
  expect(toggle.dataset.symbol).toBe('checkmark.circle.fill')
  expect(screen.getByTestId('task-done')).toBeTruthy()
  expect(screen.queryByTestId('deck-done-hidden')).toBeNull()
})

it('animates task insertions and deletions without animating the entire list', async () => {
  await mount()
  const revision = () => screen.getByTestId('task-animation').dataset.revision
  const shown = revision()
  expect(shown).toBeDefined()
  await act(async () => fireEvent.click(screen.getByTestId('deck-filter-done')))
  expect(revision()).not.toBe(shown)
  expect(screen.getByTestId('native-list').dataset.revision).toBeUndefined()
  await act(async () => fireEvent.click(screen.getByTestId('deck-filter-done')))
  expect(revision()).toBe(shown)
})

it('respects Reduce Motion while retaining both toggle directions', async () => {
  await mount(true)
  await act(async () => fireEvent.click(screen.getByTestId('deck-filter-done')))
  expect(screen.getByTestId('task-animation').dataset.revision).toBeUndefined()
  expect(screen.queryByTestId('task-done')).toBeNull()
  await act(async () => fireEvent.click(screen.getByTestId('deck-done-hidden')))
  expect(screen.getByTestId('task-done')).toBeTruthy()
})

it('names a completed empty phase when there are no done task leaves', async () => {
  await mount(false, true)
  await act(async () => fireEvent.click(screen.getByTestId('deck-filter-done')))
  expect(screen.getByTestId('deck-done-hidden').getAttribute('aria-label')).toBe('1 phase hidden')
})
