import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { asIssueId, asSessionId } from '@podium/model'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'
import type { TerminalControlState } from '../terminal/terminal-control'

type HeaderOptions = {
  title?: string
  headerTitle?: unknown
  headerLeft?: unknown
  headerRight?: unknown
  headerBackTitle?: string
  headerBackButtonDisplayMode?: string
  unstable_nativeProps?: { headerConfig: { subtitle?: string } }
}
const native = vi.hoisted(() => ({
  options: {} as HeaderOptions,
  publish: undefined as ((control: TerminalControlState) => void) | undefined,
  push: vi.fn(),
  takeControl: vi.fn(),
}))
vi.mock('react-native', async (original) => {
  const real = await original<typeof import('react-native')>()
  return { ...real, Platform: { ...real.Platform, OS: 'ios' } }
})
vi.mock('expo-router', async () => ({
  useLocalSearchParams: () => ({ sessionId: 'console-header' }),
  useRouter: () => ({ back() {}, push: native.push }),
  useFocusEffect: (await import('react')).useEffect,
}))
vi.mock('expo-router/stack', () => ({
  Stack: {
    Screen: ({ options }: { options: HeaderOptions }) => {
      native.options = options
      return null
    },
    Toolbar: Object.assign(({ children }: { children: ReactNode }) => <>{children}</>, {
      Menu: ({
        children,
        accessibilityLabel,
      }: {
        children: ReactNode
        accessibilityLabel: string
      }) => <fieldset aria-label={accessibilityLabel}>{children}</fieldset>,
      MenuAction: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => (
        <button type="button" onClick={onPress}>
          {children}
        </button>
      ),
    }),
  },
}))
vi.mock('expo-router/react-navigation', async () => ({
  HeaderHeightContext: (await import('react')).createContext(103),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}))
vi.mock('../navigation/native-stack', async (original) => ({
  ...(await original<object>()),
  nativeSubtitleAvailable: true,
  transparentDetailHeader: true,
}))
vi.mock('../components/Screen', async () => import('../components/Screen.native'))
vi.mock('../terminal/TerminalPane', () => ({
  TerminalPane: ({ onControlState }: { onControlState: typeof native.publish }) => {
    native.publish = onControlState
    return <div data-testid="console-canvas" />
  },
}))
const { default: TerminalRoute } = await import('../../app/session/[sessionId]/terminal')

const issueId = asIssueId('console-task')
const session = {
  sessionId: asSessionId('console-header'),
  issueId,
  title: 'Scanner Diagnose',
  agentKind: 'claude-code',
  cwd: '/repo',
  status: 'live',
  archived: false,
  createdAt: '2026-11-13T10:00:00Z',
} as SessionView
const issue = {
  id: issueId,
  repoPath: '/repo',
  prefix: 'VNT',
  seq: 144,
  title: 'Bottle scanner',
  stage: 'in_progress',
  priority: 2,
  archived: false,
  labels: [],
  deps: [],
  dependents: [],
  childCount: 0,
  childDoneCount: 0,
  needsHuman: false,
} as unknown as IssueViewModel

function publish(control: Partial<TerminalControlState> = {}) {
  act(() =>
    native.publish?.({
      role: 'spectator',
      cols: 103,
      rows: 28,
      ready: true,
      takeControl: native.takeControl,
      ...control,
    }),
  )
}

beforeEach(() => {
  native.options = {}
  vi.clearAllMocks()
})
afterEach(cleanup)

it('uses one native title and subtitle without a title overlay, floating identity strip or extra inset', async () => {
  await renderWithMobileStore(<TerminalRoute />, { sessions: [session], issues: [issue] })
  const canvas = await screen.findByTestId('console-canvas')
  publish({ role: 'controller', cols: 67, rows: 41 })

  expect(native.options.title).toBe('Scanner Diagnose')
  expect(native.options.unstable_nativeProps?.headerConfig.subtitle).toBe(
    'Claude · In control · 67×41',
  )
  expect(native.options.headerTitle).toBeUndefined()
  expect(native.options.headerLeft).toBeUndefined()
  expect(native.options.headerRight).toBeUndefined()
  // UIKit gets the previous screen's real title, including its long-press back
  // target. It may shorten the visible label when the session title needs room.
  expect(native.options.headerBackButtonDisplayMode).toBe('default')
  expect(native.options.headerBackTitle).toBeUndefined()
  expect(screen.queryByText('Claude')).toBeNull()
  expect(screen.queryByText(/phone grid|VNT 144/)).toBeNull()
  const insetAncestors: HTMLElement[] = []
  for (let node = canvas.parentElement; node; node = node.parentElement) {
    if (node.style.paddingTop) insetAncestors.push(node)
  }
  expect(insetAncestors.map((node) => node.style.paddingTop)).toEqual(['103px'])
})

it('keeps task navigation in the native menu and gates control until attachment', async () => {
  await renderWithMobileStore(<TerminalRoute />, { sessions: [session], issues: [issue] })
  await screen.findByTestId('console-canvas')
  publish({ ready: false, cols: undefined, rows: undefined })
  expect(native.options.unstable_nativeProps?.headerConfig.subtitle).toBe('Claude')
  expect(screen.queryByRole('button', { name: /Take control/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Open task VNT-144' }))
  expect(native.push).toHaveBeenCalledWith('/issue/console-task')

  publish()
  expect(native.options.unstable_nativeProps?.headerConfig.subtitle).toBe(
    'Claude · Spectating · 103×28',
  )
  expect(native.takeControl).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /Take control and resize shared terminal/ }))
  expect(native.takeControl).toHaveBeenCalledTimes(1)
  expect(native.options.unstable_nativeProps?.headerConfig.subtitle).toContain('Spectating')
  publish({ role: 'controller', cols: 67, rows: 41 })
  fireEvent.click(screen.getByRole('button', { name: 'Refit shared terminal to this phone' }))
  expect(native.takeControl).toHaveBeenCalledTimes(2)
})

it('omits unknown grid dimensions and supports consoles without a task', async () => {
  await renderWithMobileStore(<TerminalRoute />, { sessions: [{ ...session, issueId: undefined }] })
  await screen.findByTestId('console-canvas')
  expect(screen.queryByRole('button', { name: /Open task/ })).toBeNull()
  publish({ cols: undefined, rows: undefined })
  expect(native.options.unstable_nativeProps?.headerConfig.subtitle).toBe('Claude · Spectating')
  publish({ role: 'controller', cols: 67, rows: undefined })
  expect(native.options.unstable_nativeProps?.headerConfig.subtitle).toBe('Claude · In control')
})
