import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { asIssueId, asSessionId } from '@podium/model'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { NavigationContext } from 'expo-router/build/react-navigation/core/NavigationContext'
import { NavigationRouteContext } from 'expo-router/build/react-navigation/core/NavigationProvider'
import { StackActions, StackRouter } from 'expo-router/build/react-navigation/routers/StackRouter'
import type { NavigationState } from 'expo-router/react-navigation'
import { type ReactNode, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'
import { MISSION_CHAT, MISSION_DECK } from '../navigation/mission-stack'

const navigation = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  state: null as NavigationState | null,
  back: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
}))
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
vi.mock('../components/ActionSheet', () => ({ ActionSheet: () => null }))
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
    return opened
  })
  navigation.state = state
  const route = state.routes[state.index]
  if (!route) throw new Error('Missing screen')
  navigation.params = route.params as Record<string, string>
  const dispatch = (action: Parameters<typeof stack.getStateForAction>[1]) => {
    setState((current) => stack.getStateForAction(current, action, options) ?? current)
  }
  navigation.back.mockImplementation(() => dispatch(StackActions.pop(1)))
  navigation.push.mockImplementation((url: string) => {
    const [path, query] = url.split('?')
    dispatch(
      StackActions.push(MISSION_CHAT, {
        missionId: path?.split('/')[2],
        ...Object.fromEntries(new URLSearchParams(query)),
      }),
    )
  })
  const owner = {
    getState: () => state,
    dispatch,
    isFocused: () => true,
    addListener: () => () => {},
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

it('opens the task coordinator chat, pops the mission strip to its highlighted deck, and pushes another seat', async () => {
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
  await act(async () => fireEvent.click(screen.getByTestId('mission-bar')))
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
})
