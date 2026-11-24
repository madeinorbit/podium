import type { SessionView } from '@podium/client-core/session-values'
import { loadSyncedModels } from '@podium/client-graph/models'
import { MobxPool } from '@podium/client-graph/pool'
import { asSessionId } from '@podium/model'
import type { SessionOpenUrlMessage } from '@podium/protocol'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Linking } from 'react-native'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (value: unknown) => void>(),
  forward: vi.fn(),
  dismiss: vi.fn(),
  copy: vi.fn(async () => true),
  pool: null as MobxPool | null,
}))
vi.mock('../client/mobile-pool', () => ({ useMobilePool: () => state.pool }))
vi.mock('../client/hooks', () => ({
  useConnected: () => true,
  useHub: () => hub,
}))
const hub = {
  on: (event: string, callback: (value: unknown) => void) => {
    state.handlers.set(event, callback)
    return () => {
      state.handlers.delete(event)
    }
  },
  submitOpenUrlCallback: state.forward,
  dismissOpenUrl: state.dismiss,
}
vi.mock('expo-clipboard', () => ({ setStringAsync: state.copy }))
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: async () => {},
}))
vi.mock('../terminal/TerminalPane', () => ({ TerminalPane: () => <div>Sign-in terminal</div> }))

import SetupLoginTerminalDialog from './SetupLoginTerminalDialog'

const sessionId = asSessionId('login-session')
const request: SessionOpenUrlMessage = {
  type: 'sessionOpenUrl',
  sessionId,
  requestId: 'request',
  intent: 'login',
  url: 'https://auth.example.com/authorize',
  callbackTarget: { host: 'localhost', port: 1455, path: '/callback' },
  expiresAt: 4_102_444_800_000,
}
function publishSession(
  patch: Partial<Pick<SessionView, 'status' | 'exitCode' | 'spawnFailure'>> = {},
) {
  if (!state.pool) throw new Error('The session pool is not mounted.')
  state.pool.apply({
    type: 'update',
    rows: [
      {
        kind: 'session',
        id: sessionId,
        value: { sessionId, agentKind: 'shell', status: 'live', ...patch } as never,
      },
    ],
  })
}
beforeAll(() => loadSyncedModels())
beforeEach(() => {
  state.pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  publishSession()
})
afterEach(() => {
  cleanup()
  state.pool?.dispose()
  state.pool = null
  vi.restoreAllMocks()
  vi.clearAllMocks()
  state.handlers.clear()
})

it('opens only this session’s requested link and copies and forwards its callback without losing the terminal', async () => {
  const open = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  const view = render(<SetupLoginTerminalDialog sessionId={sessionId} onClose={vi.fn()} />)
  act(() =>
    state.handlers.get('openUrl')?.({ ...request, sessionId: asSessionId('other-session') }),
  )
  expect(screen.queryByRole('button', { name: 'Open login page' })).toBeNull()
  act(() => state.handlers.get('openUrl')?.(request))
  expect(open).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open login page' })))
  expect(open).toHaveBeenCalledWith(request.url)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy sign-in link' })))
  expect(state.copy).toHaveBeenCalledWith(request.url)
  const callback = 'http://localhost:1455/callback?code=example'
  fireEvent.change(screen.getByLabelText('Localhost callback URL'), { target: { value: callback } })
  fireEvent.click(screen.getByRole('button', { name: 'Forward callback' }))
  expect(state.forward).toHaveBeenCalledWith(sessionId, request.requestId, callback)
  act(() =>
    state.handlers.get('openUrlResult')?.({
      sessionId,
      requestId: request.requestId,
      status: 'failed',
      error: 'Callback was rejected',
    }),
  )
  expect(screen.getByRole('alert').textContent).toBe('Callback was rejected')
  fireEvent.click(screen.getByRole('button', { name: 'Forward callback' }))
  act(() =>
    state.handlers.get('openUrlResult')?.({
      sessionId,
      requestId: request.requestId,
      status: 'completed',
    }),
  )
  expect(screen.queryByLabelText('Localhost callback URL')).toBeNull()
  expect(screen.getByText('Sign-in terminal')).toBeTruthy()
  act(() => state.handlers.get('openUrl')?.({ ...request, requestId: 'next-request' }))
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss browser request' }))
  expect(state.dismiss).toHaveBeenCalledWith(sessionId, 'next-request')
  view.unmount()
  expect(state.handlers.size).toBe(0)
})

it.each([
  {
    exitCode: -1,
    spawnFailure: 'The sign-in command was refused.',
    detail: 'The shell failed to start: The sign-in command was refused.',
    alreadyExited: true,
  },
  { exitCode: -1, detail: 'The shell failed to start.', alreadyExited: false },
  { exitCode: 1, detail: 'The shell exited with code 1.', alreadyExited: false },
  { exitCode: undefined, detail: 'The shell is no longer running.', alreadyExited: false },
])('explains exit $exitCode and offers recovery (already exited: $alreadyExited)', ({
  exitCode,
  spawnFailure,
  detail,
  alreadyExited,
}) => {
  const onClose = vi.fn()
  const onRetry = vi.fn()
  if (alreadyExited) publishSession({ status: 'exited', exitCode, spawnFailure })
  render(<SetupLoginTerminalDialog sessionId={sessionId} onClose={onClose} onRetry={onRetry} />)
  if (!alreadyExited) {
    act(() => state.handlers.get('openUrl')?.(request))
    expect(screen.getByRole('button', { name: 'Open login page' })).toBeTruthy()
    act(() => publishSession({ status: 'exited', exitCode, spawnFailure }))
  }
  expect(screen.getByRole('alert').textContent).toBe(detail)
  expect(screen.queryByText('Sign-in terminal')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Open login page' })).toBeNull()
  expect(screen.queryByText(/tap Done/)).toBeNull()
  expect(state.handlers.size).toBe(0)
  expect(onClose).not.toHaveBeenCalled()
  expect(onRetry).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(onRetry).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(onClose).toHaveBeenCalledOnce()
})

it.each([
  false,
  true,
])('closes a successful login without retrying (already exited: %s)', (alreadyExited) => {
  const onClose = vi.fn()
  const onRetry = vi.fn()
  if (alreadyExited) publishSession({ status: 'exited', exitCode: 0 })
  render(<SetupLoginTerminalDialog sessionId={sessionId} onClose={onClose} onRetry={onRetry} />)
  if (!alreadyExited) {
    expect(onClose).not.toHaveBeenCalled()
    act(() => state.handlers.get('openUrl')?.(request))
    act(() => publishSession({ status: 'exited', exitCode: 0 }))
  }
  expect(onClose).toHaveBeenCalledOnce()
  expect(onRetry).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByText('Sign-in terminal')).toBeNull()
  expect(state.handlers.size).toBe(0)
})
