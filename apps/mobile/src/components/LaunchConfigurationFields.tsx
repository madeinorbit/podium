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
import { useLayoutEffect, useMemo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { MobileTrpc } from '../client/trpc'
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
import { color } from '../theme/theme'
import { AgentMark } from './AgentMark'
import type { NativePickerOption } from './action-sheet-spec'
import { ComposeMenu } from './compose/ComposeMenu'
import { Icon } from './Icon'
import { InsetGroup, insetRow } from './InsetGroup'
import { PressableScale } from './PressableScale'

type Picker = 'agent' | 'model' | 'effort' | 'machine'
/** A picker value with the caption its native menu row shows beneath it. */
type CaptionedOption = NativePickerOption & { caption?: string }

/** The Agent, Model, Effort and Machine rows of a deferred task launch, as one
 * inset-grouped section of native pull-down menus. */
export const LaunchConfigurationFields = observer(function LaunchConfigurationFields({
  repoPath,
  value,
  onChange,
  onPlan,
  allowInheritedAgent = false,
  header,
}: {
  repoPath: string
  value: LaunchConfiguration
  onChange: (value: LaunchConfiguration) => void
  onPlan?: (plan: LaunchPlan) => void
  allowInheritedAgent?: boolean
  /** Section header above the rows: the task being launched. */
  header?: string
}) {
  const store = useLaunchInputs(repoPath)
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
  // Each machine carries its own caption in the menu: why it cannot take this
  // launch, or that it can. Auto names what it will do.
  const captionedMachineOptions: CaptionedOption[] = machineOptions.map((option) => ({
    ...option,
    caption: option.reason ?? (option.value === '' ? 'Any available machine' : 'Available'),
  }))
  const displayedMachineOptions: CaptionedOption[] =
    value.machineId && !machineOptions.some((option) => option.value === value.machineId)
      ? [
          ...captionedMachineOptions,
          { value: value.machineId, label: 'Unavailable machine', disabled: true },
        ]
      : captionedMachineOptions
  const agentOptions: NativePickerOption[] = [
    ...(allowInheritedAgent ? [{ value: '', label: 'Auto' }] : []),
    ...agentDescriptors(served)
      .filter((descriptor) => descriptor.kind !== 'shell')
      .map((descriptor) => ({
        value: descriptor.kind,
        label: descriptor.label,
      })),
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
    key: Picker
    label: string
    selected: string
    options: readonly CaptionedOption[]
    valueLabel: string
    agent?: string
    select: (selected: string) => void
  }> = [
    {
      key: 'agent',
      label: 'Agent',
      selected: effective.inheritAgent ? '' : effective.agentKind,
      options: agentOptions,
      valueLabel: effective.inheritAgent ? 'Auto' : issueAgentLabel(effective.agentKind, served),
      ...(effective.inheritAgent ? {} : { agent: effective.agentKind }),
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
    <InsetGroup
      header={header}
      footer={
        plan.refusal ? (
          <Text accessibilityLiveRegion="polite" style={insetRow.footerError}>
            {plan.refusal}
          </Text>
        ) : undefined
      }
    >
      {rows.map((row) =>
        row.options.length === 0 ? (
          <View
            key={row.key}
            accessible
            accessibilityLabel={`${row.label}, ${row.valueLabel}`}
            style={insetRow.row}
          >
            <Text style={insetRow.label}>{row.label}</Text>
            <View style={insetRow.trail}>
              <Text style={insetRow.value} numberOfLines={2}>
                {row.valueLabel}
              </Text>
            </View>
          </View>
        ) : (
          <ComposeMenu
            key={row.key}
            label={row.label}
            style={styles.menu}
            items={row.options.map((option) => ({
              id: option.value,
              label: option.group ? `${option.group} · ${option.label}` : option.label,
              ...(option.caption ? { subtitle: option.caption } : {}),
              selected: option.value === row.selected,
              disabled: option.disabled,
              onPress: () => row.select(option.value),
            }))}
          >
            {(onPress) => {
              const content = (
                <>
                  <Text style={insetRow.label}>{row.label}</Text>
                  <View style={insetRow.trail}>
                    {row.agent ? (
                      <AgentMark kind={row.agent} size={16} ink={color.textDim} />
                    ) : null}
                    <Text style={insetRow.value} numberOfLines={2}>
                      {row.valueLabel}
                    </Text>
                    <Icon as="chevron.up.chevron.down" size={11} color={color.textFaint} />
                  </View>
                </>
              )
              // The SwiftUI Menu owns iOS touches. An RN Pressable inside its
              // label would compete for the responder, as in ComposeFieldRow.
              return onPress ? (
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={`${row.label}, ${row.valueLabel}`}
                  accessibilityHint="Opens a menu"
                  onPress={onPress}
                  style={({ pressed }) => [insetRow.row, pressed && insetRow.pressed]}
                >
                  {content}
                </PressableScale>
              ) : (
                <View
                  accessible
                  accessibilityRole="button"
                  accessibilityLabel={`${row.label}, ${row.valueLabel}`}
                  accessibilityHint="Opens a menu"
                  style={insetRow.row}
                >
                  {content}
                </View>
              )
            }}
          </ComposeMenu>
        ),
      )}
    </InsetGroup>
  )
})

const styles = StyleSheet.create({
  menu: { alignSelf: 'stretch', minHeight: 44 },
})
