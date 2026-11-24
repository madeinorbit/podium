/** Native browser, clipboard and PTY boundaries for the phone sign-in screenshot. */

import type { SessionView } from '@podium/client-core/session-values'
import { fullDevice } from '@podium/client-graph/full-device-fixture'
import { loadSyncedModels } from '@podium/client-graph/models'
import { MobxPool } from '@podium/client-graph/pool'
import { asSessionId } from '@podium/model'
import type { SessionOpenUrlMessage } from '@podium/protocol'
import { Text, View } from 'react-native'
import { color, font, mono, space } from '../src/theme/theme'

await loadSyncedModels()
const pool = fullDevice(new MobxPool({ selectedIssueId: null, coarseNow: 0 }))
export function useMobilePool() {
  return pool
}
export function setLoginSession(
  status: SessionView['status'],
  exitCode?: number,
  spawnFailure?: string,
) {
  pool.apply({
    type: 'update',
    rows: [
      {
        kind: 'session',
        id: 'login-session',
        value: {
          sessionId: asSessionId('login-session'),
          agentKind: 'shell',
          status,
          exitCode,
          spawnFailure,
        } as never,
      },
    ],
  })
}
const mode = new URLSearchParams(window.location.search).get('state')
setLoginSession(
  mode === 'login-failed' || mode === 'login-ok' ? 'exited' : 'live',
  mode === 'login-failed' ? -1 : mode === 'login-ok' ? 0 : undefined,
  mode === 'login-failed' ? 'The sign-in command was refused.' : undefined,
)

const request: SessionOpenUrlMessage = {
  type: 'sessionOpenUrl',
  sessionId: asSessionId('login-session'),
  requestId: 'login-request',
  url: 'https://auth.example.com/authorize',
  intent: 'login',
  expiresAt: 4_102_444_800_000,
  callbackTarget: { host: 'localhost', port: 1455, path: '/callback' },
}
const hub = {
  on<T>(event: string, callback: (payload: T) => void) {
    const timer = event === 'openUrl' ? setTimeout(() => callback(request as T), 0) : undefined
    return () => {
      clearTimeout(timer)
    }
  },
  submitOpenUrlCallback() {},
  dismissOpenUrl() {},
}
export function useHub() {
  return hub
}
export function useConnected() {
  return true
}
export async function setStringAsync() {
  return true
}
export function TerminalPane() {
  return (
    <View style={{ flex: 1, padding: space.lg, backgroundColor: color.bg }}>
      <Text style={{ ...mono(), color: color.textDim, fontSize: font.tiny }}>
        Sign-in terminal{'\n'}Waiting for browser sign-in…
      </Text>
    </View>
  )
}
