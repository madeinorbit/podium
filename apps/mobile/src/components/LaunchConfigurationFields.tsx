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
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native'
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
import { color } from '../theme/theme'
import { ActionSheet } from './ActionSheet'
import { AgentMark } from './AgentMark'
import {
  installingAgentsHint,
  pickerHarnessStartable,
  SET_UP_AGENTS,
} from './AgentSetupPickerEntry'
import { PhoneAgentSetupSheet } from './AgentSetupSheet'
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
  const { fontScale } = useWindowDimensions()
  // Switch before the accessibility categories, as in the other native lists.
  // Give long machine/model names the full row width and let every line grow.
  const stacked = fontScale > 1.35
  const rowStyle = [insetRow.row, stacked && styles.stackedRow]
  const store = useLaunchInputs(repoPath)
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
  const agentOptions: CaptionedOption[] = [
    ...(allowInheritedAgent ? [{ value: '', label: 'Auto' }] : []),
    ...agentDescriptors(served).flatMap((descriptor) => {
      const kind = issueAgentKind(descriptor.kind)
      return kind && pickerHarnessStartable(setupViews, kind)
        ? [{ value: descriptor.kind, label: descriptor.label }]
        : []
    }),
    {
      value: SET_UP_AGENTS,
      label: 'Set up agents…',
      ...(setupHint ? { caption: setupHint } : {}),
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
        {rows.map((row) => {
          // Inert values reserve the same scaled indicator as the menu rows, so
          // Effort stays aligned even while its model's choices are unavailable.
          // An inert row reads like a disabled SwiftUI menu picker: same chevron,
          // value and chevron dimmed to tertiary, so it never looks tappable.
          const inert = row.options.length === 0
          const content = (
            <>
              <Text style={insetRow.label}>{row.label}</Text>
              <View style={[insetRow.trail, stacked && styles.stackedTrail]}>
                {row.agent ? (
                  <AgentMark kind={row.agent} size={16 * fontScale} ink={color.textDim} />
                ) : null}
                <Text
                  style={[insetRow.value, stacked && styles.stackedValue, inert && styles.inert]}
                  numberOfLines={stacked ? undefined : 2}
                >
                  {row.valueLabel}
                </Text>
                <View style={inert ? styles.inertIndicator : undefined}>
                  <Icon
                    as="chevron.up.chevron.down"
                    size={11 * fontScale}
                    color={color.textFaint}
                  />
                </View>
              </View>
            </>
          )
          return inert ? (
            <View
              key={row.key}
              accessible
              accessibilityLabel={`${row.label}, ${row.valueLabel}`}
              accessibilityState={{ disabled: true }}
              aria-disabled={true}
              style={rowStyle}
            >
              {content}
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
                selected: option.value === SET_UP_AGENTS ? false : option.value === row.selected,
                disabled: option.disabled,
                onPress: () => row.select(option.value),
              }))}
            >
              {(onPress) => {
                // The SwiftUI Menu owns iOS touches. An RN Pressable inside its
                // label would compete for the responder, as in ComposeFieldRow.
                return onPress ? (
                  <PressableScale
                    accessibilityRole="button"
                    accessibilityLabel={`${row.label}, ${row.valueLabel}`}
                    accessibilityHint="Opens a menu"
                    onPress={onPress}
                    style={({ pressed }) => [rowStyle, pressed && insetRow.pressed]}
                  >
                    {content}
                  </PressableScale>
                ) : (
                  <View
                    accessible
                    accessibilityRole="button"
                    accessibilityLabel={`${row.label}, ${row.valueLabel}`}
                    accessibilityHint="Opens a menu"
                    style={rowStyle}
                  >
                    {content}
                  </View>
                )
              }}
            </ComposeMenu>
          )
        })}
      </InsetGroup>
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
    </>
  )
})

const styles = StyleSheet.create({
  menu: { alignSelf: 'stretch', minHeight: 44 },
  stackedRow: { flexDirection: 'column', alignItems: 'stretch', gap: 4 },
  stackedTrail: { marginLeft: 0, alignSelf: 'stretch' },
  stackedValue: { flex: 1, textAlign: 'left' },
  inert: { color: color.textFaint },
  inertIndicator: { opacity: 0.5 },
})
