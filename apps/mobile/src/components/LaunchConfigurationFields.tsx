import {
  AUTO,
  agentDescriptors,
  modelOptions as agentModelOptions,
  allConnectorModelLabel,
  decodeModelPick,
  effortLabel,
  effortOptionsForModel,
  encodeModelPick,
  issueAgentKind,
  issueAgentLabel,
} from '@podium/client-core/agent-models'
import { useHarnessDescriptors, useModelCatalogState } from '@podium/client-core/react'
import {
  agentCapabilityRejection,
  isMachineOfflineForLiveTerminal,
  type MachineId,
  machinesForRepoOrClone,
} from '@podium/model'
import { observer } from 'mobx-react-lite'
import { useLayoutEffect, useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { MobileTrpc } from '../client/trpc'
import { useAgentSetupPicker } from '../client/use-agent-setup-picker'
import { useLaunchInputs } from '../client/use-launch-inputs'
import {
  autoLaunchMachineOption,
  hasAuthoritativeLaunchCatalog,
  type LaunchConfiguration,
  type LaunchPlan,
  normalizeLaunchConfiguration,
  selectInheritedLaunchAgent,
  selectLaunchAgent,
  selectLaunchEffort,
  selectLaunchMachine,
  selectLaunchModel,
} from '../lib/launch-configuration'
import { color, font, mono, radius, sans, space } from '../theme/theme'
import { ActionSheet } from './ActionSheet'
import {
  installingAgentsHint,
  pickerHarnessStartable,
  SET_UP_AGENTS,
} from './AgentSetupPickerEntry'
import { PhoneAgentSetupSheet } from './AgentSetupSheet'
import { NativePicker, type NativePickerOption } from './action-sheet-native'
import { PressableScale } from './PressableScale'

type Picker = 'agent' | 'model' | 'effort' | 'machine' | null

/** Native Where/How controls shared by task creation and deferred task launch. */
export const LaunchConfigurationFields = observer(function LaunchConfigurationFields({
  repoPath,
  value,
  onChange,
  onPlan,
  allowInheritedAgent = false,
}: {
  repoPath: string
  value: LaunchConfiguration
  onChange: (value: LaunchConfiguration) => void
  onPlan?: (plan: LaunchPlan) => void
  allowInheritedAgent?: boolean
}) {
  const store = useLaunchInputs(repoPath)
  const [fallback, setFallback] = useState<Picker>(null)
  const [setupMachineId, setSetupMachineId] = useState<string | null>(null)
  const [chooseSetupMachine, setChooseSetupMachine] = useState(false)
  const repo = store.repo
  const machines = (() => (repo ? machinesForRepoOrClone(repo, store.machines) : []))()
  // An unpinned launch is validated by the server's own authority/default
  // catalog. Never substitute the first eligible repo machine: it may expose a
  // different harness or model set than the host that validates the spawn.
  const { catalog, status: catalogStatus } = useModelCatalogState<MobileTrpc>(
    value.machineId ? (value.machineId as MachineId) : undefined,
  )
  // Served harness descriptors for the launch target (POD-4475): harness
  // names render from the report, bundled copy offline.
  const { served } = useHarnessDescriptors<MobileTrpc>(
    value.machineId ? (value.machineId as MachineId) : undefined,
  )
  const machineOptions = (() => {
    const explicit = machines.map((machine) => {
      const rejection = agentCapabilityRejection(machine, value.agentKind)
      const reason =
        machine.use === 'denied'
          ? `You do not have permission to use ${machine.name}.`
          : isMachineOfflineForLiveTerminal(machine)
            ? `${machine.name} is offline.`
            : rejection !== undefined
              ? `${machine.name} cannot run ${issueAgentLabel(value.agentKind, served)}.`
              : undefined
      return {
        value: machine.id,
        label: machine.name,
        disabled: reason !== undefined,
        ...(reason ? { reason } : {}),
      }
    })
    return [
      autoLaunchMachineOption(explicit, issueAgentLabel(value.agentKind, served)),
      ...explicit,
    ]
  })()
  // Read live machine facts on every render: pool models keep their identity
  // when availability or permission changes. Only the resulting scalar plan
  // is memoized, so publishing it cannot feed back into another parent render.
  const { configuration, refusal } = normalizeLaunchConfiguration(
    value,
    catalog,
    machineOptions,
    catalogStatus,
  )
  const { inheritAgent, agentKind, modelPick, effort, machineId } = configuration
  const plan = useMemo<LaunchPlan>(
    () => ({
      configuration: {
        ...(inheritAgent === undefined ? {} : { inheritAgent }),
        agentKind,
        modelPick,
        effort,
        machineId,
      },
      ...(refusal ? { refusal } : {}),
    }),
    [inheritAgent, agentKind, modelPick, effort, machineId, refusal],
  )
  // Commit the validity plan before the parent paints an enabled submit button.
  // A machine can go offline while this sheet is open; a passive effect would
  // leave one frame where the old eligible plan could still be submitted.
  useLayoutEffect(() => onPlan?.(plan), [onPlan, plan])
  const effective = plan.configuration
  const hasLiveAgentCatalog = hasAuthoritativeLaunchCatalog(
    catalog,
    catalogStatus,
    effective.agentKind,
  )
  const displayedMachineOptions: NativePickerOption[] =
    value.machineId && !machineOptions.some((option) => option.value === value.machineId)
      ? [
          ...machineOptions,
          { value: value.machineId, label: 'Unavailable machine', disabled: true },
        ]
      : machineOptions
  const targetMachines = value.machineId
    ? machines.filter((machine) => machine.id === value.machineId)
    : machines
  const setupMachines = targetMachines.filter((machine) => machine.use !== 'denied')
  const setupViews = useAgentSetupPicker(targetMachines.map((machine) => machine.id))
  const setupHint = installingAgentsHint(setupViews)
  const openSetup = () => {
    if (setupMachines.length === 1) setSetupMachineId(setupMachines[0]!.id)
    else setChooseSetupMachine(true)
  }
  const agentOptions: NativePickerOption[] = [
    ...(allowInheritedAgent ? [{ value: '', label: 'Auto' }] : []),
    ...agentDescriptors(served).flatMap((descriptor) => {
      const kind = issueAgentKind(descriptor.kind)
      return kind && pickerHarnessStartable(setupViews, kind)
        ? [{ value: descriptor.kind, label: descriptor.label }]
        : []
    }),
    {
      value: SET_UP_AGENTS,
      label: `Set up agents…${setupHint ? ` · ${setupHint}` : ''}`,
      disabled: setupMachines.length === 0,
    },
  ]
  const liveModels = catalog[effective.agentKind]
  const modelOptions = useMemo<NativePickerOption[]>(() => {
    if (!hasLiveAgentCatalog) return [{ value: AUTO, label: 'Auto' }]
    return agentModelOptions(effective.agentKind, liveModels, served).map(
      ({ value: optionValue, label }) => ({
        value: optionValue === AUTO ? AUTO : encodeModelPick(effective.agentKind, optionValue),
        label,
      }),
    )
  }, [liveModels, effective.agentKind, hasLiveAgentCatalog, served])
  const decoded = decodeModelPick(effective.modelPick)
  const effortOptions = hasLiveAgentCatalog
    ? effortOptionsForModel(
        effective.agentKind,
        decoded.model,
        catalog[effective.agentKind],
        served,
      )
    : []

  const rows: Array<{
    key: Exclude<Picker, null>
    label: string
    selected: string
    options: readonly NativePickerOption[]
    valueLabel: string
    select: (selected: string) => void
  }> = [
    {
      key: 'agent',
      label: 'Agent',
      selected: effective.inheritAgent ? '' : effective.agentKind,
      options: agentOptions,
      valueLabel: effective.inheritAgent ? 'Auto' : issueAgentLabel(effective.agentKind, served),
      select: (selected) => {
        if (selected === SET_UP_AGENTS) {
          openSetup()
          return
        }
        if (!selected && allowInheritedAgent) {
          onChange(selectInheritedLaunchAgent(value))
          return
        }
        const agentKind = issueAgentKind(selected)
        if (agentKind) onChange(selectLaunchAgent(value, agentKind))
      },
    },
    {
      key: 'model',
      label: 'Model',
      selected: effective.modelPick,
      options: modelOptions,
      valueLabel: allConnectorModelLabel(decoded.agentKind, decoded.model, catalog),
      select: (modelPick) => onChange(selectLaunchModel(value, modelPick)),
    },
    {
      key: 'effort',
      label: 'Effort',
      selected: effective.effort,
      options: effortOptions,
      valueLabel: effortLabel(effective.agentKind, effective.effort),
      select: (effort: string) => onChange(selectLaunchEffort(value, effort)),
    },
    {
      key: 'machine',
      label: 'Machine',
      selected: value.machineId,
      options: displayedMachineOptions,
      valueLabel:
        displayedMachineOptions.find((option) => option.value === value.machineId)?.label ?? 'Auto',
      select: (machineId) => onChange(selectLaunchMachine(value, machineId)),
    },
  ]

  return (
    <>
      <View style={styles.group}>
        {rows.map((row) =>
          row.options.length === 0 ? (
            <View
              key={row.key}
              accessibilityLabel={`${row.label}, ${row.valueLabel}`}
              style={styles.row}
            >
              <Text style={styles.label}>{row.label}</Text>
              <Text style={styles.value}>{row.valueLabel}</Text>
            </View>
          ) : (
            <NativePicker
              key={row.key}
              label={row.label}
              options={row.options}
              selected={row.selected}
              onSelect={row.select}
              onOpenFallback={() => setFallback(row.key)}
            >
              {(onPress) => (
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={`${row.label}, ${row.valueLabel}`}
                  accessibilityHint="Opens a picker"
                  onPress={onPress}
                  style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                >
                  <Text style={styles.label}>{row.label}</Text>
                  <Text style={styles.value} numberOfLines={1}>
                    {row.valueLabel}
                  </Text>
                  <Text style={styles.chevron}>›</Text>
                </PressableScale>
              )}
            </NativePicker>
          ),
        )}
      </View>
      {setupMachineId ? (
        <PhoneAgentSetupSheet
          machineId={setupMachineId}
          origin="menu"
          onClose={() => setSetupMachineId(null)}
          onStart={(harness) => {
            const kind = issueAgentKind(harness)
            if (kind) onChange(selectLaunchAgent(selectLaunchMachine(value, setupMachineId), kind))
          }}
        />
      ) : null}
      {chooseSetupMachine ? (
        <ActionSheet
          visible
          title="Set up agents on"
          actions={setupMachines.map((machine) => ({
            label: machine.name,
            onPress: () => setSetupMachineId(machine.id),
          }))}
          onClose={() => setChooseSetupMachine(false)}
        />
      ) : null}
      {plan.refusal ? (
        <Text accessibilityLiveRegion="polite" style={styles.refusal}>
          {plan.refusal}
        </Text>
      ) : null}
      {rows.map((row) =>
        fallback === row.key ? (
          <ActionSheet
            key={row.key}
            visible
            title={row.label}
            actions={row.options.map((option) => ({
              label: option.label,
              selected: option.value === SET_UP_AGENTS ? undefined : option.value === row.selected,
              ...(option.value === SET_UP_AGENTS && setupHint ? { hint: setupHint } : {}),
              disabled: option.disabled,
              onPress: () => row.select(option.value),
            }))}
            onClose={() => setFallback((current) => (current === row.key ? null : current))}
          />
        ) : null,
      )}
    </>
  )
})

const styles = StyleSheet.create({
  group: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
    overflow: 'hidden',
  },
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  label: {
    ...sans(500),
    width: 68,
    color: color.textFaint,
    fontSize: font.tiny,
  },
  value: {
    ...sans(500),
    flex: 1,
    color: color.body,
    fontSize: font.small,
    textAlign: 'right',
  },
  chevron: {
    ...mono(400),
    color: color.textMicro,
    fontSize: font.body,
  },
  pressed: { opacity: 0.68 },
  refusal: {
    ...sans(400),
    color: color.dangerText,
    fontSize: font.tiny,
    paddingTop: space.sm,
  },
})
