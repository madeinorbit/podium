import type { AgentSetupView } from '@podium/client-graph/agent-setup-view'
import { observer } from 'mobx-react-lite'
import { type ReactNode, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { color, font, leading, mono, radius, sans, space } from '../theme/theme'
import { AgentSetupContent } from './AgentSetupPanel'
import { PressableScale } from './PressableScale'

/** The phone setup panel, embedded before the first work screen. */
export const AgentSetupOnboarding = observer(function AgentSetupOnboarding({
  view,
  onContinue,
  loginTerminal,
  onCloseLogin,
}: {
  view: AgentSetupView
  onContinue: () => Promise<void>
  loginTerminal?: ReactNode
  onCloseLogin?: () => void
}) {
  const insets = useSafeAreaInsets()
  const [continuing, setContinuing] = useState(false)
  const [installRequested, setInstallRequested] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = view.items.some((item) => item.readyToStart)
  const continueSetup = async (install: boolean) => {
    if (continuing) return
    setContinuing(true)
    setError(null)
    if (install && !installRequested) {
      view.installSelected()
      setInstallRequested(true)
    }
    try {
      await onContinue()
    } catch {
      setError('Could not save your setup. Try continuing again.')
      setContinuing(false)
    }
  }
  return (
    <View style={styles.root} testID="agent-setup-onboarding">
      <View style={styles.page}>
        <View style={[styles.heading, { paddingTop: Math.max(58, insets.top + space.lg) }]}>
          <Text style={styles.eyebrow}>Set up Podium · 2 of 3</Text>
          <Text accessibilityRole="header" style={styles.title}>
            {loginTerminal ? 'Finish agent sign-in' : 'Set up your agents'}
          </Text>
          <Text style={styles.intro}>
            Podium installs its own copy of each agent you pick on {view.machineName}.
          </Text>
          {loginTerminal || view.detail ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Back to agents"
              onPress={() => {
                if (loginTerminal) onCloseLogin?.()
                else view.closeDetail()
              }}
              style={styles.back}
            >
              <Text style={styles.link}>‹ Back to agents</Text>
            </PressableScale>
          ) : null}
        </View>
        {loginTerminal ? (
          <View style={styles.terminal}>{loginTerminal}</View>
        ) : (
          <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            <AgentSetupContent view={view} />
          </ScrollView>
        )}
        <View style={[styles.footer, { paddingBottom: Math.max(34, insets.bottom) }]}>
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={
              installRequested ? 'Continue' : `Install ${view.selectedKinds.length} and continue`
            }
            accessibilityState={{
              disabled: continuing || (!installRequested && !view.canInstallSelected),
            }}
            disabled={continuing || (!installRequested && !view.canInstallSelected)}
            onPress={() => void continueSetup(true)}
            style={[
              styles.primary,
              (continuing || (!installRequested && !view.canInstallSelected)) && styles.disabled,
            ]}
          >
            <Text style={styles.primaryText}>
              {installRequested ? 'Continue' : `Install ${view.selectedKinds.length} and continue`}
            </Text>
          </PressableScale>
          {ready ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Continue without installing"
              accessibilityState={{ disabled: continuing }}
              disabled={continuing}
              onPress={() => void continueSetup(false)}
              style={styles.secondary}
            >
              <Text style={styles.link}>Continue without installing</Text>
            </PressableScale>
          ) : null}
        </View>
      </View>
    </View>
  )
})

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, backgroundColor: color.bgSunken },
  page: { flex: 1, minHeight: 0, width: '100%', maxWidth: 560, alignSelf: 'center' },
  heading: { paddingHorizontal: 20, paddingBottom: space.xl, gap: space.sm },
  eyebrow: {
    ...mono(500),
    fontSize: 10,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: color.accentTint,
  },
  title: { ...sans(600), fontSize: 30, lineHeight: 34, letterSpacing: -0.6, color: color.text },
  intro: { ...sans(), fontSize: font.small, lineHeight: leading(font.small), color: color.textDim },
  back: { minHeight: 44, justifyContent: 'center' },
  link: { ...sans(500), fontSize: font.small, color: color.accentTint },
  scroll: { flex: 1, minHeight: 0 },
  content: { paddingHorizontal: space.lg, paddingBottom: space.lg },
  terminal: { flex: 1, minHeight: 0 },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: 14,
    gap: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  primary: {
    minHeight: 50,
    borderRadius: radius.xl,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { ...sans(600), fontSize: font.body, color: color.onAccent },
  secondary: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.4 },
  error: { ...sans(), fontSize: font.small, color: color.dangerText },
})
