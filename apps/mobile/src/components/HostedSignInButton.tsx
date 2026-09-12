import { useRef, useState } from 'react'
import { Platform, Text, View } from 'react-native'
import { hostedSignIn } from '../client/hosted-sign-in-runtime'
import { HOSTED_API_ORIGIN, HOSTED_SIGN_IN_URL } from '../client/hosted-sign-in'
import { PressableScale } from './PressableScale'
import { color, space } from '../theme/theme'
export function HostedSignInButton({
  server = HOSTED_API_ORIGIN,
  signInUrl = HOSTED_SIGN_IN_URL,
}: {
  server?: string
  signInUrl?: string
}) {
  const inFlight = useRef(false)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  if (Platform.OS === 'web') return null
  return (
    <View style={{ gap: space.sm }}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Continue with Podium Cloud"
        disabled={busy}
        style={{ padding: space.md, borderRadius: 8, backgroundColor: color.claude }}
        onPress={() => {
          if (inFlight.current) return
          inFlight.current = true
          setBusy(true)
          setStatus('Opening your browser…')
          void hostedSignIn
            .begin(server, signInUrl)
            .then(() => {
              setStatus('Finish signing in in your browser, then return to Podium.')
            })
            .catch(() => {
              setStatus('Could not start sign-in. Try again.')
            })
            .finally(() => {
              inFlight.current = false
              setBusy(false)
            })
        }}
      >
        <Text style={{ color: color.bg }}>Continue with Podium Cloud</Text>
      </PressableScale>
      {status ? (
        <Text accessibilityRole="alert" style={{ color: color.textDim }}>
          {status}
        </Text>
      ) : null}
    </View>
  )
}
