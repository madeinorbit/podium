import { useEffect, useState } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { login } from '../client/auth'
import { AsciiWordmark } from '../components/AsciiWordmark'
import { mono, monoLabel } from '../theme/theme'

/**
 * The web login screen (LoginGate spec 2b) ported 1:1 [POD-131]: ASCII
 * wordmark with the idle shimmer, mono host label, fused input bar with the
 * terracotta submit square, and the mono status line underneath. The screen
 * is intentionally THEME-INDEPENDENT — same fixed near-black tokens as the
 * web, not the Superade navy.
 */
const C = {
  bg: '#0a0a0e',
  bar: '#0e0e12',
  border: '#3a3a46',
  accent: '#D97757',
  accentText: '#2b1208',
  success: '#10b981',
  error: '#f43f5e',
  errorText: '#f87171',
  amber: '#f59e0b',
  text: '#f3f3f8',
  textDim: '#9a9aa8',
  textFaint: '#7a7a86',
  placeholder: '#5a5a66',
} as const

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

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
  onAuthed: () => void
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [ok, setOk] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [spinFrame, setSpinFrame] = useState(0)

  useEffect(() => {
    if (!busy) return
    const id = setInterval(() => setSpinFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(id)
  }, [busy])

  const submit = async () => {
    if (!password || busy || ok) return
    setBusy(true)
    setError(null)
    const failure = await login(httpOrigin, password).catch(
      () => "✗ couldn't reach the server — try again",
    )
    setBusy(false)
    if (failure) {
      setError(failure.startsWith('✗') ? failure : `✗ ${failure}`)
    } else {
      setOk(true)
      onAuthed()
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
            : C.amber
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
  const btnGlyph = state === 'busy' ? SPINNER_FRAMES[spinFrame] : state === 'ok' ? '✓' : '→'

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Log in"
          disabled={(!password && !ok) || busy}
          onPress={() => void submit()}
          style={[
            styles.submit,
            ok ? { backgroundColor: C.success } : null,
            { opacity: (password && !busy) || ok ? 1 : 0.45 },
          ]}
        >
          <Text style={styles.submitGlyph}>{btnGlyph}</Text>
        </Pressable>
      </View>
      <View style={styles.statusRow} accessibilityRole={error ? 'alert' : undefined}>
        {state !== 'busy' ? <View style={[styles.dot, { backgroundColor: statColor }]} /> : null}
        <Text style={[styles.status, { color: statColor }]}>{statText}</Text>
      </View>
    </KeyboardAvoidingView>
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
    ...monoLabel(9),
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
    fontSize: 16,
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
    fontSize: 11,
  },
})
