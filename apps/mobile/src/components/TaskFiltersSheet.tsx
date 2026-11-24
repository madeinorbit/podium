import { useState } from 'react'
import { StyleSheet, Switch, Text, View } from 'react-native'
import { color, font, mono, monoLabel, radius, sans, space } from '../theme/theme'
import { NativePicker, type NativePickerOption } from './action-sheet-native'
import { BottomSheet } from './BottomSheet'
import { Icon } from './Icon'
import { ChevronLeft, ChevronRight } from './icons'
import { PressableScale } from './PressableScale'
import {
  DISPLAY_FACETS,
  type Facet,
  type FacetConfig,
  FILTER_FACETS,
  MORE_FACETS,
  type TaskFiltersSheetProps,
  useTaskFilterFacets,
} from './task-filter-facets'

export type { TaskFiltersSheetProps } from './task-filter-facets'

export function TaskFiltersSheet(props: TaskFiltersSheetProps) {
  const { visible, filter, showDone, showAgentTasks, onShowDone, onShowAgentTasks, onClose } = props
  const [step, setStep] = useState<Facet | null>(null)
  const { configs, set, reset, activeCount } = useTaskFilterFacets(props)
  const current = step ? (configs[step] ?? null) : null
  const close = () => {
    setStep(null)
    onClose()
  }

  return (
    <BottomSheet
      visible={visible}
      onClose={close}
      mode="fit"
      scrollable
      contentStyle={styles.content}
      head={
        <View style={styles.head}>
          {step ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Back to filters"
              onPress={() => setStep(null)}
              style={styles.back}
            >
              <Icon as={ChevronLeft} size={16} color={color.textDim} />
            </PressableScale>
          ) : null}
          <View style={styles.headCopy}>
            <Text style={styles.title}>{current?.label ?? 'Filter and display'}</Text>
            {!current && activeCount > 0 ? (
              <Text style={styles.summary}>{activeCount} active</Text>
            ) : null}
          </View>
          {!current && activeCount > 0 ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Reset task filters"
              onPress={reset}
              style={styles.clear}
            >
              <Text style={styles.clearText}>Reset</Text>
            </PressableScale>
          ) : null}
        </View>
      }
    >
      {current ? (
        <OptionList
          options={current.options}
          selected={current.value}
          onPick={(value) => {
            current.apply(value)
            setStep(null)
          }}
        />
      ) : (
        <View style={styles.groups}>
          <View style={styles.group}>
            {FILTER_FACETS.filter((facet) => configs[facet]).map(renderFacet)}
          </View>
          <View style={styles.group}>
            {DISPLAY_FACETS.map(renderFacet)}
            <ToggleRow label="Show done" value={showDone} onChange={onShowDone} />
            <ToggleRow
              label="Show agent tasks"
              hint="Internal work at the top level"
              value={showAgentTasks}
              onChange={onShowAgentTasks}
            />
          </View>
          <View style={styles.group}>
            {MORE_FACETS.map(renderFacet)}
            <ToggleRow
              label="Archived"
              value={filter.archived === true}
              onChange={(value) => set('archived', value || undefined)}
            />
            <ToggleRow
              label="Deleted"
              value={filter.deleted === true}
              onChange={(value) => set('deleted', value || undefined)}
            />
          </View>
        </View>
      )}
    </BottomSheet>
  )

  function renderFacet(facet: Facet, index: number) {
    const config = configs[facet]
    if (!config) return null
    return (
      <NativePicker
        key={facet}
        label={config.label}
        options={config.options}
        selected={config.value}
        onSelect={config.apply}
        onOpenFallback={() => setStep(facet)}
      >
        {(onPress) => (
          <FilterRow
            label={config.label}
            value={optionLabel(config)}
            divider={index > 0}
            onPress={onPress}
          />
        )}
      </NativePicker>
    )
  }
}

function optionLabel(config: FacetConfig): string {
  return config.options.find((option) => option.value === config.value)?.label ?? 'Any'
}

function FilterRow({
  label,
  value,
  divider,
  onPress,
}: {
  label: string
  value: string
  divider: boolean
  onPress?: () => void
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${value}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, divider && styles.divider, pressed && styles.pressed]}
    >
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value}
      </Text>
      <Icon as={ChevronRight} size={14} color={color.textMicro} />
    </PressableScale>
  )
}

export function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint?: string
  value: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <View style={[styles.row, styles.divider]}>
      <View style={styles.toggleCopy}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      <Switch
        accessibilityLabel={label}
        accessibilityHint={hint}
        value={value}
        onValueChange={onChange}
      />
    </View>
  )
}

function OptionList({
  options,
  selected,
  onPick,
}: {
  options: readonly NativePickerOption[]
  selected: string
  onPick: (value: string) => void
}) {
  return (
    <View style={styles.group}>
      {options.map((option, index) => (
        <PressableScale
          key={option.value}
          accessibilityRole="button"
          accessibilityLabel={option.label}
          accessibilityState={{ selected: option.value === selected }}
          aria-pressed={option.value === selected}
          onPress={() => onPick(option.value)}
          style={({ pressed }) => [
            styles.row,
            index > 0 && styles.divider,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.rowLabel}>{option.label}</Text>
          {option.value === selected ? <Text style={styles.check}>✓</Text> : null}
        </PressableScale>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.md, paddingBottom: space.sm },
  head: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    gap: space.sm,
  },
  back: {
    width: 44,
    height: 44,
    marginLeft: -space.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headCopy: { flex: 1, minWidth: 0, gap: 2 },
  title: { ...sans(600), color: color.text, fontSize: font.body },
  summary: { ...mono(400), color: color.textFaint, fontSize: font.micro },
  clear: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.sm },
  clearText: { ...sans(500), color: color.accentTint, fontSize: font.small },
  groups: { gap: space.md },
  group: {
    overflow: 'hidden',
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.hairline },
  pressed: { backgroundColor: color.surfacePressed },
  rowLabel: { ...sans(500), flex: 1, color: color.text, fontSize: font.small },
  rowValue: {
    ...mono(400),
    maxWidth: '48%',
    color: color.textDim,
    fontSize: font.micro,
  },
  toggleCopy: { flex: 1, minWidth: 0, gap: 2 },
  hint: { ...sans(400), color: color.textFaint, fontSize: font.tiny },
  check: { ...monoLabel(), color: color.accentTint },
})
