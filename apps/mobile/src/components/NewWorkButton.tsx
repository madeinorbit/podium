import { relativeTime } from '@podium/client-core/focus'
import { useModelCatalog, useSlice } from '@podium/client-core/react'
import {
  lastUsedMaps,
  machineViewsFromWire,
  type RepoNavView,
  resolveSpawnTargetMachine,
  spawnTargetForRepo,
  usableMachines,
  worklistSlice,
} from '@podium/client-core/viewmodels'
import type { AgentKind, MachineId } from '@podium/model'
import { lastUsedMachine } from '@podium/model'
import { usePathname, useRouter } from 'expo-router'
import { ChevronDown, ChevronLeft, ChevronRight, Plus } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useMobileStore, useSessions } from '../client/hooks'
import type { MobileTrpc } from '../client/trpc'
import {
  AUTO,
  allConnectorModelLabel,
  allConnectorModelOptions,
  decodeModelPick,
  effortOptionsForModel,
  groupedCatalogOptions,
  isEffortValid,
  spawnSelection,
  type CatalogOption,
  type IssueAgentKind,
} from '../lib/agent-models'
import { reposOnMachine } from '../lib/new-work'
import { sessionHref } from '../lib/session-route'
import { alpha } from '../theme/mix'
import { color, font, mono, monoLabel, radius, sans, space } from '../theme/theme'
import { BottomSheet } from './BottomSheet'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'
import { HeaderButton } from './Screen'

type PickerStep = 'launch' | 'model' | 'effort' | 'machine' | 'repo' | null

/**
 * Pocket launch sheet: model, then effort, then a machine when more than one
 * host is visible, then the project. Tracked tasks are created from the Tasks
 * tab — this sheet only starts an agent.
 */
