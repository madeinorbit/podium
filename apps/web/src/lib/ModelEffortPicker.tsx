import { ChevronDown, Cpu, Gauge } from 'lucide-react'
import type { MachineId } from '@podium/model'
import type { ComponentProps, JSX, ReactNode } from 'react'
import { forwardRef } from 'react'
import { Button } from '@/components/ui/button'
import {
  AUTO,
  allConnectorModelLabel,
  allConnectorModelOptions,
  decodeModelPick,
  effortLabel,
  effortOptionsForModel,
  encodeModelPick,
  modelLabel,
  modelOptions,
} from './agent-models'
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
type Variant = 'pill' | 'field' | 'composer'

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
      {/* The same glyph `Select` uses (components/ui/select.tsx). This is a
          field-shaped trigger for a menu that opens DOWNWARD, sitting in a
          Settings row directly above real Selects — ChevronsUpDown promised a
          different interaction and delivered the same one, which is two control
          languages for one control. The `pill` variant carries no chevron at
          all and is unaffected. */}
      <ChevronDown size={14} aria-hidden="true" className="shrink-0 opacity-50" />
    </Button>
  ) : variant === 'composer' ? (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        'h-7 gap-1 rounded-none px-2.5 font-mono text-[11px] font-normal text-text-dim hover:bg-accent hover:text-text-strong',
        className,
      )}
      {...props}
    >
      {/* The label is its own truncating box (POD-1224). A bare text node in a
          flex button is an anonymous flex item, so `text-overflow` has nothing
          to apply to — inside a fixed-width well (the issue rail's launch box is
          232px) a long model name pushed the chevron out of the segment instead
          of ellipsising. */}
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDown size={13} aria-hidden="true" className="text-text-faint" />
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
  className,
  machineId,
}: {
  agentKind: IssueAgentKind
  value: string
  onChange: (value: string) => void
  variant?: Variant
  /** Trigger classes — how a caller sizes the segment inside its own row. */
  className?: string
  /** Machine whose installed harness answers the catalog. */
  machineId?: MachineId
}): JSX.Element {
  // Live models from the agent's own CLI (grok/cursor/opencode), fetched + cached by
  // the server; falls back to the static catalog for claude/codex or before it loads.
  const live = useModelCatalog(machineId)[agentKind]
  return (
    <PropertyMenu
      trigger={
        <PickerTrigger
          variant={variant}
          icon={cpuIcon}
          label={modelLabel(agentKind, value, live)}
          aria-label="Model"
          {...(className ? { className } : {})}
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

/**
 * Superagent prompt-box model menu: every connector's models in one list.
 * `auto` means "whatever Settings → Superagent says". A concrete pick names
 * both the harness and the model so the next turn can switch connectors.
 */
export function AllConnectorsModelPicker({
  agentKind,
  value,
  onChange,
  variant = 'pill',
  machineId,
}: {
  /** Currently selected (or frozen) harness — scopes free-text custom models. */
  agentKind: IssueAgentKind | undefined
  value: string
  onChange: (pick: { agentKind?: IssueAgentKind; model: string }) => void
  variant?: Variant
  machineId?: MachineId
}): JSX.Element {
  const live = useModelCatalog(machineId)
  const selected = value && value !== AUTO && agentKind ? encodeModelPick(agentKind, value) : AUTO
  return (
    <PropertyMenu
      trigger={
        <PickerTrigger
          variant={variant}
          icon={cpuIcon}
          label={allConnectorModelLabel(agentKind, value, live)}
          aria-label="Model"
        />
      }
      options={allConnectorModelOptions(live)}
      selectedValue={selected}
      allowFreeText
      placeholder="Model name…"
      onSelect={(next) => {
        const decoded = decodeModelPick(next)
        if (decoded.agentKind || decoded.model === AUTO) {
          onChange(decoded)
          return
        }
        // Free-text slug: keep the current connector if one is selected.
        // Auto stays Auto — the slug rides the Settings default harness,
        // rather than silently pinning Claude.
        onChange({
          ...(agentKind ? { agentKind } : {}),
          model: decoded.model,
        })
      }}
    />
  )
}

export function EffortPicker({
  agentKind,
  model,
  value,
  onChange,
  variant = 'pill',
  className,
  machineId,
}: {
  agentKind: IssueAgentKind
  /** The currently-selected model — effort is scoped to it. */
  model: string
  value: string
  onChange: (value: string) => void
  variant?: Variant
  /** Trigger classes — how a caller sizes the segment inside its own row. */
  className?: string
  machineId?: MachineId
}): JSX.Element | null {
  const live = useModelCatalog(machineId)[agentKind]
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
          {...(className ? { className } : {})}
        />
      }
      options={options}
      selectedValue={value || 'auto'}
      placeholder="Effort…"
      onSelect={onChange}
    />
  )
}
