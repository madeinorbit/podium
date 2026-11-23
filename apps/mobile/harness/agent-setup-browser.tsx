/** Native browser, clipboard and PTY boundaries for the phone sign-in screenshot. */
import { asSessionId } from '@podium/model'
import type { SessionOpenUrlMessage } from '@podium/protocol'
import { Text, View } from 'react-native'
import { color, font, mono, space } from '../src/theme/theme'

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
