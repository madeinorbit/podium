import { relativeTime } from '@podium/client-core/focus'
import { useModelCatalog, useSlice } from '@podium/client-core/react'
import {
  NEW_WORK_EFFORT_KEY,
  NEW_WORK_MACHINE_KEY,
  NEW_WORK_MODEL_KEY,
  NEW_WORK_REPO_KEY,
} from '@podium/client-core/ui-state'
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
import { ChevronDown, ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { useMobileStore, useSessions } from '../client/hooks'
import type { MobileTrpc } from '../client/trpc'
import { usePersistedUiState } from '../hooks/usePersistedUiState'
import {
  AUTO,
  allConnectorModelLabel,
  allConnectorModelOptions,
  type CatalogOption,
  decodeModelPick,
  effortOptionsForModel,
  filterCatalogOptions,
  groupedCatalogOptions,
  type IssueAgentKind,
  isEffortValid,
  spawnSelection,
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

/** The model pick that means "no agent at all" — a plain shell in the worktree.
 *  It lives in the model list rather than behind its own link: choosing what
 *  runs is one decision, and splitting it across two controls made the shell
 *  read as a different KIND of thing to start. */
const SHELL_PICK = 'shell'

/** Above this many models the list needs a filter more than it needs the space.
 *  A live catalog on a machine with four harnesses installed runs well past it. */
const SEARCH_THRESHOLD = 8

const readString = (raw: string | null): string | null => (raw && raw.length > 0 ? raw : null)
const writeString = (value: string | null): string | null => value

/**
 * Pocket launch sheet: everything the spawn needs on ONE screen, with the
 * drill-downs reserved for the lists that genuinely have many entries.
 *
 * IT USED TO BE A WIZARD, and the last step was the insult: after choosing a
 * model and an effort you pressed "Choose project" and were handed a list —
 * which, on the single-repo instance most operators run, had exactly one row in
 * it. A choice with one option is not a choice; it is a tap the app collects on
 * the way to doing the only thing it could have done. The project is now a
 * PRESELECTED field like the others (most recently used first, and inert when
 * there is only one), the primary control says Start, and nothing stands between
 * a returning operator and the same launch they made yesterday.
 *
 * The picks PERSIST (doc §3.3, through the replica's ui-state collection). The
 * sheet used to reset to Auto on every app start, so the operator who always
 * runs Opus on high re-chose it every time — the reference launchers all
 * remember, because the last launch is by far the best prediction of the next.
 *
 * Model choices come from the machine's own installed harnesses via
 * {@link useModelCatalog}; the compiled-in table is only the cold-start
 * fallback. Tracked tasks are still created from the Tasks tab — this sheet only
 * starts an agent.
 */
export function NewWorkButton() {
  const pathname = usePathname()
  const router = useRouter()
  const store = useMobileStore()
  const sessions = useSessions()
  const { sections } = useSlice(worklistSlice)
  const [step, setStep] = useState<PickerStep>(null)
  const [query, setQuery] = useState('')
  const [modelPick, setModelPick] = usePersistedUiState<string | null>(
    NEW_WORK_MODEL_KEY,
    readString,
    writeString,
  )
  const [effortPick, setEffortPick] = usePersistedUiState<string | null>(
    NEW_WORK_EFFORT_KEY,
    readString,
    writeString,
  )
  const [machinePick, setMachinePick] = usePersistedUiState<string | null>(
    NEW_WORK_MACHINE_KEY,
    readString,
    writeString,
  )
  const [repoPick, setRepoPick] = usePersistedUiState<string | null>(
    NEW_WORK_REPO_KEY,
    readString,
    writeString,
  )
  const model = modelPick ?? AUTO
  const effort = effortPick ?? AUTO

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
      ? (machinePick as MachineId)
      : null) ??
    (lastUsedMachine(sessions, usable) as MachineId | undefined) ??
    (usable[0]?.id as MachineId | undefined) ??
    null
  const selectedMachine = machineViews.find((view) => view.machine.id === machineId)
  // The catalog is a fact about the machine this spawn will land on, so it is
  // read for THAT machine and re-read when the operator changes it.
  const catalog = useModelCatalog<MobileTrpc>(machineId ?? undefined)

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
   * The project this sheet will start in, decided BEFORE it is shown.
   *
   * Remembered pick first, then most-recently-used (the list is already sorted
   * that way). A remembered path that is not on the selected machine is not an
   * error to report — it is simply not a candidate, and falling through to the
   * top of the list is what the operator would have done by hand.
   */
  const selectedRepo =
    visibleRepos.find((repo) => repo.path === repoPick) ?? visibleRepos[0] ?? null
  const onlyOneRepo = visibleRepos.length === 1

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

  const close = () => {
    setStep(null)
    setQuery('')
  }

  const decoded = decodeModelPick(model)
  const isShell = model === SHELL_PICK
  const harness: AgentKind = isShell ? 'shell' : (decoded.agentKind ?? 'claude-code')

  const start = (repo: RepoNavView, explicit?: MachineId) => {
    const targetMachine = resolveSpawnMachine(
      repo,
      explicit ?? (showMachine ? (machineId ?? undefined) : undefined),
    )
    if (targetMachine === null) return
    const { worktree } = spawnTargetForRepo(repo, targetMachine)
    const selection = isShell ? {} : spawnSelection(effectiveModel, effort)
    setRepoPick(repo.path)
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
    setQuery('')
    if (value === SHELL_PICK) {
      setEffortPick(AUTO)
      setStep('launch')
      return
    }
    const picked = decodeModelPick(value)
    const kind = (picked.agentKind ?? 'claude-code') as IssueAgentKind
    const options = effortOptionsForModel(kind, picked.model, catalog[kind])
    if (options.length === 0 || !isEffortValid(kind, effort, catalog[kind])) setEffortPick(AUTO)
    setStep('launch')
  }

  // The shell rides at the END of the list: it is the escape hatch, not a peer
  // of the models above it.
  const modelOptions: CatalogOption[] = [
    ...allConnectorModelOptions(catalog),
    { value: SHELL_PICK, label: 'Shell', group: 'No agent' },
  ]
  /**
   * A REMEMBERED PICK THE MACHINE NO LONGER OFFERS FALLS BACK TO AUTO.
   *
   * Only once the live catalog has actually answered for this harness, which is
   * the whole precision of the check: with an empty catalog the static fallback
   * is in play and a model that exists on the machine but not in the compiled
   * table would be discarded for no reason. With a live answer in hand, a pick
   * that is missing from it is a model this machine cannot run — starting on it
   * would fail at the daemon, several taps later, with nothing on screen that
   * explained why.
   */
  const pickHarness = (decoded.agentKind ?? 'claude-code') as IssueAgentKind
  const retired =
    !isShell &&
    model !== AUTO &&
    (catalog[pickHarness]?.length ?? 0) > 0 &&
    !catalog[pickHarness]?.some((choice) => choice.value === decoded.model)
  const effectiveModel = retired ? AUTO : model
  const modelValue = isShell
    ? 'Shell'
    : retired
      ? 'Auto'
      : allConnectorModelLabel(decoded.agentKind, decoded.model, catalog)
  const effortChoices =
    effectiveModel === AUTO || isShell
      ? []
      : effortOptionsForModel(pickHarness, decoded.model, catalog[pickHarness])
  const machineOk = !showMachine || selectedMachine?.availability === 'available'
  const canStart = machineOk && selectedRepo !== null

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
                onPress={() => {
                  setStep('launch')
                  setQuery('')
                }}
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

            {/* ONE PROJECT IS NOT A CHOICE. It is still shown — the operator has
                to be able to see where this lands — but as a statement rather
                than a control that opens a list of one. */}
            <FieldSelect
              label="Project"
              value={selectedRepo?.name ?? 'No repositories available'}
              {...(onlyOneRepo || visibleRepos.length === 0
                ? {}
                : { onPress: () => setStep('repo') })}
            />

            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={selectedRepo ? `Start in ${selectedRepo.name}` : 'Start'}
              accessibilityState={{ disabled: !canStart }}
              disabled={!canStart}
              onPress={() => selectedRepo && start(selectedRepo)}
              scaleTo={0.985}
              style={({ pressed }) => [
                styles.continue,
                !canStart && styles.continueDisabled,
                pressed && canStart && styles.continuePressed,
              ]}
            >
              <Text style={styles.continueText}>Start</Text>
              <Icon as={ChevronRight} size={16} color={color.accentText} />
            </PressableScale>

            {visibleRepos.length === 0 ? (
              <Text style={styles.none}>No repositories are available on this account.</Text>
            ) : null}
          </>
        ) : null}

        {step === 'model' ? (
          <ModelStep
            options={modelOptions}
            selected={effectiveModel}
            query={query}
            onQuery={setQuery}
            onPick={applyModel}
          />
        ) : null}

        {step === 'effort' ? (
          <OptionList
            groups={[{ options: effortChoices }]}
            selected={effort}
            onPick={(value) => {
              setEffortPick(value)
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
                    accessibilityState={{ selected: repo.path === selectedRepo?.path }}
                    onPress={() => {
                      setRepoPick(repo.path)
                      setStep('launch')
                    }}
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
                    {repo.path === selectedRepo?.path ? (
                      <Text style={styles.check}>✓</Text>
                    ) : (
                      <Icon as={ChevronRight} size={15} color={color.textMicro} />
                    )}
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

/**
 * The model list, with a filter once it is long enough to scroll past what a
 * thumb wants to flick. Harness headers stay: on a machine with four CLIs
 * installed, "Opus" alone does not say which of them will run it.
 */
function ModelStep({
  options,
  selected,
  query,
  onQuery,
  onPick,
}: {
  options: readonly CatalogOption[]
  selected: string
  query: string
  onQuery: (value: string) => void
  onPick: (value: string) => void
}) {
  const searchable = options.length > SEARCH_THRESHOLD
  const shown = searchable ? filterCatalogOptions(options, query) : [...options]
  return (
    <View style={styles.optionStack}>
      {searchable ? (
        <View style={styles.search}>
          <Icon as={Search} size={15} color={color.textMicro} />
          <TextInput
            accessibilityLabel="Filter models"
            value={query}
            onChangeText={onQuery}
            placeholder="Filter models"
            placeholderTextColor={color.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.searchInput}
          />
        </View>
      ) : null}
      {shown.length === 0 ? (
        <Text style={styles.none}>No model matches that.</Text>
      ) : (
        <OptionList groups={groupedCatalogOptions(shown)} selected={selected} onPick={onPick} />
      )}
    </View>
  )
}

function FieldSelect({
  label,
  value,
  onPress,
}: {
  label: string
  value: string
  /** Absent renders the field as a STATEMENT — no chevron, no press target.
   *  A control that opens a list of one is worse than no control. */
  onPress?: () => void
}) {
  const body = (
    <>
      <Text style={styles.selectValue} numberOfLines={1}>
        {value}
      </Text>
      {onPress ? <Icon as={ChevronDown} size={16} color={color.textMicro} /> : null}
    </>
  )
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {onPress ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`${label}, ${value}`}
          onPress={onPress}
          scaleTo={0.99}
          style={({ pressed }) => [styles.select, pressed && styles.selectPressed]}
        >
          {body}
        </PressableScale>
      ) : (
        <View
          accessibilityLabel={`${label}, ${value}`}
          style={[styles.select, styles.selectStatic]}
        >
          {body}
        </View>
      )}
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
  /** A field that states rather than asks sits one tier quieter, so the two
   *  read differently before the chevron is looked for. */
  selectStatic: {
    borderColor: color.border,
    backgroundColor: 'transparent',
  },
  selectValue: {
    ...sans(500),
    flex: 1,
    color: color.text,
    fontSize: font.small,
  },

  search: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  searchInput: {
    ...sans(400),
    flex: 1,
    minWidth: 0,
    color: color.text,
    fontSize: font.small,
    padding: 0,
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
