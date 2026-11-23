import { exitedRecovery } from '@podium/client-core/values'
import { here } from '@podium/client-graph/lookup'
import type { SessionId } from '@podium/model'
import type { SessionOpenUrlMessage } from '@podium/protocol'
import * as Clipboard from 'expo-clipboard'
import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { Linking, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useConnected, useHub } from '../client/hooks'
import { useMobilePool } from '../client/mobile-pool'
import { TerminalPane } from '../terminal/TerminalPane'
import { color, font, leading, radius, sans, space } from '../theme/theme'
import { PressableScale } from './PressableScale'

interface PendingBrowserRequest {
  request: SessionOpenUrlMessage
  callback: string
  submitting: boolean
  error?: string
}

/** Sign-in owns its browser requests while the existing phone terminal owns the PTY. */
export default observer(function SetupLoginTerminalDialog({
  sessionId,
  onClose,
  onRetry,
}: {
  sessionId: SessionId
  onClose: () => void
  onRetry?: () => void
}) {
  const hub = useHub()
  const connected = useConnected()
  const pool = useMobilePool()
  const session = pool ? here(pool.model('session', sessionId)) : undefined
  const exited = session?.status === 'exited'
  const succeeded = exited && session.exitCode === 0 && !session.spawnFailure
  const [pending, setPending] = useState<PendingBrowserRequest[]>([])
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (succeeded) onClose()
  }, [succeeded, onClose])
  useEffect(() => {
    if (exited) return
    // Attaching the terminal's session room replays parked requests. Ignore
    // browser requests from every other session the phone is looking at.
    const offOpen = hub.on('openUrl', (request) => {
      if (request.sessionId !== sessionId) return
      setPending((current) =>
        current.some((item) => item.request.requestId === request.requestId)
          ? current
          : [...current, { request, callback: '', submitting: false }],
      )
    })
    const offResult = hub.on('openUrlResult', (result) => {
      if (result.sessionId !== sessionId) return
      if (result.status === 'failed') {
        setPending((current) =>
          current.map((item) =>
            item.request.requestId === result.requestId
              ? {
                  ...item,
                  submitting: false,
                  error: result.error ?? 'The callback could not be forwarded.',
                }
              : item,
          ),
        )
      } else {
        setPending((current) =>
          current.filter((item) => item.request.requestId !== result.requestId),
        )
        if (result.status === 'completed')
          setNotice('Sign-in callback forwarded. Finish in the terminal, then tap Done.')
      }
    })
    return () => {
      offOpen()
      offResult()
    }
  }, [hub, sessionId, exited])

  const update = (requestId: string, patch: Partial<Omit<PendingBrowserRequest, 'request'>>) => {
    setPending((current) =>
      current.map((item) => (item.request.requestId === requestId ? { ...item, ...patch } : item)),
    )
  }
  const open = async (item: PendingBrowserRequest) => {
    update(item.request.requestId, { error: undefined })
    try {
      await Linking.openURL(item.request.url)
      const login = item.request.intent
        ? item.request.intent === 'login'
        : !!item.request.callbackTarget
      if (!login) hub.dismissOpenUrl(sessionId, item.request.requestId)
    } catch (cause) {
      update(item.request.requestId, {
        error: cause instanceof Error ? cause.message : 'Could not open the login page.',
      })
    }
  }
  const copy = async (item: PendingBrowserRequest) => {
    try {
      const copied = await Clipboard.setStringAsync(item.request.url)
      if (!copied) throw new Error('Could not copy the link.')
      setNotice('Sign-in link copied.')
    } catch {
      update(item.request.requestId, { error: 'Could not copy the link.' })
    }
  }
  const forward = (item: PendingBrowserRequest) => {
    if (!connected || item.submitting || !item.callback.trim()) return
    update(item.request.requestId, { submitting: true, error: undefined })
    hub.submitOpenUrlCallback(sessionId, item.request.requestId, item.callback.trim())
  }

  if (succeeded) return null
  if (exited) {
    const { detail } = exitedRecovery({
      exitCode: session.exitCode,
      spawnFailure: session.spawnFailure,
      isShell: true,
      resumable: false,
    })
    return (
      <ScrollView style={styles.page} contentContainerStyle={styles.ended}>
        <Text accessibilityRole="header" style={styles.title}>
          Sign-in stopped
        </Text>
        <Text accessibilityRole="alert" style={styles.error}>
          {detail}
        </Text>
        <Text style={styles.caption}>
          {onRetry
            ? 'Try signing in again, or close to return to setup.'
            : 'Close to return to setup and sign in again when the machine is available.'}
        </Text>
        <View style={styles.recovery}>
          {onRetry ? (
            <LoginAction label="Try again" onPress={onRetry} disabled={!connected} />
          ) : null}
          <LoginAction label="Close" onPress={onClose} />
        </View>
        {onRetry && !connected ? <Text style={styles.caption}>Reconnect to try again.</Text> : null}
      </ScrollView>
    )
  }

  return (
    <View style={styles.page}>
      {pending.length > 0 ? (
        <ScrollView
          style={styles.requests}
          contentContainerStyle={styles.requestContent}
          keyboardShouldPersistTaps="handled"
        >
          {pending.map((item) => (
            <View key={item.request.requestId} style={styles.request}>
              <Text style={styles.title}>Agent sign-in · {new URL(item.request.url).host}</Text>
              <LoginAction
                label="Open login page"
                onPress={() => {
                  void open(item)
                }}
              />
              <LoginAction
                label="Copy sign-in link"
                onPress={() => {
                  void copy(item)
                }}
              />
              {item.request.callbackTarget ? (
                <>
                  <Text style={styles.caption}>
                    After sign-in, copy the URL when your browser reaches localhost:
                    {item.request.callbackTarget.port}
                    {item.request.callbackTarget.path} and paste it here.
                  </Text>
                  <TextInput
                    accessibilityLabel="Localhost callback URL"
                    value={item.callback}
                    onChangeText={(callback) =>
                      update(item.request.requestId, { callback, error: undefined })
                    }
                    onSubmitEditing={() => forward(item)}
                    placeholder={`http://localhost:${item.request.callbackTarget.port}${item.request.callbackTarget.path}?code=…`}
                    placeholderTextColor={color.textMicro}
                    autoCapitalize="none"
                    autoCorrect={false}
                    inputMode="url"
                    returnKeyType="go"
                    style={styles.input}
                  />
                  <LoginAction
                    label={item.submitting ? 'Forwarding callback…' : 'Forward callback'}
                    disabled={!connected || item.submitting || !item.callback.trim()}
                    onPress={() => forward(item)}
                  />
                  {!connected ? (
                    <Text style={styles.caption}>Reconnect to forward the callback.</Text>
                  ) : null}
                </>
              ) : null}
              {item.error ? (
                <Text accessibilityRole="alert" style={styles.error}>
                  {item.error}
                </Text>
              ) : null}
              <LoginAction
                label="Dismiss browser request"
                onPress={() => hub.dismissOpenUrl(sessionId, item.request.requestId)}
              />
            </View>
          ))}
        </ScrollView>
      ) : null}
      <Text accessibilityLiveRegion="polite" style={styles.note}>
        {notice || 'Complete sign-in here, then tap Done to return to setup.'}
      </Text>
      <TerminalPane key={sessionId} sessionId={sessionId} active />
    </View>
  )
})

