import { useRef, useState } from 'react'
import { Platform, Text, View } from 'react-native'
import { hostedBrowserSignInUrl } from '../client/hosted-browser-sign-in'
import { HOSTED_API_ORIGIN, HOSTED_SIGN_IN_URL } from '../client/hosted-sign-in'
import { hostedSignIn } from '../client/hosted-sign-in-runtime'
import { color, space } from '../theme/theme'
import { PressableScale } from './PressableScale'
export function HostedSignInButton({
  server = HOSTED_API_ORIGIN,
  signInUrl = HOSTED_SIGN_IN_URL,
  workspaceId,
  label = 'Continue with Podium Cloud',
  onBegin,
}: {
  server?: string
  workspaceId?: string
  signInUrl?: string
  label?: string
  onBegin?(): void | Promise<void>
}) {
  const inFlight = useRef(false)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <View style={{ gap: space.sm }}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={busy}
        style={{ padding: space.md, borderRadius: 8, backgroundColor: color.claude }}
        onPress={() => {
          if (Platform.OS === 'web' && !onBegin) {
            try {
              window.location.assign(hostedBrowserSignInUrl(signInUrl, window.location.href))
            } catch {
              setStatus('Could not start sign-in. Try again.')
            }
            return
          }
          const begin = async () => {
            if (Platform.OS === 'web') {
              if (inFlight.current) return
              inFlight.current = true
              setBusy(true)
              try {
                await onBegin?.()
                window.location.assign(hostedBrowserSignInUrl(signInUrl, window.location.href))
              } catch {
                setStatus('Could not start sign-in. Try again.')
              } finally {
                inFlight.current = false
                setBusy(false)
              }
              return
            }
            if (inFlight.current) return
            inFlight.current = true
            setBusy(true)
            try {
              await onBegin?.()
              await hostedSignIn.begin(server, signInUrl, workspaceId)
              setStatus('Finish signing in in your browser, then return to Podium.')
            } catch {
              setStatus('Could not start sign-in. Try again.')
            } finally {
              inFlight.current = false
              setBusy(false)
            }
          }
          void begin()
        }}
      >
        <Text style={{ color: color.bg }}>{label}</Text>
      </PressableScale>
      {status ? (
        <Text accessibilityRole="alert" style={{ color: color.textDim }}>
          {status}
        </Text>
      ) : null}
    </View>
  )
}
