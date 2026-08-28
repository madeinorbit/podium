import { ChevronLeft, Cpu, Gauge } from 'lucide-react-native'
import type { ModelCatalog } from '@podium/client-core/react'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import {
  AUTO,
  allConnectorModelLabel,
  allConnectorModelOptions,
  decodeModelPick,
  encodeModelPick,
  effortOptionsForModel,
  groupedCatalogOptions,
  issueAgentKind,
  type CatalogOption,
} from '../lib/agent-models'
import type { SuperagentBackend } from '../lib/superagent-backend'
import { alpha } from '../theme/mix'
import { color, font, mono, monoLabel, radius, sans, space } from '../theme/theme'
import { BottomSheet } from './BottomSheet'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'

type PickerStep = 'model' | 'effort' | null

/**
 * The prompt box's backend rail — which model this thread thinks with, stated
 * where you are about to use it. Same contract as the desktop BackendRail:
 * quiet Auto until someone chooses, every connector in one list, effort only
 * once a harness is pinned, send is the save.
 *
 * It rides INSIDE the composer capsule, at the leading end of the control row
 * [POD-1677] — it used to be a third band slung under the box. So it sizes
 * itself to whatever the row's fixed trailing pair leaves: one line, no
 * wrapping, and the model chip gives up its width first because the effort
 * chip's word is short and losing it would leave the row saying nothing.
 */
export function SuperagentBackendRail({
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
        <Pill
          icon={Cpu}
          label={modelLabel}
          quiet={backend.model === AUTO}
          accessibilityLabel="Model"
          shrinks
          onPress={() => setStep('model')}
        />
        {agentKind && effortChoices.length > 0 ? (
          <Pill
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

function Pill({
  icon,
  label,
  quiet,
  accessibilityLabel,
  shrinks,
  onPress,
}: {
  icon: typeof Cpu
  label: string
  quiet: boolean
  accessibilityLabel: string
  /** Gives up width when the row runs out — the model chip, not the effort one. */
  shrinks?: boolean
  onPress: () => void
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      hitSlop={6}
      scaleTo={0.97}
      style={({ pressed }) => [
        styles.pill,
        shrinks && styles.pillShrinks,
        pressed && styles.pillPressed,
      ]}
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
                // `aria-pressed`, not `aria-selected`, and beside `accessibilityState` rather
                // than instead of it. react-native-web 0.21 reads only the `aria-*` spelling,
                // so the web build announced no state at all; and `aria-selected` is only
                // valid on a listbox/tab/grid role, so on a `button` it is ignored — the
                // browser-visible way to say a button is the chosen one is `aria-pressed`.
                // React Native still reads `accessibilityState` on device. [POD-1664]
                accessibilityState={{ selected: on }}
                aria-pressed={on}
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
  /**
   * One line, never two: this sits in the composer's control row, and a
   * wrapped chip would grow the capsule by a whole band under the send disc.
   */
  rail: {
    flexShrink: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pill: {
    minHeight: 30,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    backgroundColor: color.surface,
  },
  pillShrinks: {
    flexShrink: 1,
    minWidth: 0,
  },
  pillPressed: {
    backgroundColor: color.surfacePressed,
  },
  pillLabel: {
    ...sans(500),
    flexShrink: 1,
    minWidth: 0,
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
