import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { asIssueId, asSessionId } from '@podium/model'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { NavigationContext } from 'expo-router/build/react-navigation/core/NavigationContext'
import { NavigationRouteContext } from 'expo-router/build/react-navigation/core/NavigationProvider'
import { StackActions, StackRouter } from 'expo-router/build/react-navigation/routers/StackRouter'
import type { NavigationState } from 'expo-router/react-navigation'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'
import { MISSION_CHAT, MISSION_DECK } from '../navigation/mission-stack'

const navigation = vi.hoisted(() => ({
  platform: 'ios',
  params: {} as Record<string, string>,
  state: null as NavigationState | null,
  back: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  dismissTo: vi.fn(),
  holdOpening: false,
  remembered: null as string | null,
}))
vi.mock('react-native', async (original) => {
  const real = await original<typeof import('react-native')>()
  return {
    ...real,
    Platform: {
      ...real.Platform,
      get OS() {
        return navigation.platform
      },
    },
  }
})
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => navigation.params,
  useRouter: () => ({ ...navigation, canGoBack: () => true }),
}))
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  selectionAsync: async () => {},
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('../client/hooks', async (original) => {
  const real = await original<typeof import('../client/hooks')>()
  return {
    ...real,
    useMissionOpening: (id: string) => {
      const opening = real.useMissionOpening(id)
      return navigation.holdOpening ? { ...opening, resolved: false } : opening
    },
    useTaskSeatMemory: () => {
      const memory = real.useTaskSeatMemory()
      return navigation.remembered ? { ...memory, recall: () => navigation.remembered } : memory
    },
  }
})
vi.mock('../client/screen-read-focus', () => ({ useScreenReadFocus: () => {} }))
vi.mock('../components/SessionConversation', () => ({
  SessionConversation: ({ session }: { session: SessionView }) => (
    <div data-testid="chat">{session.sessionId}</div>
  ),
}))
vi.mock('../components/Glass', () => ({
  Glass: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('../components/TaskSheet', () => ({ TaskSheet: () => null }))
vi.mock('../components/ActionSheet', () => ({
  ActionSheet: ({
    visible,
    actions,
  }: {
    visible: boolean
    actions: { label: string; onPress: () => void }[]
  }) =>
    visible ? (
      <div data-testid="mission-actions-sheet">
        {actions.map((action) => (
          <button type="button" key={action.label} onClick={action.onPress}>
            {action.label}
          </button>
        ))}
      </div>
    ) : null,
}))
vi.mock('../components/IssueCloseSheet', () => ({ IssueCloseSheet: () => null }))
vi.mock('../components/ConfiguredIssueLaunchSheet', () => ({
  ConfiguredIssueLaunchSheet: () => null,
}))
vi.mock('../components/WorkIssueMenu', () => ({ WorkIssueMenu: () => null }))
vi.mock('../components/WorkingMark', () => ({ WorkingMark: () => null }))
const { MissionScreen } = await import('./MissionScreen')
const { MissionDetailsScreen } = await import('./MissionDetailsScreen')
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  navigation.platform = 'ios'
  navigation.holdOpening = false
  navigation.remembered = null
})

const options = {
  routeNames: ['(tabs)', MISSION_CHAT, MISSION_DECK],
  routeParamList: {},
  routeGetIdList: {},
}
const stack = StackRouter({ initialRouteName: '(tabs)' })
function Navigator() {
  const [state, setState] = useState(() => {
    const initial = stack.getInitialState(options)
    const opened = stack.getStateForAction(
      initial,
      StackActions.push(MISSION_CHAT, { missionId: 'child' }),
      options,
    )
    if (!opened) throw new Error('Cannot open task')
    return stack.getRehydratedState(opened, options)
  })
  navigation.state = state
  const route = state.routes[state.index]
  if (!route) throw new Error('Missing screen')
  const transitionListeners = useRef(new Set<(event: { data: { closing: boolean } }) => void>())
  // biome-ignore lint/correctness/useExhaustiveDependencies: emulate native appearance once for each pushed route
  useEffect(() => {
    for (const listener of transitionListeners.current) listener({ data: { closing: false } })
  }, [route.key])
  navigation.params = route.params as Record<string, string>
  const dispatch = (action: Parameters<typeof stack.getStateForAction>[1]) => {
    setState((current) => {
      const next = stack.getStateForAction(current, action, options)
      return next ? stack.getRehydratedState(next, options) : current
    })
  }
  navigation.back.mockImplementation(() => dispatch(StackActions.pop(1)))
  navigation.push.mockImplementation((url: string) => {
    const [path, query] = url.split('?')
    dispatch(
      StackActions.push(path?.endsWith('/details') ? MISSION_DECK : MISSION_CHAT, {
        missionId: path?.split('/')[2],
        ...Object.fromEntries(new URLSearchParams(query)),
      }),
    )
  })
  navigation.dismissTo.mockImplementation((url: string) => {
    const [path, query] = url.split('?')
    dispatch(
      StackActions.popTo(MISSION_CHAT, {
        missionId: path?.split('/')[2],
        ...Object.fromEntries(new URLSearchParams(query)),
      }),
    )
  })
  const owner = {
    getState: () => state,
    dispatch,
    isFocused: () => true,
    addListener: (event: string, listener: (event: { data: { closing: boolean } }) => void) => {
      if (event !== 'transitionEnd') return () => {}
      transitionListeners.current.add(listener)
      return () => transitionListeners.current.delete(listener)
    },
  } as unknown as NonNullable<React.ContextType<typeof NavigationContext>>
  return (
    <NavigationContext value={owner}>
      <NavigationRouteContext value={route}>
        {route.name === MISSION_CHAT ? (
          <MissionScreen />
        ) : route.name === MISSION_DECK ? (
          <MissionDetailsScreen />
        ) : (
          <div>Work</div>
        )}
      </NavigationRouteContext>
    </NavigationContext>
  )
}

const issue = (id: string, fields: Partial<IssueViewModel> = {}) =>
  ({
    id: asIssueId(id),
    repoPath: '/src/podium',
    seq: id === 'root' ? 1 : 2,
    title: id,
    stage: 'in_progress',
    priority: 2,
    labels: [],
    deps: [],
    dependents: [],
    needsHuman: false,
    childCount: id === 'root' ? 1 : 0,
    childDoneCount: 0,
    parentBranch: 'main',
    archived: false,
    ...fields,
  }) as IssueViewModel
const agent = (id: string, issueId: string) =>
  ({
    sessionId: asSessionId(id),
    issueId: asIssueId(issueId),
    name: id,
    title: id,
    cwd: '/src/podium',
    agentKind: 'codex',
    status: 'live',
    archived: false,
    origin: { kind: 'spawn' },
    createdAt: '2026-11-13T07:00:00Z',
    lastActiveAt: '2026-11-13T07:00:00Z',
    agentState: { phase: 'working', since: '2026-11-13T07:00:00Z' },
  }) as SessionView

it('names the opening chat from the pool and shows a transcript skeleton while the deck loads', async () => {
  navigation.holdOpening = true
  navigation.params = { missionId: 'child' }
  function Entry() {
    const [open, setOpen] = useState(false)
    return open ? (
      <MissionScreen />
    ) : (
      <button type="button" onClick={() => setOpen(true)}>
        Open chat
      </button>
    )
  }
  await renderWithMobileStore(<Entry />, {
    issues: [issue('child', { title: 'Pricing page draft' })],
  })
  // A Work/Tasks row is already drawn from this pool. Check the very first
  // chat commit after the tap, while full mission readiness stays pending.
  fireEvent.click(screen.getByRole('button', { name: 'Open chat' }))
  expect(screen.getByText('Pricing page draft')).toBeTruthy()
  expect(screen.getByLabelText('Loading transcript')).toBeTruthy()
  expect(screen.queryByLabelText('Loading task detail')).toBeNull()
  expect(screen.queryByText('Mission')).toBeNull()
  expect(navigation.push).not.toHaveBeenCalled()
  const capture = process.env.PODIUM_MOBILE_CHAT_LOADING_CAPTURE
  if (capture) {
    const css = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules, (rule) => rule.cssText))
      .join('\n')
    const fonts = [
      ['Geist-Regular', 'geist/400Regular/Geist_400Regular.ttf'],
      ['Geist-SemiBold', 'geist/600SemiBold/Geist_600SemiBold.ttf'],
    ]
      .map(
        ([name, path]) =>
          `@font-face{font-family:${name};src:url(data:font/ttf;base64,${readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/@expo-google-fonts', path ?? '')).toString('base64')})}`,
      )
      .join('\n')
    writeFileSync(
      capture,
      `<!doctype html><html><head><meta charset="utf-8"><title>Chat loading web layout</title><style>${fonts}\n${css}\nhtml,body{width:402px;height:874px;margin:0;background:#16171a}body{display:flex}body>div{display:flex;flex:1;min-width:0}</style></head><body>${document.body.innerHTML}</body></html>`,
    )
  }
})

