import type { BoardFilter, IssuesOrdering } from '@podium/client-core/viewmodels'
import { ALL_ISSUE_STATUSES, ISSUE_STATUS_LABELS, type IssueStatus } from '@podium/model'
import { ChevronLeft, ChevronRight } from './icons'
import { useState } from 'react'
import { StyleSheet, Switch, Text, View } from 'react-native'
import { color, font, mono, monoLabel, radius, sans, space } from '../theme/theme'
import { BottomSheet } from './BottomSheet'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'
import { NativePicker, type NativePickerOption } from './action-sheet-native'

const ANY = '__any__'

type Facet = 'priority' | 'type' | 'assignee' | 'label' | 'status' | 'stage' | 'ordering'

interface FacetConfig {
  label: string
  value: string
  options: readonly NativePickerOption[]
  apply: (value: string) => void
}

export function TaskFiltersSheet({
  visible,
  filter,
  ordering,
  showAgentTasks,
  types,
  assignees,
  labels,
  onFilter,
  onOrdering,
  onShowAgentTasks,
  onClose,
}: {
  visible: boolean
  filter: BoardFilter
  ordering: IssuesOrdering
  showAgentTasks: boolean
  types: readonly string[]
  assignees: readonly string[]
  labels: readonly string[]
  onFilter: (filter: BoardFilter) => void
  onOrdering: (ordering: IssuesOrdering) => void
  onShowAgentTasks: (show: boolean) => void
  onClose: () => void
}) {
  const [step, setStep] = useState<Facet | null>(null)
  const set = <K extends keyof BoardFilter>(key: K, value: BoardFilter[K] | undefined) => {
    const next: BoardFilter = { ...filter }
    if (value === undefined) delete next[key]
    else Object.assign(next, { [key]: value })
    onFilter(next)
  }
  const configs: Record<Facet, FacetConfig> = {
    priority: {
      label: 'Priority',
      value: filter.priority == null ? ANY : String(filter.priority),
      options: [
        { value: ANY, label: 'Any priority' },
        ...[0, 1, 2, 3, 4].map((value) => ({ value: String(value), label: `P${value}` })),
      ],
      apply: (value) => set('priority', value === ANY ? undefined : Number(value)),
    },
    type: stringFacet('Type', filter.type, types, (value) => set('type', value)),
    assignee: stringFacet('Assignee', filter.assignee, assignees, (value) =>
      set('assignee', value),
    ),
    label: stringFacet('Label', filter.label, labels, (value) => set('label', value)),
    status: {
      label: 'State',
      value: filter.status ?? ANY,
      options: [
        { value: ANY, label: 'Any state' },
        { value: 'open', label: 'Open' },
        { value: 'closed', label: 'Closed' },
        { value: 'ready', label: 'Ready' },
        { value: 'blocked', label: 'Blocked' },
        { value: 'deferred', label: 'Deferred' },
      ],
      apply: (value) =>
        set('status', value === ANY ? undefined : (value as NonNullable<BoardFilter['status']>)),
    },
    stage: {
      label: 'Status',
      value: filter.stage ?? ANY,
      options: [
        { value: ANY, label: 'Any status' },
        ...ALL_ISSUE_STATUSES.map((value) => ({ value, label: ISSUE_STATUS_LABELS[value] })),
      ],
      apply: (value) => set('stage', value === ANY ? undefined : (value as IssueStatus)),
    },
    ordering: {
      label: 'Order',
      value: ordering,
      options: [
        { value: 'priority', label: 'Priority' },
        { value: 'updated', label: 'Recently updated' },
        { value: 'created', label: 'Recently created' },
      ],
      apply: (value) => onOrdering(value as IssuesOrdering),
    },
  }
  const current = step ? configs[step] : null
  const activeCount = Object.keys(filter).filter((key) => key !== 'text').length

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
            <Text style={styles.title}>{current?.label ?? 'Task filters'}</Text>
            {!current && activeCount > 0 ? (
              <Text style={styles.summary}>{activeCount} active</Text>
            ) : null}
          </View>
          {!current && activeCount > 0 ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Clear all task filters"
              onPress={() => onFilter(filter.text ? { text: filter.text } : {})}
              style={styles.clear}
            >
              <Text style={styles.clearText}>Clear all</Text>
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
        <View style={styles.group}>
          {(Object.keys(configs) as Facet[]).map((facet, index) => {
            const config = configs[facet]
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
          })}
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
          <ToggleRow
            label="Agent tasks"
            hint="Show internal work at the top level"
            value={showAgentTasks}
            onChange={onShowAgentTasks}
          />
        </View>
      )}
    </BottomSheet>
  )
}

function stringFacet(
  label: string,
  value: string | undefined,
  choices: readonly string[],
  setValue: (value: string | undefined) => void,
): FacetConfig {
  return {
    label,
    value: value ?? ANY,
    options: [
      { value: ANY, label: `Any ${label.toLowerCase()}` },
      ...choices.map((choice) => ({ value: choice, label: choice })),
    ],
    apply: (next) => setValue(next === ANY ? undefined : next),
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

function ToggleRow({
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
      <Switch value={value} onValueChange={onChange} />
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
