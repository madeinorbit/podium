import { useModelCatalog } from '@podium/client-core/react'
import { reposToViews } from '@podium/client-core/viewmodels'
import { agentCapabilityRejection, type MachineId, machinesForRepoOrClone } from '@podium/model'
import { useLayoutEffect, useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useMobileStore } from '../client/hooks'
import type { MobileTrpc } from '../client/trpc'
import {
  autoLaunchMachineOption,
  AUTO,
  allConnectorModelLabel,
  allConnectorModelOptions,
  decodeModelPick,
  effortOptionsForModel,
  ISSUE_AGENT_KINDS,
  ISSUE_AGENT_LABELS,
  issueAgentKind,
} from '../lib/agent-models'
import {
  type LaunchConfiguration,
  type LaunchMachineOption,
  type LaunchPlan,
  normalizeLaunchConfiguration,
  selectLaunchAgent,
  selectInheritedLaunchAgent,
  selectLaunchMachine,
  selectLaunchModel,
} from '../lib/launch-configuration'
import { color, font, mono, radius, sans, space } from '../theme/theme'
import { ActionSheet } from './ActionSheet'
import { NativePicker, type NativePickerOption } from './action-sheet-native'
import { PressableScale } from './PressableScale'

type Picker = 'agent' | 'model' | 'effort' | 'machine' | null

/** Native Where/How controls shared by task creation and deferred task launch. */
export function LaunchConfigurationFields({
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
  const store = useMobileStore()
  const [fallback, setFallback] = useState<Picker>(null)
  const repo = useMemo(
    () => reposToViews(store.repos).find((candidate) => candidate.path === repoPath),
    [repoPath, store.repos],
  )
  const machines = useMemo(
    () => (repo ? machinesForRepoOrClone(repo, store.machines) : []),
    [repo, store.machines],
  )
  const machineOptions = useMemo<LaunchMachineOption[]>(() => {
    const explicit = machines.map((machine) => {
      const rejection = agentCapabilityRejection(machine, value.agentKind)
      const reason =
        machine.use === 'denied'
          ? `You do not have permission to use ${machine.name}.`
          : !machine.online
            ? `${machine.name} is offline.`
            : rejection !== undefined
              ? `${machine.name} cannot run ${ISSUE_AGENT_LABELS[value.agentKind]}.`
              : undefined
      return {
        value: machine.id,
        label: machine.name,
        disabled: reason !== undefined,
        ...(reason ? { reason } : {}),
      }
    })
    return [autoLaunchMachineOption(explicit, ISSUE_AGENT_LABELS[value.agentKind]), ...explicit]
  }, [machines, value.agentKind])
  // An unpinned launch is validated by the server's own authority/default
  // catalog. Never substitute the first eligible repo machine: it may expose a
  // different harness or model set than the host that validates the spawn.
  const catalog = useModelCatalog<MobileTrpc>(
    value.machineId ? (value.machineId as MachineId) : undefined,
  )
  const plan = useMemo(
    () => normalizeLaunchConfiguration(value, catalog, machineOptions),
    [catalog, machineOptions, value],
  )
  // Commit the validity plan before the parent paints an enabled submit button.
  // A machine can go offline while this sheet is open; a passive effect would
  // leave one frame where the old eligible plan could still be submitted.
  useLayoutEffect(() => onPlan?.(plan), [onPlan, plan])
  const effective = plan.configuration
  const displayedMachineOptions: NativePickerOption[] =
    value.machineId && !machineOptions.some((option) => option.value === value.machineId)
      ? [
          ...machineOptions,
          { value: value.machineId, label: 'Unavailable machine', disabled: true },
        ]
      : machineOptions
  const agentOptions: NativePickerOption[] = [
    ...(allowInheritedAgent ? [{ value: '', label: 'Auto' }] : []),
    ...ISSUE_AGENT_KINDS.map((kind) => ({
      value: kind,
      label: ISSUE_AGENT_LABELS[kind],
    })),
  ]
  const modelOptions = useMemo<NativePickerOption[]>(() => {
    const group = ISSUE_AGENT_LABELS[effective.agentKind]
    return allConnectorModelOptions(catalog)
      .filter((option) => option.value === AUTO || option.group === group)
      .map(({ value: optionValue, label }) => ({ value: optionValue, label }))
  }, [catalog, effective.agentKind])
  const decoded = decodeModelPick(effective.modelPick)
  const effortOptions = effortOptionsForModel(
    effective.agentKind,
    decoded.model,
    catalog[effective.agentKind],
  )

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
      valueLabel: effective.inheritAgent ? 'Auto' : ISSUE_AGENT_LABELS[effective.agentKind],
      select: (selected) => {
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
    ...(effortOptions.length > 0
      ? [
          {
            key: 'effort' as const,
            label: 'Effort',
            selected: effective.effort,
            options: effortOptions,
            valueLabel:
              effortOptions.find((option) => option.value === effective.effort)?.label ?? 'Auto',
            select: (effort: string) => onChange({ ...value, effort }),
          },
        ]
      : []),
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
        {rows.map((row) => (
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
        ))}
      </View>
      {plan.refusal ? (
        <Text accessibilityLiveRegion="polite" style={styles.refusal}>
          {plan.refusal}
        </Text>
      ) : null}
      {rows.map((row) => (
        <ActionSheet
          key={row.key}
          visible={fallback === row.key}
          title={row.label}
          actions={row.options.map((option) => ({
            label: option.label,
            selected: option.value === row.selected,
            disabled: option.disabled,
            onPress: () => row.select(option.value),
          }))}
          onClose={() => setFallback((current) => (current === row.key ? null : current))}
        />
      ))}
    </>
  )
}

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