it('uses the requested session task title before mission membership resolves', async () => {
  navigation.holdOpening = true
  navigation.params = { missionId: 'root', sessionId: 'child-lead' }
  await renderWithMobileStore(<MissionScreen />, {
    issues: [
      issue('root'),
      issue('child', { parentId: asIssueId('root'), title: 'Pricing page draft' }),
    ],
    sessions: [agent('child-lead', 'child')],
  })
  expect(screen.getByText('Pricing page draft')).toBeTruthy()
  expect(screen.getByLabelText('Loading transcript')).toBeTruthy()
  expect(screen.queryByText('Mission')).toBeNull()
})

it('names a remembered helper task before the mission deck resolves', async () => {
  navigation.holdOpening = true
  navigation.remembered = 'child-helper'
  navigation.params = { missionId: 'root' }
  await renderWithMobileStore(<MissionScreen />, {
    issues: [
      issue('root', { title: 'Cloud factory strategy' }),
      issue('child', { parentId: asIssueId('root'), title: 'Pricing page draft' }),
    ],
    sessions: [agent('child-helper', 'child')],
  })
  expect(screen.getByText('Pricing page draft')).toBeTruthy()
  expect(screen.queryByText('Cloud factory strategy')).toBeNull()
  expect(screen.getByLabelText('Loading transcript')).toBeTruthy()
})