export function NewWorkButton() {
  const pathname = usePathname()
  const router = useRouter()
  const store = useMobileStore()
  const sessions = useSessions()
  const { sections } = useSlice(worklistSlice)
  const [step, setStep] = useState<PickerStep>(null)
  const [harness, setHarness] = useState<AgentKind>('claude-code')
  const [modelPick, setModelPick] = useState(AUTO)
  const [effort, setEffort] = useState(AUTO)
  const [machinePick, setMachinePick] = useState<MachineId | null>(null)

  // Machines as THIS principal may act on them (doc §3.1.4 M1/M5): `see` is
  // already applied by the server's per-principal projection, `use` is read per
  // LIST by the shared helper — the identical reading the desktop spawn row,
  // the automations form and the execution-profile picker use. Two spellings of
  // "may I run here" is exactly how one surface comes to offer a machine
  // another refuses.
  const machineViews = useMemo(() => machineViewsFromWire(store.machines), [store.machines])
  const usable = useMemo(() => usableMachines(machineViews), [machineViews])
  const showMachine = machineViews.length > 1
  const machineId =
    (machinePick && machineViews.some((view) => view.machine.id === machinePick)
      ? machinePick
      : null) ??
    (lastUsedMachine(sessions, usable) as MachineId | undefined) ??
    (usable[0]?.id as MachineId | undefined) ??
    null
  const selectedMachine = machineViews.find((view) => view.machine.id === machineId)
  const modelCatalog = useModelCatalog<MobileTrpc>(machineId ?? undefined)

  const { repos, lastUsedByRepo } = useMemo(() => {
    const choices = [...sections.pinnedRepos, ...sections.repos]
    const { byRepo } = lastUsedMaps(sections, sessions)
    return {
      repos: choices.sort(
        (a, b) =>
          (byRepo.get(b.path) ?? 0) - (byRepo.get(a.path) ?? 0) ||
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      ),
      lastUsedByRepo: byRepo,
    }
  }, [sections, sessions])

  const visibleRepos = useMemo(
    () => reposOnMachine(repos, machineId, machineViews.length),
    [repos, machineId, machineViews.length],
  )

  /**
   * Where this spawn lands, or `null` to refuse it outright — the same shape
   * the desktop spawn row uses.
   *
   * DENIED IS NOT NO TARGET (§3.1.4 M5). An `unauthorized` refusal must STOP
   * the spawn: falling through to the repo's primary checkout is the silently
   * retargeted placement M5 forbids. `no-repo` and `unreachable` both resolve to
   * `undefined`, which `spawnTargetForRepo` turns into the repo's own main
   * checkout exactly as before — that split is what keeps single-user parity
   * while closing the hole.
   */
  const resolveSpawnMachine = (
    repo: RepoNavView,
    explicit?: MachineId,
  ): MachineId | undefined | null => {
    if (explicit !== undefined)
      return usable.some((machine) => machine.id === explicit) ? explicit : null
    const { machineId: resolved, refusal } = resolveSpawnTargetMachine(repo, sessions, machineViews)
    return refusal === 'unauthorized' ? null : resolved
  }

  const close = () => setStep(null)

  const start = (repo: RepoNavView, explicit?: MachineId) => {
    const targetMachine = resolveSpawnMachine(
      repo,
      explicit ?? (showMachine ? (machineId ?? undefined) : undefined),
    )
    if (targetMachine === null) return
    const { worktree } = spawnTargetForRepo(repo, targetMachine)
    const selection = spawnSelection(modelPick, effort)
    const { sessionId } = store.spawnDraftAgent({
      target: worktree,
      agentKind: harness,
      ...(selection.model ? { model: selection.model } : {}),
      ...(selection.effort ? { effort: selection.effort } : {}),
    })
    close()
    router.push(sessionHref(sessionId, pathname))
  }

  const applyModel = (value: string) => {
    setModelPick(value)
    const decoded = decodeModelPick(value)
    if (decoded.agentKind) setHarness(decoded.agentKind)
    const options = decoded.agentKind
      ? effortOptionsForModel(decoded.agentKind, decoded.model, modelCatalog[decoded.agentKind])
      : []
    const kind = (decoded.agentKind ?? harness) as IssueAgentKind
    if (options.length === 0 || !isEffortValid(kind, effort)) {
      setEffort(AUTO)
    }
    setStep('launch')
  }

  const decoded = decodeModelPick(modelPick)
  const modelSelected = modelPick !== AUTO
  const effortChoices =
    !modelSelected || harness === 'shell'
      ? []
      : effortOptionsForModel(
          (decoded.agentKind ?? harness) as IssueAgentKind,
          decoded.model,
          modelCatalog[decoded.agentKind ?? harness],
        )
  const modelOptions = allConnectorModelOptions(modelCatalog)
  const modelValue = allConnectorModelLabel(decoded.agentKind, decoded.model, modelCatalog)
  const canStart = !showMachine || selectedMachine?.availability === 'available'

  const title =
    step === 'model'
      ? 'Model'
      : step === 'effort'
        ? 'Effort'
        : step === 'machine'
          ? 'Machine'
          : step === 'repo'
            ? 'Project'
            : 'New work'

  const pickMachine = (id: MachineId) => {
    const view = machineViews.find((candidate) => candidate.machine.id === id)
    if (view?.availability !== 'available') return
    setMachinePick(id)
    setStep('launch')
  }

  const goToProject = () => {
    const decodedPick = decodeModelPick(modelPick)
    if (decodedPick.agentKind) setHarness(decodedPick.agentKind)
    setStep('repo')
  }

  return (
    <>
      <HeaderButton label="New work" onPress={() => setStep('launch')}>
        <Icon as={Plus} size={19} color={color.text} />
      </HeaderButton>
      <BottomSheet
        visible={step !== null}
        onClose={close}
        mode="fit"
        scrollable
        contentStyle={styles.content}
        head={
          <View style={styles.head}>
            {step !== 'launch' ? (
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Back"
                onPress={() => setStep('launch')}
                style={({ pressed }) => [styles.headBack, pressed && styles.pressed]}
              >
                <Icon as={ChevronLeft} size={16} color={color.textDim} />
              </PressableScale>
            ) : null}
            <View style={styles.headText}>
              <Text style={styles.headTitle} numberOfLines={1}>
                {title}
              </Text>
            </View>
          </View>
        }
      >
        {step === 'launch' ? (
          <>
            <FieldSelect label="Model" value={modelValue} onPress={() => setStep('model')} />

            {effortChoices.length > 0 ? (
              <FieldSelect
                label="Effort"
                value={effortChoices.find((option) => option.value === effort)?.label ?? 'Auto'}
                onPress={() => setStep('effort')}
              />
            ) : null}

            {showMachine ? (
              <FieldSelect
                label="Machine"
                value={selectedMachine?.machine.name ?? 'Choose a machine'}
                onPress={() => setStep('machine')}
              />
            ) : null}

            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Choose project"
              accessibilityState={{ disabled: !canStart || visibleRepos.length === 0 }}
              disabled={!canStart || visibleRepos.length === 0}
              onPress={goToProject}
              scaleTo={0.985}
              style={({ pressed }) => [
                styles.continue,
                (!canStart || visibleRepos.length === 0) && styles.continueDisabled,
                pressed && canStart && styles.continuePressed,
              ]}
            >
              <Text style={styles.continueText}>Choose project</Text>
              <Icon as={ChevronRight} size={16} color={color.accentText} />
            </PressableScale>

            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Shell"
              onPress={() => {
                setHarness('shell')
                setModelPick(AUTO)
                setEffort(AUTO)
                setStep('repo')
              }}
              style={({ pressed }) => [styles.quiet, pressed && styles.pressed]}
            >
              <Text style={styles.quietText}>Start a shell instead</Text>
              <Icon as={ChevronRight} size={14} color={color.textMicro} />
            </PressableScale>
          </>
        ) : null}

        {step === 'model' ? (
          <OptionList
            groups={groupedCatalogOptions(modelOptions)}
            selected={modelPick}
            onPick={applyModel}
          />
        ) : null}

        {step === 'effort' ? (
          <OptionList
            groups={[{ options: effortChoices }]}
            selected={effort}
            onPick={(value) => {
              setEffort(value)
              setStep('launch')
            }}
          />
        ) : null}

        {step === 'machine' ? (
          <View style={styles.list}>
            {/* UNAUTHORIZED AND UNREACHABLE ARE DIFFERENT WORDS (§3.1.4 M5).
                Both produce a machine you cannot spawn on, and collapsing them
                makes a person wait for a wake-up that will never help. Neither
                is pressable — the picker must not OFFER a machine the principal
                lacks `use` on — but the denied one says so rather than
                vanishing. */}
            {machineViews.map((view, i) => {
              const ok = view.availability === 'available'
              const selected = view.machine.id === machineId
              return (
                <PressableScale
                  key={view.machine.id}
                  accessibilityRole="button"
                  accessibilityLabel={view.machine.name}
                  accessibilityState={{ disabled: !ok, selected }}
                  disabled={!ok}
                  scaleTo={0.99}
                  onPress={() => pickMachine(view.machine.id)}
                  style={({ pressed }) => [
                    styles.row,
                    i > 0 && styles.rowDivider,
                    !ok && styles.rowDisabled,
                    pressed && styles.rowPressed,
                  ]}
                >
                  <View
                    style={[styles.dot, { backgroundColor: ok ? color.success : color.textMicro }]}
                  />
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {view.machine.name}
                    </Text>
                    {ok ? null : (
                      <Text style={styles.rowSub}>
                        {view.availability === 'unauthorized' ? 'No access' : 'Offline'}
                      </Text>
                    )}
                  </View>
                  {selected ? <Text style={styles.check}>✓</Text> : null}
                </PressableScale>
              )
            })}
          </View>
        ) : null}

        {step === 'repo' ? (
          visibleRepos.length === 0 ? (
            <Text style={styles.none}>No repositories are available on this account.</Text>
          ) : (
            <View style={styles.list}>
              {visibleRepos.map((repo, i) => {
                const used = lastUsedByRepo.get(repo.path)
                return (
                  <PressableScale
                    key={repo.path}
                    accessibilityRole="button"
                    accessibilityLabel={repo.name}
                    onPress={() => start(repo)}
                    scaleTo={0.99}
                    style={({ pressed }) => [
                      styles.row,
                      i > 0 && styles.rowDivider,
                      pressed && styles.rowPressed,
                    ]}
                  >
                    <View style={styles.repoTile}>
                      <Text style={styles.repoInitial}>{(repo.name[0] ?? '?').toUpperCase()}</Text>
                    </View>
                    <View style={styles.rowText}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {repo.name}
                      </Text>
                      <Text style={styles.rowSub} numberOfLines={1}>
                        {used
                          ? `last used ${relativeTime(new Date(used).toISOString(), Date.now())}`
                          : 'not used yet'}
                      </Text>
                    </View>
                    <Icon as={ChevronRight} size={15} color={color.textMicro} />
                  </PressableScale>
                )
              })}
            </View>
          )
        ) : null}
      </BottomSheet>
    </>
  )
}

