/**
 * The pre-POD-1677 backend rail — a wrapping band that pays its own top and
 * bottom padding because it hung outside the capsule. From 1b1253ef0, imports
 * rewritten and exports renamed; nothing else changed. Capture only.
 */

import type { ModelCatalog } from '@podium/client-core/react'
import { ChevronLeft, Cpu, Gauge } from '../src/components/icons'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { BottomSheet } from '../src/components/BottomSheet'
import { Icon } from '../src/components/Icon'
import { PressableScale } from '../src/components/PressableScale'
import {
  AUTO,
  allConnectorModelLabel,
  allConnectorModelOptions,
  type CatalogOption,
  decodeModelPick,
  effortOptionsForModel,
  encodeModelPick,
  groupedCatalogOptions,
  issueAgentKind,
} from '../src/lib/agent-models'
import type { SuperagentBackend } from '../src/lib/superagent-backend'
import { alpha } from '../src/theme/mix'
import { color, font, mono, monoLabel, radius, sans, space } from '../src/theme/theme'

type PickerStep = 'model' | 'effort' | null

/**
 * The prompt box's backend rail — which model this thread thinks with, stated
 * where you are about to use it. Same contract as the desktop BackendRail:
 * quiet Auto until someone chooses, every connector in one list, effort only
 * once a harness is pinned, send is the save.
 */
export function BelowRail({
  backend,
  modelCatalog = {},
  onModelChange,
  onEffortChange,
}: {
  backend: SuperagentBackend
  modelCatalog?: ModelCatalog
  onModelChange: (model: string, agentKind?: string) => void
  onEffortChange: (effort: string) => void
}) {
  const [step, setStep] = useState<PickerStep>(null)
  const agentKind = issueAgentKind(backend.agentKind)
  const modelOptions = allConnectorModelOptions(modelCatalog)
  const selectedModel =
    backend.model !== AUTO && agentKind ? encodeModelPick(agentKind, backend.model) : AUTO
  const effortChoices = agentKind
    ? effortOptionsForModel(agentKind, backend.model, modelCatalog[agentKind])
    : []
  const modelLabel = allConnectorModelLabel(agentKind ?? undefined, backend.model, modelCatalog)
  const effortLabel =
    effortChoices.find((option) => option.value === backend.effort)?.label ?? 'Auto'

  const title = step === 'effort' ? 'Effort' : 'Model'

  const applyModel = (value: string) => {
    const decoded = decodeModelPick(value)
    onModelChange(decoded.model, decoded.agentKind)
    setStep(null)
  }

  return (
    <>
      <View testID="composer-backend" style={styles.rail}>
        <BelowPill
          icon={Cpu}
          label={modelLabel}
          quiet={backend.model === AUTO}
          accessibilityLabel="Model"
          onPress={() => setStep('model')}
        />
        {agentKind && effortChoices.length > 0 ? (
          <BelowPill
            icon={Gauge}
            label={effortLabel}
            quiet={backend.effort === AUTO}
            accessibilityLabel="Effort"
            onPress={() => setStep('effort')}
          />
        ) : null}
      </View>
      <BottomSheet
        visible={step !== null}
        onClose={() => setStep(null)}
        mode="fit"
        scrollable
        contentStyle={styles.sheetContent}
        head={
          <View style={styles.head}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Back"
              onPress={() => setStep(null)}
              style={({ pressed }) => [styles.headBack, pressed && styles.pressed]}
            >
              <Icon as={ChevronLeft} size={16} color={color.textDim} />
            </PressableScale>
            <Text style={styles.headTitle} numberOfLines={1}>
              {title}
            </Text>
          </View>
        }
      >
        {step === 'model' ? (
          <OptionList
            groups={groupedCatalogOptions(modelOptions)}
            selected={selectedModel}
            onPick={applyModel}
          />
        ) : null}
        {step === 'effort' ? (
          <OptionList
            groups={[{ options: effortChoices }]}
            selected={backend.effort}
            onPick={(value) => {
              onEffortChange(value)
              setStep(null)
            }}
          />
        ) : null}
      </BottomSheet>
    </>
  )
}

function BelowPill({
  icon,
  label,
  quiet,
  accessibilityLabel,
  onPress,
}: {
  icon: typeof Cpu
  label: string
  quiet: boolean
  accessibilityLabel: string
  onPress: () => void
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      hitSlop={6}
      scaleTo={0.97}
      style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
    >
      <Icon as={icon} size={12} color={quiet ? color.textMicro : color.textFaint} />
      <Text style={[styles.pillLabel, quiet && styles.pillQuiet]} numberOfLines={1}>
        {label}
      </Text>
    </PressableScale>
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
  rail: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    paddingTop: space.sm,
    // Keep this prompt-specific rail visually separate from the floating tab
    // bar below it instead of letting the two capsules read as one cluster.
    paddingBottom: space.sm,
  },
  pill: {
    minHeight: 32,
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    backgroundColor: color.surface,
  },
  pillPressed: {
    backgroundColor: color.surfacePressed,
  },
  pillLabel: {
    ...sans(500),
    color: color.text,
    fontSize: font.tiny,
  },
  pillQuiet: {
    color: color.textDim,
    fontWeight: '400',
  },
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
  headTitle: {
    ...sans(600),
    flex: 1,
    color: color.text,
    fontSize: font.heading,
    letterSpacing: -0.35,
  },
  sheetContent: {
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
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
  rowTitle: {
    ...sans(500),
    flex: 1,
    color: color.text,
    fontSize: font.small,
  },
  check: {
    ...mono(600),
    color: color.accentTint,
    fontSize: font.small,
  },
  pressed: {
    opacity: 0.65,
  },
})