function LoginAction({
  label,
  onPress,
  disabled,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.action, disabled && styles.disabled]}
    >
      <Text style={styles.link}>{label}</Text>
    </PressableScale>
  )
}
const styles = StyleSheet.create({
  page: { flex: 1, minHeight: 0, backgroundColor: color.bg },
  ended: { flexGrow: 1, justifyContent: 'center', padding: space.lg, gap: space.md },
  recovery: { flexDirection: 'row', gap: space.xl },
  requests: { maxHeight: '65%', flexShrink: 1 },
  requestContent: { padding: space.md, gap: space.md },
  request: {
    padding: space.md,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
    gap: space.xs,
  },
  title: { ...sans(600), color: color.text, fontSize: font.small },
  note: { ...sans(), fontSize: font.tiny, color: color.textDim, padding: space.md },
  caption: { ...sans(), fontSize: font.tiny, lineHeight: leading(font.tiny), color: color.textDim },
  input: {
    ...sans(),
    minHeight: 48,
    color: color.text,
    fontSize: font.body,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.borderStrong,
    padding: space.sm,
    marginTop: space.sm,
  },
  action: { minHeight: 44, justifyContent: 'center' },
  link: { ...sans(), fontSize: font.small, color: color.accentTint },
  disabled: { opacity: 0.4 },
  error: { ...sans(), fontSize: font.tiny, color: color.dangerText },
})
