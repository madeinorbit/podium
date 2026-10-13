import { type ReactNode, useContext } from 'react'
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaInsetsContext } from 'react-native-safe-area-context'
import { AsciiWordmark } from '../components/AsciiWordmark'
import { HostedSignInButton } from '../components/HostedSignInButton'
import { Icon } from '../components/Icon'
import { Activity, BellRing, Plus, QrCode } from '../components/icons'
import { PressableScale } from '../components/PressableScale'
import { color, font, radius, sans, space } from '../theme/theme'

export const WELCOME_TITLE = 'Welcome to Podium'

/**
 * The first screen a new phone sees once the splash fades: no server is saved
 * yet, so this is the whole onboarding. It follows the iOS welcome pattern —
 * identity and a short "what this is for" list up top, the choices anchored at
 * the bottom where the thumb already is — and explains the two ways in before
 * asking the user to pick one:
 *
 *   • Podium Cloud: sign in, nothing to run. The primary action.
 *   • Your own server: scan the code Podium shows on the computer, or type the
 *     address when there is no camera (or no code) at hand.
 *
 * Web has no hosted callback and no camera, so it keeps only the address path
 * and promotes it to the primary action.
 */
export function PairingWelcome({
  canCancel,
  error,
  onCancel,
  onHostedBegin,
  onScan,
  onManual,
}: {
  canCancel: boolean
  error: string | null
  onCancel(): void
  onHostedBegin(): void
  onScan(): void
  onManual(): void
}) {
  const native = Platform.OS !== 'web'
  // Explicit insets rather than `contentInsetAdjustmentBehavior`: the content
  // grows to fill the screen so the choices sit at the bottom, and automatic
  // insets are added ON TOP of that height, pushing the last line off-screen.
  // The context (not `useSafeAreaInsets`) so a missing provider costs the
  // inset, not the first screen a new user ever sees.
  const insets = useContext(SafeAreaInsetsContext)
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: (insets?.top ?? 0) + space.lg,
          paddingBottom: (insets?.bottom ?? 0) + space.lg,
        },
      ]}
    >
      {canCancel ? (
        <PressableScale
          style={styles.cancel}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Cancel server setup"
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </PressableScale>
      ) : null}

      <View style={styles.intro}>
        <View style={styles.wordmark} accessible accessibilityLabel="Podium">
          <AsciiWordmark color={color.text} fontSize={3.4} />
        </View>
        <View style={styles.heading}>
          <Text style={styles.title} accessibilityRole="header">
            {WELCOME_TITLE}
          </Text>
          <Text style={styles.subtitle}>
            Stay close to your coding agents, even when you are away from your desk.
          </Text>
        </View>
        <View style={styles.features}>
          <Feature
            icon={<Icon as={Activity} size={20} color={color.accent} />}
            title="Follow the work live"
            detail="See what every agent is doing, what is done, and what is stuck."
          />
          <Feature
            icon={<Icon as={BellRing} size={20} color={color.accent} />}
            title="Step in when it matters"
            detail="Answer questions and unblock an agent the moment it needs you."
          />
          <Feature
            icon={<Icon as={Plus} size={20} color={color.accent} />}
            title="Start tasks anywhere"
            detail="Capture an idea and hand it to an agent right from your phone."
          />
        </View>
      </View>

      <View style={styles.actions}>
        {native ? (
          <>
            <View style={styles.choice}>
              <HostedSignInButton variant="primary" onBegin={onHostedBegin} />
              <Text style={styles.caption}>Sign in with your account. Nothing to set up.</Text>
            </View>

            <View style={styles.divider} accessibilityRole="text">
              <View style={styles.rule} />
              <Text style={styles.dividerText}>or use your own server</Text>
              <View style={styles.rule} />
            </View>

            <PressableScale
              style={styles.secondary}
              onPress={onScan}
              accessibilityRole="button"
              accessibilityLabel="Scan pairing code"
            >
              <Icon as={QrCode} size={20} color={color.text} />
              <Text style={styles.secondaryText}>Scan pairing code</Text>
            </PressableScale>
            <PressableScale
              style={styles.link}
              onPress={onManual}
              accessibilityRole="button"
              accessibilityLabel="Enter server address"
            >
              <Text style={styles.linkText}>Enter server address</Text>
            </PressableScale>
            <Text style={styles.help}>
              In Podium on your computer, open Settings → Connected devices → Pair a phone.
            </Text>
          </>
        ) : (
          <>
            <PressableScale
              style={styles.primary}
              onPress={onManual}
              accessibilityRole="button"
              accessibilityLabel="Enter server address"
            >
              <Text style={styles.primaryText}>Enter server address</Text>
            </PressableScale>
            <Text style={styles.help}>
              Use the address of the Podium server you run, as this device can reach it.
            </Text>
          </>
        )}

        {error ? (
          <Text
            selectable
            style={styles.error}
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
          >
            {error}
          </Text>
        ) : null}
      </View>
    </ScrollView>
  )
}

function Feature({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <View style={styles.feature} accessible accessibilityLabel={`${title}. ${detail}`}>
      <View style={styles.featureIcon}>{icon}</View>
      <View style={styles.featureText}>
        <Text style={styles.featureTitle}>{title}</Text>
        <Text style={styles.featureDetail}>{detail}</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  content: {
    flexGrow: 1,
    justifyContent: 'space-between',
    gap: space.xl,
    paddingHorizontal: space.xl,
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  cancel: {
    alignSelf: 'flex-end',
    minHeight: 44,
    justifyContent: 'center',
    marginBottom: -space.xl,
  },
  cancelText: { color: color.accentTint, ...sans(600), fontSize: font.body },
  intro: { flexGrow: 1, justifyContent: 'center', gap: space.xl },
  wordmark: { alignItems: 'center' },
  heading: { gap: space.sm, alignItems: 'center' },
  title: { color: color.text, ...sans(700), fontSize: font.largeTitle, textAlign: 'center' },
  subtitle: {
    color: color.textDim,
    fontSize: font.body,
    lineHeight: 24,
    textAlign: 'center',
    maxWidth: 340,
  },
  features: { gap: space.lg, paddingTop: space.sm },
  feature: { flexDirection: 'row', alignItems: 'flex-start', gap: space.lg },
  featureIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    backgroundColor: color.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureText: { flex: 1, gap: 2 },
  featureTitle: { color: color.text, ...sans(600), fontSize: font.body },
  featureDetail: { color: color.textDim, fontSize: font.small, lineHeight: 20 },
  actions: { gap: space.sm },
  choice: { gap: space.xs },
  caption: { color: color.textFaint, fontSize: font.tiny, textAlign: 'center' },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.xs,
  },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: color.borderStrong },
  dividerText: { color: color.textFaint, fontSize: font.tiny },
  primary: {
    minHeight: 50,
    backgroundColor: color.accent,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  primaryText: { color: color.onAccent, ...sans(700), fontSize: font.body },
  secondary: {
    minHeight: 50,
    flexDirection: 'row',
    gap: space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  secondaryText: { color: color.text, ...sans(600), fontSize: font.body },
  link: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  linkText: { color: color.accentTint, ...sans(600), fontSize: font.body },
  help: { color: color.textFaint, fontSize: font.tiny, lineHeight: 18, textAlign: 'center' },
  error: { color: color.dangerText, fontSize: font.small, lineHeight: 20, textAlign: 'center' },
})
