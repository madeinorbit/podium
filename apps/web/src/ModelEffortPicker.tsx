import { ChevronsUpDown, Cpu, Gauge } from 'lucide-react'
import type { ComponentProps, JSX, ReactNode } from 'react'
import { forwardRef } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  agentSupportsEffort,
  effortLabel,
  effortOptions,
  modelLabel,
  modelOptions,
} from './agent-models'
import type { IssueAgentKind } from './issue-agents'
import { PropertyMenu } from './PropertyMenu'

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
  return (
    <PropertyMenu
      trigger={
        <PickerTrigger
          variant={variant}
          icon={cpuIcon}
          label={modelLabel(agentKind, value)}
          aria-label="Model"
        />
      }
      options={modelOptions(agentKind)}
      selectedValue={value || 'auto'}
      allowFreeText
      placeholder="Model name…"
      onSelect={onChange}
    />
  )
}

export function EffortPicker({
  agentKind,
  value,
  onChange,
  variant = 'pill',
}: {
  agentKind: IssueAgentKind
  value: string
  onChange: (value: string) => void
  variant?: Variant
}): JSX.Element | null {
  // Cursor has no effort flag — nothing to pick.
  if (!agentSupportsEffort(agentKind)) return null
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
      options={effortOptions(agentKind)}
      selectedValue={value || 'auto'}
      placeholder="Effort…"
      onSelect={onChange}
    />
  )
}
