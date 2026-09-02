import {
  codingRoleHarness,
  ISSUE_STAGE_LABELS,
  reposToViews,
  repoUsageAt,
} from '@podium/client-core/viewmodels'
import { HUMAN_SETTABLE_ISSUE_STAGES, type IssueStage } from '@podium/model'
import { useRouter } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { useMobileStore, useSessions } from '../client/hooks'
import { LaunchConfigurationFields } from '../components/LaunchConfigurationFields'
import {
  type LaunchConfiguration,
  type LaunchPlan,
  launchConfigurationPatch,
  launchPlanCanSubmit,
} from '../lib/launch-configuration'
import { PressableScale } from '../components/PressableScale'
import { Screen } from '../components/Screen'
import { SectionHeader } from '../components/ui'
import { useContentBottomInset } from '../hooks/useContentBottomInset'
import { AUTO, issueAgentKind } from '../lib/agent-models'
import { newTaskInput } from '../lib/new-task'
import { color, font, radius, sans, space } from '../theme/theme'

const PRIORITIES = [0, 1, 2, 3, 4]
const DEFAULT_LAUNCH: LaunchConfiguration = {
  inheritAgent: true,
  agentKind: 'claude-code',
  modelPick: AUTO,
  effort: AUTO,
  machineId: '',
}

