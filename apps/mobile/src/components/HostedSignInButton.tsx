import { useRef, useState } from 'react'
import { Platform, Text, View } from 'react-native'
import { hostedBrowserSignInUrl } from '../client/hosted-browser-sign-in'
import { hostedSignIn } from '../client/hosted-sign-in-runtime'
import { HOSTED_API_ORIGIN, HOSTED_SIGN_IN_URL } from '../client/hosted-sign-in'
import { PressableScale } from './PressableScale'
import { color, space } from '../theme/theme'
export function HostedSignInButton({
  server = HOSTED_API_ORIGIN,
  signInUrl = HOSTED_SIGN_IN_URL,
  onBegin,
}: {
  server?: string
  signInUrl?: string
  onBegin?(): void
}) {
  const inFlight = useRef(false)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <View style={{ gap: space.sm }}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Continue with Podium Cloud"
        disabled={busy}
        style={{ padding: space.md, borderRadius: 8, backgroundColor: color.claude }}
        onPress={() => {
          if (Platform.OS === 'web') {
            try {
              window.location.assign(hostedBrowserSignInUrl(signInUrl, window.location.href))
            } catch {
              setStatus('Could not start sign-in. Try again.')
            }
            return
          }
          if (inFlight.current) return
          onBegin?.()
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
