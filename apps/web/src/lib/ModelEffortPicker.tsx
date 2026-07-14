import { ChevronsUpDown, Cpu, Gauge } from 'lucide-react'
import type { ComponentProps, JSX, ReactNode } from 'react'
import { forwardRef } from 'react'
import { Button } from '@/components/ui/button'
import { effortLabel, effortOptionsForModel, modelLabel, modelOptions } from './agent-models'
import type { IssueAgentKind } from './issue-agents'
import { PropertyMenu } from './PropertyMenu'
import { useModelCatalog } from './use-model-catalog'
import { cn } from './utils'

/**
 * Reusable Model + Effort pickers, backed by the per-agent `agent-models` catalog.
 * Shared by the New Issue composer, the issue Start controls, and the Settings
 * screen so all three read the same real model/effort lists (default `auto`).
 *
 * Two trigger shapes:
 *  - `pill`  — a small rounded outline pill, matching the composer's property row.
 *  - `field` — a full-width select-style control, matching a Settings `Row`.
 */
type Variant = 'pill' | 'field'

const PickerTrigger = forwardRef<
  HTMLButtonElement,
  Omit<ComponentProps<typeof Button>, 'variant'> & {
    variant?: Variant
    icon: ReactNode
    label: string
  }
>(({ variant = 'pill', icon, label, className, ...props }, ref) =>
  variant === 'field' ? (
    <Button
      ref={ref}
      type="button"
      variant="outline"
      size="sm"
      className={cn('w-full flex-1 justify-between font-normal', className)}
      {...props}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      <ChevronsUpDown size={14} aria-hidden="true" className="shrink-0 opacity-50" />
    </Button>
  ) : (
    <Button
      ref={ref}
      type="button"
      variant="outline"
      size="sm"
      className={cn('h-6 gap-1 rounded-full px-2 text-[12px] font-normal', className)}
      {...props}
    >
      {icon}
      {label}
    </Button>
  ),
)
PickerTrigger.displayName = 'PickerTrigger'

const cpuIcon = <Cpu size={13} aria-hidden="true" className="text-muted-foreground" />
const gaugeIcon = <Gauge size={13} aria-hidden="true" className="text-muted-foreground" />

export function ModelPicker({
  agentKind,
  value,
  onChange,
  variant = 'pill',
}: {
  agentKind: IssueAgentKind
  value: string
  onChange: (value: string) => void
  variant?: Variant
}): JSX.Element {
  // Live models from the agent's own CLI (grok/cursor/opencode), fetched + cached by
  // the server; falls back to the static catalog for claude/codex or before it loads.
  const live = useModelCatalog()[agentKind]
  return (
    <PropertyMenu
      trigger={
        <PickerTrigger
          variant={variant}
          icon={cpuIcon}
          label={modelLabel(agentKind, value, live)}
          aria-label="Model"
        />
      }
      options={modelOptions(agentKind, live)}
      selectedValue={value || 'auto'}
      allowFreeText
      placeholder="Model name…"
      onSelect={onChange}
    />
  )
}

export function EffortPicker({
  agentKind,
  model,
  value,
  onChange,
  variant = 'pill',
}: {
  agentKind: IssueAgentKind
  /** The currently-selected model — effort is scoped to it. */
  model: string
  value: string
  onChange: (value: string) => void
  variant?: Variant
}): JSX.Element | null {
  const live = useModelCatalog()[agentKind]
  // Auto model uses the agent's effort ladder; a concrete model can narrow it or
  // explicitly report no effort support (e.g. Claude Haiku).
  const options = effortOptionsForModel(agentKind, model, live)
  if (options.length === 0) return null
  return (
    <PropertyMenu
      trigger={
        <PickerTrigger
          variant={variant}
          icon={gaugeIcon}
          label={effortLabel(agentKind, value)}
          aria-label="Effort"
        />
      }
      options={options}
      selectedValue={value || 'auto'}
      placeholder="Effort…"
      onSelect={onChange}
    />
  )
}
