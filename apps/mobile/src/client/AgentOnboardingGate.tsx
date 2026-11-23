import { demoEnabled } from '@podium/client-core/demo'
import { here } from '@podium/client-graph/lookup'
import { observer } from 'mobx-react-lite'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { PhoneAgentSetupSheet } from '../components/AgentSetupSheet'
import { PressableScale } from '../components/PressableScale'
import { color, font, sans, space } from '../theme/theme'
import { useMobilePool } from './mobile-pool'
import { useOptionalServerProfile } from './server-profile-context'
import { finishProfileAgentSetup, profileAgentSetupFinished } from './server-profiles'
import { useAgentSetupPicker } from './use-agent-setup-picker'

/** After pairing, authentication and cold sync; before any work route mounts. */
export const AgentOnboardingGate = observer(function AgentOnboardingGate({
  children,
}: {
  children: ReactNode
}) {
  const context = useOptionalServerProfile()
  if (!context || context.isEphemeralOverride || demoEnabled()) return children
  return (
    <ProfileAgentOnboarding key={context.profile.id} profileId={context.profile.id}>
      {children}
    </ProfileAgentOnboarding>
  )
})

const ProfileAgentOnboarding = observer(function ProfileAgentOnboarding({
  profileId,
  children,
}: {
  profileId: string
  children: ReactNode
}) {
  const [status, setStatus] = useState<'loading' | 'pending' | 'finished'>('loading')
  // Stored on this opening: a newly ready harness must not dismiss the step under a person.
  const [machineId, setMachineId] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const finish = useCallback(
    async (outcome: 'completed' | 'skipped') => {
      await finishProfileAgentSetup(profileId, outcome)
      setStatus('finished')
    },
    [profileId],
  )
  const skip = useCallback(() => finish('skipped'), [finish])
  const fail = useCallback(() => setError(true), [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: A retry reopens the same profile's durable decision.
  useEffect(() => {
    let alive = true
    setError(false)
    void profileAgentSetupFinished(profileId).then(
      (finished) => {
        if (alive) setStatus(finished ? 'finished' : 'pending')
      },
      () => {
        if (alive) setError(true)
      },
    )
    return () => {
      alive = false
    }
  }, [profileId, attempt])

  if (status === 'finished') return children
  if (machineId) {
    return (
      <PhoneAgentSetupSheet
        machineId={machineId}
        origin="onboarding"
        onClose={() => {}}
        onContinue={() => finish('completed')}
      />
    )
  }
  if (status === 'pending' && !error) {
    return <AgentOnboardingDecision onSelect={setMachineId} onSkip={skip} onError={fail} />
  }
  return (
    <View style={styles.waiting}>
      {error ? (
        <>
          <Text accessibilityRole="alert" style={styles.message}>
            Could not read or save your agent setup.
          </Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Retry agent setup"
            onPress={() => setAttempt((value) => value + 1)}
            style={styles.retry}
          >
            <Text style={styles.link}>Try again</Text>
          </PressableScale>
        </>
      ) : (
        <>
          <ActivityIndicator color={color.accent} />
          <Text style={styles.message}>Checking agents…</Text>
        </>
      )}
    </View>
  )
})

/** Eligibility is one opening. Drop its views as soon as a machine is chosen or setup is skipped. */
const AgentOnboardingDecision = observer(function AgentOnboardingDecision({
  onSelect,
  onSkip,
  onError,
}: {
  onSelect: (machineId: string) => void
  onSkip: () => Promise<void>
  onError: () => void
}) {
  const pool = useMobilePool()
  const catalog = pool ? here(pool.row('settingsCatalog', 'catalog')) : undefined
  const views = useAgentSetupPicker(catalog?.machines ?? [])
  const eligible = views.filter(
    (view) =>
      view.machine.use === 'granted' &&
      !view.machine.revokedAt &&
      !view.machine.supersededBy &&
      view.machine.serviceAssignment?.agentExecution !== false,
  )
  const ready = eligible.some((view) => view.items.some((item) => item.readyToStart))
  const loaded = !!catalog && views.length === catalog.machines.length
  const checking = eligible.some((view) => view.checking)
  const target = eligible.find((view) => view.reachable) ?? eligible[0]
  const skip = loaded && (ready || eligible.length === 0)
  const targetId = loaded && !ready && !checking ? target?.machine.id : undefined
  useEffect(() => {
    if (skip) void onSkip().catch(onError)
    else if (targetId) onSelect(targetId)
  }, [skip, targetId, onSkip, onSelect, onError])
  return (
    <View style={styles.waiting}>
      <ActivityIndicator color={color.accent} />
      <Text style={styles.message}>Checking agents…</Text>
    </View>
  )
})

const styles = StyleSheet.create({
  waiting: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    backgroundColor: color.bgSunken,
  },
  message: { ...sans(), fontSize: font.small, color: color.textDim },
  retry: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.lg },
  link: { ...sans(500), fontSize: font.body, color: color.accentTint },
})