export function NewIssueScreen() {
  const router = useRouter()
  // The modal sheet reaches the physical bottom edge, so the Create button
  // still has to clear the home indicator (the hook is the plain safe-area
  // inset here).
  const bottomInset = useContentBottomInset()
  const store = useMobileStore()
  const sessions = useSessions()
  const [fallbackRepos, setFallbackRepos] = useState<string[]>([])
  const repos = useMemo(() => {
    if (store.repos.length === 0) return fallbackRepos
    return reposToViews(store.repos)
      .sort(
        (a, b) =>
          repoUsageAt(b, sessions) - repoUsageAt(a, sessions) ||
          a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }),
      )
      .map((repo) => repo.path)
  }, [fallbackRepos, sessions, store.repos])
  const [repoPath, setRepoPath] = useState('')
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [stage, setStage] = useState<IssueStage>('backlog')
  const [priority, setPriority] = useState(2)
  const [startNow, setStartNow] = useState(true)
  const [launch, setLaunch] = useState<LaunchConfiguration>(DEFAULT_LAUNCH)
  const [launchPlan, setLaunchPlan] = useState<LaunchPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (store.repos.length > 0) return
    store.trpc.repos.list
      .query()
      .then(setFallbackRepos)
      .catch(() => setFallbackRepos([]))
  }, [store.repos.length, store.trpc])

  useEffect(() => {
    let cancelled = false
    store.trpc.settings.get
      .query()
      .then((settings) => {
        if (cancelled) return
        const configured = issueAgentKind(codingRoleHarness(settings))
        if (!configured) return
        setLaunch((current) =>
          current.inheritAgent ? { ...current, agentKind: configured } : current,
        )
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [store.trpc])

  useEffect(() => {
    if (!repoPath || !repos.includes(repoPath)) setRepoPath(repos[0] ?? '')
  }, [repoPath, repos])

  const canCreate =
    repoPath.trim().length > 0 &&
    title.trim().length > 0 &&
    !busy &&
    (!startNow || launchPlanCanSubmit(launchPlan))

  const create = async () => {
    if (!canCreate) return
    setBusy(true)
    setError(null)
    try {
      const configured = launchConfigurationPatch(launchPlan?.configuration ?? launch)
      const issue = await store.trpc.issues.create.mutate(
        newTaskInput({
          repoPath: repoPath.trim(),
          title: title.trim(),
          prompt,
          type: 'task',
          priority,
          startNow,
          launch: configured,
        }),
      )
      if (stage !== 'backlog') {
        await store.trpc.issues.update.mutate({ id: issue.id, patch: { stage } })
      }
      router.replace(`/issue/${encodeURIComponent(issue.id)}`)
    } catch (cause) {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <Screen title="New task" onBack={() => router.back()} backAs="text">
      <ScrollView
        contentContainerStyle={{ paddingBottom: bottomInset + space.xl }}
        keyboardShouldPersistTaps="handled"
      >
        <SectionHeader label="Where" />
        <View style={styles.chipWrap} accessibilityRole="radiogroup">
          {repos.map((repo) => {
            const name = repo.split('/').filter(Boolean).pop() ?? repo
            const active = repoPath === repo
            return (
              <PressableScale
                key={repo}
                accessibilityRole="radio"
                accessibilityLabel={`Repository ${name}`}
                accessibilityState={{ checked: active }}
                aria-checked={active}
                onPress={() => {
                  setRepoPath(repo)
                  setLaunchPlan(null)
                  setLaunch((current) => ({ ...current, machineId: '' }))
                }}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{name}</Text>
              </PressableScale>
            )
          })}
        </View>
        <View style={styles.chipWrap} accessibilityRole="radiogroup">
          {HUMAN_SETTABLE_ISSUE_STAGES.map((value) => (
            <Choice
              key={value}
              label={ISSUE_STAGE_LABELS[value]}
              selected={stage === value}
              onPress={() => setStage(value)}
            />
          ))}
        </View>

        <SectionHeader label="What" />
        <TextInput
          autoFocus
          accessibilityLabel="Task title"
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholder="What needs doing?"
          placeholderTextColor={color.textFaint}
        />
        <TextInput
          accessibilityLabel="First prompt and task context"
          style={[styles.input, styles.multiline]}
          value={prompt}
          onChangeText={setPrompt}
          placeholder="First prompt, context, constraints, acceptance criteria…"
          placeholderTextColor={color.textFaint}
          multiline
        />
        <View style={styles.chipWrap} accessibilityRole="radiogroup">
          {PRIORITIES.map((value) => (
            <Choice
              key={value}
              label={`P${value}`}
              selected={priority === value}
              onPress={() => setPriority(value)}
            />
          ))}
        </View>

        <SectionHeader label="How" />
        <View style={styles.startRow}>
          <View style={styles.startCopy}>
            <Text style={styles.startTitle}>Start work now</Text>
            <Text style={styles.startHint}>
              {startNow
                ? 'The task context becomes the agent’s first prompt.'
                : 'Agent, model, effort, and machine are chosen when you start it.'}
            </Text>
          </View>
          <Switch
            accessibilityLabel="Start work now"
            value={startNow}
            onValueChange={setStartNow}
            trackColor={{ false: color.fill, true: color.accent }}
          />
        </View>
        {startNow ? (
          <View style={styles.launchFields}>
            <LaunchConfigurationFields
              repoPath={repoPath}
              value={launch}
              allowInheritedAgent
              onChange={(next) => {
                setLaunchPlan(null)
                setLaunch(next)
              }}
              onPlan={setLaunchPlan}
            />
          </View>
        ) : null}

        {error ? (
          <Text accessibilityLiveRegion="assertive" style={styles.error}>
            {error}
          </Text>
        ) : null}
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Create task"
          accessibilityState={{ disabled: !canCreate }}
          disabled={!canCreate}
          onPress={() => void create()}
          style={[styles.createBtn, !canCreate && styles.createBtnDisabled]}
        >
          <Text style={styles.createText}>
            {busy ? 'Creating…' : startNow ? 'Create and start' : 'Create task'}
          </Text>
        </PressableScale>
      </ScrollView>
    </Screen>
  )
}

function Choice({
  label,
  selected,
  onPress,
}: {
  label: string
  selected: boolean
  onPress: () => void
}) {
  return (
    <PressableScale
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      aria-checked={selected}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipActive]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextActive]}>{label}</Text>
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  chip: {
    minHeight: 40,
    justifyContent: 'center',
    borderRadius: radius.full,
    paddingHorizontal: space.md,
    backgroundColor: color.card,
    borderColor: color.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipActive: { backgroundColor: color.accent, borderColor: color.accent },
  chipText: { ...sans(600), color: color.textDim, fontSize: font.small },
  chipTextActive: { color: color.accentText },
  input: {
    marginHorizontal: space.lg,
    marginBottom: space.md,
    color: color.text,
    fontSize: font.body,
    backgroundColor: color.bgSunken,
    borderColor: color.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  multiline: { minHeight: 104, textAlignVertical: 'top' },
  startRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
  },
  startCopy: { flex: 1, gap: 2 },
  startTitle: { ...sans(600), color: color.body, fontSize: font.small },
  startHint: { ...sans(400), color: color.textFaint, fontSize: font.tiny },
  launchFields: { paddingHorizontal: space.lg, paddingTop: space.sm },
  error: {
    ...sans(400),
    color: color.dangerText,
    fontSize: font.small,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
  createBtn: {
    minHeight: 50,
    justifyContent: 'center',
    marginHorizontal: space.lg,
    marginTop: space.xl,
    backgroundColor: color.accent,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  createBtnDisabled: { opacity: 0.4 },
  createText: { ...sans(700), color: color.accentText, fontSize: font.body },
})
