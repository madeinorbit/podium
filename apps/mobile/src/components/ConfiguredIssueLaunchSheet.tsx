import type { IssueWire } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useMobileStore } from '../client/hooks'
import { startConfiguredIssue } from '../lib/configured-issue-launch'
import {
  type LaunchConfiguration,
  type LaunchPlan,
  launchConfigurationForIssue,
  launchPlanCanSubmit,
} from '../lib/launch-configuration'
import { color, font, radius, sans, space } from '../theme/theme'
import { BottomSheet } from './BottomSheet'
import { LaunchConfigurationFields } from './LaunchConfigurationFields'
import { PressableScale } from './PressableScale'

const DEFAULT_CONFIGURATION: LaunchConfiguration = {
  agentKind: 'claude-code',
  modelPick: 'auto',
  effort: 'auto',
  machineId: '',
}

export function ConfiguredIssueLaunchSheet({
  issue,
  onStarted,
  onClose,
}: {
  issue: IssueWire | null
  onStarted?: () => void
  onClose: () => void
}) {
  const store = useMobileStore()
  const [configuration, setConfiguration] = useState(() =>
    issue ? launchConfigurationForIssue(issue) : DEFAULT_CONFIGURATION,
  )
  const [plan, setPlan] = useState<LaunchPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (issue) setConfiguration(launchConfigurationForIssue(issue))
    setPlan(null)
    setBusy(false)
    setError(null)
  }, [issue])

  const start = async () => {
    if (!issue || !launchPlanCanSubmit(plan) || busy) return
    setBusy(true)
    setError(null)
    try {
      await startConfiguredIssue(store.trpc.issues, issue.id, plan)
      onClose()
      onStarted?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <BottomSheet
      visible={issue !== null}
      mode="fit"
      scrollable
      onClose={onClose}
      head={
        <View style={styles.head}>
          <Text style={styles.title} numberOfLines={2}>
            {issue ? `${issueDisplayRef(issue)} · ${issue.title}` : 'Start task'}
          </Text>
          <Text style={styles.subtitle}>Choose how and where this task starts.</Text>
        </View>
      }
      footerRule={false}
      footer={
        <View style={styles.footer}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            disabled={busy}
            onPress={onClose}
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryText}>Cancel</Text>
          </PressableScale>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Start agent"
            accessibilityState={{ disabled: busy || !launchPlanCanSubmit(plan) }}
            disabled={busy || !launchPlanCanSubmit(plan)}
            onPress={() => void start()}
            style={({ pressed }) => [styles.primary, (busy || pressed) && styles.pressed]}
          >
            <Text style={styles.primaryText}>{busy ? 'Starting…' : 'Start agent'}</Text>
          </PressableScale>
        </View>
      }
    >
      <View style={styles.body}>
        {issue ? (
          <LaunchConfigurationFields
            repoPath={issue.repoPath}
            value={configuration}
            onChange={(next) => {
              setPlan(null)
              setConfiguration(next)
            }}
            onPlan={setPlan}
          />
        ) : null}
        {error ? (
          <Text accessibilityLiveRegion="assertive" style={styles.error}>
            {error}
          </Text>
        ) : null}
      </View>
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  head: { gap: 3, paddingHorizontal: space.lg, paddingBottom: space.md },
  title: { ...sans(600), color: color.body, fontSize: font.small, textAlign: 'center' },
  subtitle: { ...sans(400), color: color.textFaint, fontSize: font.tiny, textAlign: 'center' },
  body: { paddingHorizontal: space.lg, paddingBottom: space.md },
  error: { ...sans(400), color: color.dangerText, fontSize: font.tiny, paddingTop: space.sm },
  footer: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
  },
  secondary: {
    minHeight: 48,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  primary: {
    minHeight: 48,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    backgroundColor: color.accent,
  },
  secondaryText: { ...sans(600), color: color.textDim, fontSize: font.small },
  primaryText: { ...sans(600), color: color.onAccent, fontSize: font.small },
  pressed: { opacity: 0.62 },
})
