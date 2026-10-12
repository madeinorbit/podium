import { ChevronDown, Cpu, Gauge } from 'lucide-react'
import type { MachineId } from '@podium/model'
import type { ComponentProps, JSX, ReactNode } from 'react'
import { forwardRef } from 'react'
import { Button } from '@/components/ui/button'
import {
  AUTO,
  agentSupportsEffort,
  allConnectorModelLabel,
  allConnectorModelOptions,
  decodeModelPick,
  effortLabel,
  effortOptionsForModel,
  encodeModelPick,
  modelLabel,
  modelOptions,
} from '@podium/client-core/agent-models'
import type { IssueAgentKind } from './issue-agents'
import { PropertyMenu } from './PropertyMenu'
import { useModelCatalog, useModelCatalogState } from './use-model-catalog'
import { useHarnessDescriptors } from './use-harness-descriptors'
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
  disabled = false,
  allowFreeText = false,
}: {
  agentKind: IssueAgentKind
  value: string
  onChange: (value: string) => void
  variant?: Variant
  /** Trigger classes — how a caller sizes the segment inside its own row. */
  className?: string
  /** Machine whose installed harness answers the catalog. */
  machineId?: MachineId
  disabled?: boolean
  /** Offer "Use “…”" for a typed model name. Off where the menu must hold only
   *  what the machine reported — the new-task box (POD-3911). Settings keeps it
   *  for managed accounts, which report no list. */
  allowFreeText?: boolean
}): JSX.Element {
  // Live models as the machine's own harness reports them, fetched and cached by
  // the server. Nothing else is offered (POD-3911): until the list arrives, or if
  // it never does, the menu is Auto plus a line saying why — Auto always launches.
  const { catalog, status } = useModelCatalogState(machineId)
  const live = catalog[agentKind]
  // Served harness descriptors (POD-4475): names and effort support from the
  // machine's report, bundled fallback offline.
  const { served } = useHarnessDescriptors(machineId)
  const footnote =
    live && live.length > 0
      ? undefined
      : status === 'loading'
        ? 'Loading models from this machine…'
        : 'This machine has not reported its models. Auto lets the agent choose.'
  return (
    <PropertyMenu
      trigger={
        <PickerTrigger
          variant={variant}
          icon={cpuIcon}
          label={modelLabel(agentKind, value, live, served)}
          aria-label="Model"
          disabled={disabled}
          {...(className ? { className } : {})}
        />
      }
      options={modelOptions(agentKind, live, served)}
      selectedValue={value || 'auto'}
      allowFreeText={allowFreeText}
      placeholder={allowFreeText ? 'Model name…' : 'Filter…'}
      {...(footnote ? { footnote } : {})}
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
  const { served } = useHarnessDescriptors(machineId)
  const selected = value && value !== AUTO && agentKind ? encodeModelPick(agentKind, value) : AUTO
  return (
    <PropertyMenu
      trigger={
        <PickerTrigger
          variant={variant}
          icon={cpuIcon}
          label={allConnectorModelLabel(agentKind, value, live, served)}
          aria-label="Model"
        />
      }
      options={allConnectorModelOptions(live, served)}
      selectedValue={selected}
      allowFreeText={false}
      placeholder="Filter…"
      onSelect={(next) => {
        onChange(decodeModelPick(next))
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
  disabled = false,
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
  disabled?: boolean
}): JSX.Element | null {
  const live = useModelCatalog(machineId)[agentKind]
  const { served } = useHarnessDescriptors(machineId)
  // Effort is offered only for a concrete model whose levels the live catalog
  // lists (POD-3911). Otherwise the pill stays and reads Auto: the row keeps its
  // shape across model changes, and the operator can see effort is the agent's
  // call rather than wonder where the control went. A harness with no effort
  // flag at all (Cursor) has nothing to show.
  const options = effortOptionsForModel(agentKind, model, live, served)
  if (options.length === 0) {
    if (!agentSupportsEffort(agentKind, served)) return null
    return (
      <PickerTrigger
        variant={variant}
        icon={gaugeIcon}
        // The stored value, not a hard "Auto": a saved level the picker cannot
        // offer still rides the launch, and the pill must not hide that.
        label={effortLabel(agentKind, value)}
        aria-label="Effort"
        title={
          !model || model === AUTO
            ? 'Pick a model to choose its effort'
            : 'This model reports no effort levels'
        }
        disabled
        {...(className ? { className } : {})}
      />
    )
  }
  return (
    <PropertyMenu
      trigger={
        <PickerTrigger
          variant={variant}
          icon={gaugeIcon}
          label={effortLabel(agentKind, value)}
          aria-label="Effort"
          disabled={disabled}
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
