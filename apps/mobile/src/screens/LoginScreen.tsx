import { useRef, useState } from 'react'
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native'
import { login, logout } from '../client/auth'
import { useServerProfile } from '../client/ServerProfileGate'
import { AsciiWordmark } from '../components/AsciiWordmark'
import { KeyboardAvoidingRoot } from '../components/KeyboardAvoidingRoot'
import { PressableScale } from '../components/PressableScale'
import { WorkingMark } from '../components/WorkingMark'
import { color, font, mono, monoLabel } from '../theme/theme'

/**
 * The web login screen (LoginGate spec 2b) ported 1:1 [POD-131]: ASCII
 * static wordmark, mono host label, fused input bar with the
 * terracotta submit square, and the mono status line underneath. The screen
 * keeps the product's ASCII identity while structural colors follow the active
 * iOS appearance before authentication just as they do after it.
 */
const C = {
  bg: color.bg,
  bar: color.surface,
  border: color.borderStrong,
  accent: color.claude,
  accentText: '#2b1208',
  success: color.successText,
  successFill: color.success,
  error: color.danger,
  errorText: color.dangerText,
  waiting: color.needsYouText,
  text: color.text,
  textDim: color.textDim,
  textFaint: color.textFaint,
  placeholder: color.textMicro,
} as const

type LoginState = 'empty' | 'typing' | 'busy' | 'error' | 'ok'

function originHost(httpOrigin: string): string {
  try {
    return new URL(httpOrigin).host
  } catch {
    return httpOrigin
  }
}

export function LoginScreen({
  httpOrigin,
  onAuthed,
}: {
  httpOrigin: string
  onAuthed: (bearer: string | null) => void | Promise<void>
}) {
  const { profile } = useServerProfile()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [ok, setOk] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitInFlight = useRef(false)

  const submit = async () => {
    if (!password || submitInFlight.current || ok) return
    submitInFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await login(httpOrigin, password, {
        id: profile.id,
        name: profile.name,
      }).catch(() => ({
        ok: false as const,
        error: "couldn't reach the server — try again",
      }))
      if (!result.ok) {
        setError(result.error.startsWith('✗') ? result.error : `✗ ${result.error}`)
        return
      }
      try {
        await onAuthed(result.bearer)
        setOk(true)
      } catch (cause) {
        const revoked = result.bearer
          ? await logout(httpOrigin, result.bearer)
              .then(() => true)
              .catch(() => false)
          : true
        const detail = cause instanceof Error ? cause.message : String(cause)
        setError(
          revoked
            ? `✗ Could not save this session: ${detail}`
            : `✗ Session storage and remote revocation failed. Revoke this phone from Settings → Connected devices: ${detail}`,
        )
      }
    } finally {
      setBusy(false)
      submitInFlight.current = false
    }
  }

  const state: LoginState = ok
    ? 'ok'
    : busy
      ? 'busy'
      : error
        ? 'error'
        : password
          ? 'typing'
          : 'empty'
  const statColor =
    state === 'ok'
      ? C.success
      : state === 'error'
        ? C.errorText
        : state === 'busy'
          ? '#34d399'
          : state === 'typing'
            ? C.textDim
            : C.waiting
  const statText =
    state === 'ok'
      ? '✓ signed in — welcome back'
      : state === 'error'
        ? (error ?? '')
        : state === 'busy'
          ? 'verifying…'
          : state === 'typing'
            ? 'press ⏎ to sign in'
            : 'waiting on you — enter your password'
  const btnGlyph = state === 'ok' ? '✓' : '→'

  return (
    <KeyboardAvoidingRoot
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      automaticOffset
    >
      <AsciiWordmark color={ok ? C.success : C.text} fontSize={3.9} />
      <Text style={styles.host}>{`Sign in to ${originHost(httpOrigin)}`.toUpperCase()}</Text>
      <View style={[styles.form, error ? styles.formError : null]}>
        <TextInput
          accessibilityLabel="Password"
          style={styles.input}
          value={password}
          onChangeText={(v) => {
            setPassword(v)
            if (error) setError(null)
          }}
          placeholder="Password"
          placeholderTextColor={C.placeholder}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={() => void submit()}
        />
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Log in"
          disabled={(!password && !ok) || busy}
          onPress={() => void submit()}
          style={[
            styles.submit,
            ok ? { backgroundColor: C.successFill } : null,
            { opacity: (password && !busy) || ok ? 1 : 0.45 },
          ]}
        >
          {state === 'busy' ? (
            <WorkingMark size={16} tint={C.accentText} label={null} />
          ) : (
            <Text style={styles.submitGlyph}>{btnGlyph}</Text>
          )}
        </PressableScale>
      </View>
      <View style={styles.statusRow} accessibilityRole={error ? 'alert' : undefined}>
        {state !== 'busy' ? <View style={[styles.dot, { backgroundColor: statColor }]} /> : null}
        <Text style={[styles.status, { color: statColor }]}>{statText}</Text>
      </View>
    </KeyboardAvoidingRoot>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
    padding: 24,
  },
  host: {
    ...monoLabel(),
    letterSpacing: 1.4,
    color: C.textFaint,
  },
  form: {
    width: '100%',
    maxWidth: 520,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 13,
    backgroundColor: C.bar,
    paddingVertical: 6,
    paddingRight: 6,
    paddingLeft: 18,
  },
  formError: {
    borderColor: C.error,
  },
  input: {
    flex: 1,
    minWidth: 0,
    ...mono(400),
    fontSize: font.body,
    letterSpacing: 1,
    color: C.text,
    paddingVertical: 8,
  },
  submit: {
    width: 42,
    height: 42,
    borderRadius: 9,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitGlyph: {
    ...mono(600),
    color: C.accentText,
    fontSize: 16,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    minHeight: 20,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 99,
  },
  status: {
    ...mono(400),
    fontSize: font.tiny,
  },
})
