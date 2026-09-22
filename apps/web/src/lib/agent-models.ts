import {
  BUNDLED_DESCRIPTORS,
  DESCRIPTOR_AUTO,
  descriptorModels,
  effortLevelLabel,
  effortOptionsForDescriptor,
  isEffortValidForDescriptor,
  modelLabelForDescriptor,
  modelOptionsForDescriptor,
  parseServedDescriptors,
  resolveDescriptors,
} from '@podium/harness/browser'
import type { HarnessDescriptorWire, ModelChoiceWire } from '@podium/protocol'
import { issueAgentDescriptors, issueAgentLabel, type IssueAgentKind } from './issue-agents'
import type { PropertyOption } from './PropertyMenu'

/**
 * Per-harness model + reasoning-effort catalogs (POD-4475): one source, read
 * from descriptors — the served report over the bundled copy — instead of
 * the duplicated static tables web and mobile used to keep.
 *
 * Values are what each agent's CLI actually accepts; `'auto'` is the sentinel
 * for "let the agent decide" (the spawn layer passes no flag). The model
 * lists stay curated fallbacks; the pickers keep a free-text escape hatch so
 * any model string still works. A non-empty live list (the server's probe of
 * the machine's own CLIs) replaces the static list per harness.
 */

/** Stored sentinel meaning "no override — the agent/harness decides". */
export const AUTO = DESCRIPTOR_AUTO

export interface ModelChoice {
  value: string
  label: string
  /** Per-model effort levels, when the source reports them authoritatively.
   *  `[]` = the model supports no effort; `undefined` = unknown (harness fallback). */
  efforts?: string[]
}

/** The bundled resolution: every harness this build knows, no machine. */
const BUNDLED_RESOLVED: readonly HarnessDescriptorWire[] = resolveDescriptors([])

function resolved(
  descriptors: readonly HarnessDescriptorWire[] | undefined,
): readonly HarnessDescriptorWire[] {
  if (!descriptors) return BUNDLED_RESOLVED
  return resolveDescriptors(parseServedDescriptors(descriptors))
}

function descriptorFor(
  kind: IssueAgentKind | string,
  descriptors: readonly HarnessDescriptorWire[] | undefined,
): HarnessDescriptorWire | undefined {
  return resolved(descriptors).find((d) => d.kind === kind)
}

/** True when the harness exposes a reasoning-effort flag. */
export function agentSupportsEffort(
  kind: IssueAgentKind | string,
  descriptors?: readonly HarnessDescriptorWire[],
): boolean {
  return descriptorFor(kind, descriptors)?.capabilities.effort ?? false
}

/** Model options for a `PropertyMenu`/`Select`, with the `auto` default first.
 *  Pass `live` (the server's live catalog for this harness) to override the static list. */
export function modelOptions(
  kind: IssueAgentKind | string,
  live?: readonly ModelChoice[],
  descriptors?: readonly HarnessDescriptorWire[],
): PropertyOption[] {
  const descriptor = descriptorFor(kind, descriptors)
  if (!descriptor) return [{ value: AUTO, label: 'Auto' }]
  return [...modelOptionsForDescriptor(descriptor, live as readonly ModelChoiceWire[] | undefined)]
}

/** Effort options for a `PropertyMenu`/`Select`, with the `auto` default first. */
export function effortOptions(
  kind: IssueAgentKind | string,
  descriptors?: readonly HarnessDescriptorWire[],
): PropertyOption[] {
  const descriptor = descriptorFor(kind, descriptors)
  if (!descriptor) return []
  return [...effortOptionsForDescriptor(descriptor)]
}

/**
 * Effort options for the selected model. Automatic model selection still accepts an
 * explicit harness effort, so it uses the harness ladder. When the live
 * catalog reports model-specific levels, those are authoritative: a model with
 * `[]` offers no effort. Models without such metadata fall back to the
 * harness ladder. Empty result = hide the effort picker.
 */
