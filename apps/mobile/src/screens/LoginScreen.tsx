import { useState } from 'react'
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
import { color, font, radius, sans, space } from '../theme/theme'

export function LoginScreen({
  httpOrigin,
  onAuthed,
}: {
  httpOrigin: string
  onAuthed: () => void
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!password || busy) return
    setBusy(true)
    setError(null)
    const failure = await login(httpOrigin, password).catch(() => 'Could not reach the server.')
    setBusy(false)
    if (failure) setError(failure)
    else onAuthed()
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.card}>
        <Text style={styles.title}>Podium</Text>
        <Text style={styles.subtitle}>{httpOrigin}</Text>
        <TextInput
          accessibilityLabel="Password"
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          placeholderTextColor={color.textFaint}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={() => void submit()}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Log in"
          disabled={!password || busy}
          onPress={() => void submit()}
          style={[styles.button, (!password || busy) && styles.buttonDisabled]}
        >
          <Text style={styles.buttonText}>{busy ? 'Logging in…' : 'Log in'}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    gap: space.md,
  },
  title: {
    color: color.text,
    fontSize: 28,
    ...sans(700),
    textAlign: 'center',
  },
  subtitle: {
    color: color.textFaint,
    fontSize: font.small,
    textAlign: 'center',
    marginBottom: space.md,
  },
  input: {
    color: color.text,
    fontSize: font.body,
    backgroundColor: color.bgSunken,
    borderColor: color.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  error: {
    color: color.danger,
    fontSize: font.small,
    textAlign: 'center',
  },
  button: {
    backgroundColor: color.accent,
    borderRadius: radius.sm,
    alignItems: 'center',
    paddingVertical: space.md,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    color: color.accentText,
    fontSize: font.body,
    ...sans(700),
  },
})