it('opens the task coordinator chat, opens its highlighted deck from the menu, and pushes another seat', async () => {
  await renderWithMobileStore(<Navigator />, {
    issues: [
      issue('root', {
        title: 'Cloud factory strategy',
        coordinatorSessionId: asSessionId('root-lead'),
      }),
      issue('child', {
        parentId: asIssueId('root'),
        title: 'Pricing page draft',
        coordinatorSessionId: asSessionId('child-lead'),
      }),
      issue('proposal', {
        parentId: asIssueId('root'),
        stage: 'proposed',
        title: 'Usage-based add-on',
        seq: 3,
      }),
    ],
    sessions: [agent('root-lead', 'root'), agent('child-lead', 'child')],
  })
  await waitFor(() => expect(screen.getByTestId('chat').textContent).toBe('child-lead'))
  expect(navigation.state?.routes.map((route) => route.name)).toEqual([
    '(tabs)',
    MISSION_DECK,
    MISSION_CHAT,
  ])
  expect(screen.queryByTestId('mission-bar')).toBeNull()
  await act(async () => fireEvent.click(screen.getByLabelText('Mission actions')))
  await act(async () =>
    fireEvent.click(
      within(screen.getByTestId('mission-actions-sheet')).getByRole('button', {
        name: 'Flight deck',
      }),
    ),
  )
  await waitFor(() =>
    expect(screen.getByTestId('deck-agent').getAttribute('aria-label')).toContain(
      'child-lead, Working, open',
    ),
  )
  expect(getComputedStyle(screen.getByTestId('deck-agent')).backgroundColor).toBe(
    'rgba(111, 157, 255, 0.13)',
  )
  const capture = process.env.PODIUM_MOBILE_DECK_CAPTURE
  if (capture) {
    const css = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules, (rule) => rule.cssText))
      .join('\n')
    const fonts = [
      ['Geist_400Regular', 'geist/400Regular/Geist_400Regular.ttf'],
      ['Geist_600SemiBold', 'geist/600SemiBold/Geist_600SemiBold.ttf'],
      ['GeistMono_400Regular', 'geist-mono/400Regular/GeistMono_400Regular.ttf'],
    ]
      .map(
        ([name, path]) =>
          `@font-face{font-family:${name};src:url(data:font/ttf;base64,${readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/@expo-google-fonts', path ?? '')).toString('base64')})}`,
      )
      .join('\n')
    writeFileSync(
      capture,
      `<!doctype html><html><head><meta charset="utf-8"><title>Flight deck web layout</title><style>${fonts}\n${css}\nhtml,body{width:402px;height:874px;margin:0;background:#16171a}body{display:flex}body>div{display:flex;flex:1;min-width:0}</style></head><body>${document.body.innerHTML}</body></html>`,
    )
  }
  fireEvent.click(screen.getByTestId('deck-seat'))
  await waitFor(() => expect(screen.getByTestId('chat').textContent).toBe('root-lead'))
  await act(async () => fireEvent.click(screen.getByLabelText('Flight deck')))
  await waitFor(() =>
    expect(screen.getByTestId('deck-seat').getAttribute('aria-label')).toContain(
      'Coordinator, Working, open',
    ),
  )
  // The root coordinator is now the remembered workspace tab. A child task
  // tap must still open that child's own coordinator.
  await act(async () => fireEvent.click(screen.getByTestId('deck-task')))
  expect(navigation.push).toHaveBeenLastCalledWith('/mission/child?sessionId=child-lead')
  await waitFor(() => expect(screen.getByTestId('chat').textContent).toBe('child-lead'))
})

