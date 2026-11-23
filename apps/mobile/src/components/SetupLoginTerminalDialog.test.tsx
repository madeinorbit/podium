import { asSessionId } from '@podium/model'
import type { SessionOpenUrlMessage } from '@podium/protocol'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Linking } from 'react-native'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (value: unknown) => void>(),
  forward: vi.fn(),
  dismiss: vi.fn(),
  copy: vi.fn(async () => true),
}))
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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  state.handlers.clear()
})

it('opens only this session’s requested link and copies and forwards its callback without losing the terminal', async () => {
  const open = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
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
  const view = render(<SetupLoginTerminalDialog sessionId={sessionId} />)
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