function FieldSelect({
  label,
  value,
  onPress,
}: {
  label: string
  value: string
  onPress: () => void
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${value}`}
        onPress={onPress}
        scaleTo={0.99}
        style={({ pressed }) => [styles.select, pressed && styles.selectPressed]}
      >
        <Text style={styles.selectValue} numberOfLines={1}>
          {value}
        </Text>
        <Icon as={ChevronDown} size={16} color={color.textMicro} />
      </PressableScale>
    </View>
  )
}

function OptionList({
  groups,
  selected,
  onPick,
}: {
  groups: { label?: string; options: CatalogOption[] }[]
  selected: string
  onPick: (value: string) => void
}) {
  return (
    <View style={styles.optionStack}>
      {groups.map((group) => (
        <View key={group.label ?? group.options[0]?.value ?? 'group'} style={styles.list}>
          {group.label ? <Text style={styles.groupLabel}>{group.label}</Text> : null}
          {group.options.map((option, i) => {
            const on = option.value === selected
            return (
              <PressableScale
                key={option.value}
                accessibilityRole="button"
                accessibilityLabel={option.group ? `${option.group} ${option.label}` : option.label}
                accessibilityState={{ selected: on }}
                onPress={() => onPick(option.value)}
                scaleTo={0.99}
                style={({ pressed }) => [
                  styles.row,
                  (i > 0 || group.label) && styles.rowDivider,
                  pressed && styles.rowPressed,
                ]}
              >
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {option.label}
                </Text>
                {on ? <Text style={styles.check}>✓</Text> : null}
              </PressableScale>
            )
          })}
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  headBack: {
    width: 28,
    height: 28,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  headText: {
    flex: 1,
    minWidth: 0,
  },
  headTitle: {
    ...sans(600),
    color: color.text,
    fontSize: font.heading,
    letterSpacing: -0.35,
  },
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },

  field: {
    marginBottom: space.md,
  },
  fieldLabel: {
    ...monoLabel(),
    color: color.textFaint,
    marginBottom: space.xs,
  },
  select: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    backgroundColor: color.surface,
  },
  selectPressed: {
    backgroundColor: color.surfacePressed,
  },
  selectValue: {
    ...sans(500),
    flex: 1,
    color: color.text,
    fontSize: font.small,
  },

  optionStack: {
    gap: space.md,
  },
  groupLabel: {
    ...monoLabel(),
    color: color.label,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: 2,
  },

  continue: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    minHeight: 48,
    borderRadius: radius.md,
    backgroundColor: color.accent,
    marginTop: space.sm,
  },
  continuePressed: {
    opacity: 0.88,
  },
  continueDisabled: {
    opacity: 0.4,
  },
  continueText: {
    ...sans(700),
    color: color.accentText,
    fontSize: font.small,
  },

  quiet: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.md,
    minHeight: 44,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
  },
  quietText: {
    ...sans(400),
    flex: 1,
    color: color.textDim,
    fontSize: font.tiny,
  },

  list: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
    overflow: 'hidden',
  },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: 11,
  },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: alpha(color.hairline, 0.8),
  },
  rowPressed: {
    backgroundColor: color.surfacePressed,
  },
  rowDisabled: {
    opacity: 0.42,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  rowTitle: {
    ...sans(500),
    flex: 1,
    color: color.text,
    fontSize: font.small,
  },
  rowSub: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro,
  },
  repoTile: {
    width: 30,
    height: 30,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.elevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  repoInitial: {
    ...mono(600),
    color: color.textDim,
    fontSize: font.tiny,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginLeft: 4,
  },
  check: {
    ...mono(600),
    color: color.accentTint,
    fontSize: font.small,
  },
  none: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.small,
    paddingVertical: space.lg,
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.65,
  },
})