it('web keeps an explicit chat-to-deck URL push and returns to the selected conversation', async () => {
  navigation.platform = 'web'
  await renderWithMobileStore(<Navigator />, {
    issues: [
      issue('root', { coordinatorSessionId: asSessionId('root-lead') }),
      issue('child', {
        parentId: asIssueId('root'),
        coordinatorSessionId: asSessionId('child-lead'),
      }),
      issue('proposal', {
        parentId: asIssueId('root'),
        stage: 'proposed',
        title: 'Agent proposal',
      }),
    ],
    sessions: [agent('root-lead', 'root'), agent('child-lead', 'child')],
  })
  await waitFor(() => expect(screen.getByTestId('chat').textContent).toBe('child-lead'))
  expect(navigation.state?.routes.map((route) => route.name)).toEqual(['(tabs)', MISSION_CHAT])
  expect(screen.queryByTestId('mission-bar')).toBeNull()
  await act(async () => fireEvent.click(screen.getByLabelText('Mission actions')))
  await act(async () =>
    fireEvent.click(
      within(screen.getByTestId('mission-actions-sheet')).getByRole('button', {
        name: 'Flight deck',
      }),
    ),
  )
  expect(navigation.push).toHaveBeenCalledWith('/mission/root/details?sessionId=child-lead')
  await waitFor(() => expect(screen.getByTestId('deck-seat')).toBeTruthy())
  expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
  expect(navigation.state?.routes.map((route) => route.name)).toEqual([
    '(tabs)',
    MISSION_CHAT,
    MISSION_DECK,
  ])
  fireEvent.click(screen.getByTestId('deck-seat'))
  expect(navigation.dismissTo).toHaveBeenCalledWith('/mission/root?sessionId=root-lead')
  await waitFor(() => expect(screen.getByTestId('chat').textContent).toBe('root-lead'))
  expect(navigation.state?.routes.map((route) => route.name)).toEqual(['(tabs)', MISSION_CHAT])
  expect(screen.queryByTestId('mission-bar')).toBeNull()
  await act(async () => fireEvent.click(screen.getByLabelText('Mission actions')))
  await act(async () =>
    fireEvent.click(
      within(screen.getByTestId('mission-actions-sheet')).getByRole('button', {
        name: 'Flight deck',
      }),
    ),
  )
  await waitFor(() => expect(screen.getByTestId('deck-seat')).toBeTruthy())
  fireEvent.click(screen.getByLabelText('Screen proposals'))
  expect(navigation.replace).toHaveBeenCalledWith('/screen-proposed')
  fireEvent.click(screen.getByTestId('deck-task'))
  expect(navigation.replace).toHaveBeenCalledWith('/inspect/child')
})

it('keeps a remembered child helper when opening that task from the deck', async () => {
  await renderWithMobileStore(<Navigator />, {
    issues: [
      issue('root', { coordinatorSessionId: asSessionId('root-lead') }),
      issue('child', {
        parentId: asIssueId('root'),
        coordinatorSessionId: asSessionId('child-lead'),
      }),
    ],
    sessions: [
      agent('root-lead', 'root'),
      agent('child-lead', 'child'),
      agent('child-helper', 'child'),
    ],
  })
  await waitFor(() => expect(screen.getByTestId('chat').textContent).toBe('child-lead'))
  await act(async () => fireEvent.click(screen.getByLabelText('Flight deck')))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /^child-helper,/ })))
  await waitFor(() => expect(screen.getByTestId('chat').textContent).toBe('child-helper'))
  await act(async () => fireEvent.click(screen.getByLabelText('Flight deck')))
  await act(async () => fireEvent.click(screen.getByTestId('deck-task')))
  expect(navigation.push).toHaveBeenLastCalledWith('/mission/child?sessionId=child-helper')
  await waitFor(() => expect(screen.getByTestId('chat').textContent).toBe('child-helper'))
})

it('opens an unseated child task in details instead of its parent conversation', async () => {
  await renderWithMobileStore(<Navigator />, {
    issues: [
      issue('root', { coordinatorSessionId: asSessionId('root-lead') }),
      issue('child', { parentId: asIssueId('root') }),
    ],
    sessions: [agent('root-lead', 'root')],
  })
  await waitFor(() => expect(screen.getByTestId('chat').textContent).toBe('root-lead'))
  await act(async () => fireEvent.click(screen.getByLabelText('Flight deck')))
  await act(async () => fireEvent.click(screen.getByTestId('deck-task')))
  expect(navigation.push).toHaveBeenLastCalledWith('/issue/child')
})
