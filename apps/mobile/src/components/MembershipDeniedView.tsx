import { Text, View } from 'react-native'
import { color, font, sans, space } from '../theme/theme'
import { HostedSignInButton } from './HostedSignInButton'

/**
 * The account was recognised, but the workspace refused admission. Keep the
 * server's reason verbatim: it is the authority for the access decision and
 * must not turn into a misleading sign-in retry.
 */
export function MembershipDeniedView({
  reason,
  server,
  signInUrl,
  onBegin,
}: {
  reason: string
  server: string
  signInUrl?: string
  onBegin?(): void | Promise<void>
}) {
  return (
    <View style={styles.root} accessibilityLiveRegion="polite">
      <Text style={styles.eyebrow}>WORKSPACE ACCESS</Text>
      <Text style={styles.title}>Workspace access is missing</Text>
      <Text style={styles.reason} accessibilityRole="alert">
        {reason}
      </Text>
      <Text style={styles.body}>
        Use another Podium Cloud account, or accept an invitation to this workspace in your browser.
      </Text>
      <HostedSignInButton
        server={server}
        signInUrl={signInUrl}
        label="Use another account"
        onBegin={onBegin}
      />
      <Text style={styles.help}>
        Already have an invitation? Open its link in your browser, then return to Podium.
      </Text>
    </View>
  )
}

const styles = {
  root: {
    flex: 1,
    justifyContent: 'center' as const,
    alignSelf: 'center' as const,
    width: '100%' as const,
    maxWidth: 560,
    padding: space.xl,
    gap: space.lg,
  },
  eyebrow: {
    ...sans(600),
    color: color.textDim,
    fontSize: font.micro,
    letterSpacing: 1.2,
    textAlign: 'center' as const,
  },
  title: {
    ...sans(600),
    color: color.text,
    fontSize: font.title,
    textAlign: 'center' as const,
  },
  reason: {
    ...sans(500),
    color: color.dangerText,
    fontSize: font.body,
    textAlign: 'center' as const,
  },
  body: {
    ...sans(400),
    color: color.body,
    fontSize: font.small,
    lineHeight: 22,
    textAlign: 'center' as const,
  },
  help: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
    lineHeight: 18,
    textAlign: 'center' as const,
  },
}