export function effortOptionsForModel(
  kind: IssueAgentKind | string,
  modelValue: string | null | undefined,
  live?: readonly ModelChoice[],
  descriptors?: readonly HarnessDescriptorWire[],
): PropertyOption[] {
  const descriptor = descriptorFor(kind, descriptors)
  if (!descriptor) return []
  return [
    ...effortOptionsForDescriptor(
      descriptor,
      modelValue,
      live as readonly ModelChoiceWire[] | undefined,
    ),
  ]
}

/** Display label for a stored model value; checks live models first, falls back to the
 *  raw value for a custom (free-text) model, and 'Auto' for the sentinel/empty. */
export function modelLabel(
  kind: IssueAgentKind | string,
  value: string | null | undefined,
  live?: readonly ModelChoice[],
  descriptors?: readonly HarnessDescriptorWire[],
): string {
  const descriptor = descriptorFor(kind, descriptors)
  if (!descriptor) {
    if (!value || value === AUTO) return 'Auto'
    return value
  }
  return modelLabelForDescriptor(descriptor, value, live as readonly ModelChoiceWire[] | undefined)
}

/** Display label for a stored effort value; 'Auto' for the sentinel/empty. */
export function effortLabel(_kind: IssueAgentKind | string, value: string | null | undefined): string {
  if (!value || value === AUTO) return 'Auto'
  return effortLevelLabel(value)
}

/** Whether an effort value is offered for this harness — used to reset a stale effort
 *  when the effective agent changes. */
export function isEffortValid(
  kind: IssueAgentKind | string,
  value: string | null | undefined,
  descriptors?: readonly HarnessDescriptorWire[],
): boolean {
  const descriptor = descriptorFor(kind, descriptors)
  if (!descriptor) return !value || value === AUTO
  return isEffortValidForDescriptor(descriptor, value)
}

const MODEL_PICK_SEP = ':'

/** Namespaced picker value so "opus" on Claude and a custom "opus" on Cursor
 *  cannot collide in one menu. `auto` stays the un-namespaced sentinel. */
export function encodeModelPick(kind: IssueAgentKind | string, model: string): string {
  if (!model || model === AUTO) return AUTO
  return `${kind}${MODEL_PICK_SEP}${model}`
}

export function decodeModelPick(value: string | null | undefined): {
  agentKind?: IssueAgentKind
  model: string
} {
  if (!value || value === AUTO) return { model: AUTO }
  const sep = value.indexOf(MODEL_PICK_SEP)
  if (sep <= 0) return { model: value }
  const kind = BUNDLED_DESCRIPTORS.some((d) => d.kind === value.slice(0, sep))
    ? (value.slice(0, sep) as IssueAgentKind)
    : undefined
  if (!kind) return { model: value }
  return { agentKind: kind, model: value.slice(sep + 1) }
}

/** Every harness's models, grouped, with Auto first. Live catalog wins per
 *  harness when the server has enumerated it. Iterates DESCRIPTORS, never a
 *  closed list, so a newer harness appears without a client change. */
export function allConnectorModelOptions(
  catalog?: Record<string, readonly ModelChoice[] | undefined>,
  descriptors?: readonly HarnessDescriptorWire[],
): PropertyOption[] {
  const options: PropertyOption[] = [{ value: AUTO, label: 'Auto' }]
  for (const descriptor of issueAgentDescriptors(descriptors)) {
    if (descriptor.kind === 'shell') continue
    const group = descriptor.label
    for (const model of descriptorModels(
      descriptor,
      catalog?.[descriptor.kind] as readonly ModelChoiceWire[] | undefined,
    )) {
      options.push({
        value: encodeModelPick(descriptor.kind, model.value),
        label: model.label,
        group,
      })
    }
  }
  return options
}

/** Pill label for a cross-connector pick: "Auto", or "Claude Code · Opus". */
export function allConnectorModelLabel(
  kind: IssueAgentKind | string | undefined,
  model: string | null | undefined,
  catalog?: Record<string, readonly ModelChoice[] | undefined>,
  descriptors?: readonly HarnessDescriptorWire[],
): string {
  if (!model || model === AUTO) return 'Auto'
  if (!kind) return model
  return `${issueAgentLabel(kind, descriptors)} · ${modelLabel(kind, model, catalog?.[kind], descriptors)}`
}
