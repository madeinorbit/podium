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
import type { AgentKind } from '@podium/model'

/**
 * Cross-harness model + effort catalogs for the phone launch sheet (POD-4475):
 * one source, read from descriptors — the served report over the bundled
 * copy — instead of the duplicated static tables web and mobile used to keep.
 *
 * Values are what each CLI actually accepts. `'auto'` means "no override".
 */

export type IssueAgentKind = Exclude<AgentKind, 'shell'>

/**
 * The harnesses THIS BUILD knows, derived from the bundled descriptors —
 * never a second hand-written list. Order follows the registry.
 */
export const ISSUE_AGENT_KINDS: readonly IssueAgentKind[] = BUNDLED_DESCRIPTORS.map(
  (d) => d.kind as IssueAgentKind,
)

/** The default harness: the registry's first row (index, not a literal). */
export function issueDefaultAgentKind(value: string | null | undefined): IssueAgentKind {
  return issueAgentKind(value) ?? ISSUE_AGENT_KINDS[0]!
}

/** Picker label for a harness: the descriptor label, or the wire id when new. */
export function issueAgentLabel(
  value: string | null | undefined,
  descriptors?: readonly HarnessDescriptorWire[],
): string {
  if (!value) return agentDescriptors(descriptors)[0]?.label ?? ''
  return agentDescriptors(descriptors).find((d) => d.kind === value)?.label ?? value
}

export const AUTO = DESCRIPTOR_AUTO

export interface ModelChoice {
  value: string
  label: string
  efforts?: string[]
}

export interface CatalogOption {
  value: string
  label: string
  group?: string
}

/**
 * Resolve the descriptor list a sheet renders: served over bundled, so an
 * older client shows a newer harness inside the schema it already has.
 */
export function agentDescriptors(
  served: readonly HarnessDescriptorWire[] | undefined,
): HarnessDescriptorWire[] {
  return resolveDescriptors(parseServedDescriptors(served ?? []))
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

export function issueAgentKind(value: string | null | undefined): IssueAgentKind | null {
  return ISSUE_AGENT_KINDS.find((kind) => kind === value) ?? null
}

export function agentSupportsEffort(
  kind: IssueAgentKind | string,
  descriptors?: readonly HarnessDescriptorWire[],
): boolean {
  return descriptorFor(kind, descriptors)?.capabilities.effort ?? false
}

function withAuto(choices: { value: string; label: string }[]): CatalogOption[] {
  return [{ value: AUTO, label: 'Auto' }, ...choices]
}

function agentModels(
  kind: IssueAgentKind | string,
  live: readonly ModelChoice[] | undefined,
  descriptors: readonly HarnessDescriptorWire[] | undefined,
): readonly ModelChoice[] {
  const descriptor = descriptorFor(kind, descriptors)
  if (!descriptor) return []
  return descriptorModels(
    descriptor,
    live as readonly ModelChoiceWire[] | undefined,
  ) as readonly ModelChoice[]
}

export { effortLevelLabel }

export function effortOptions(
  kind: IssueAgentKind | string,
  descriptors?: readonly HarnessDescriptorWire[],
): CatalogOption[] {
  const descriptor = descriptorFor(kind, descriptors)
  if (!descriptor) return []
  return [...effortOptionsForDescriptor(descriptor)]
}

export function effortOptionsForModel(
  kind: IssueAgentKind | string,
  modelValue: string | null | undefined,
  live?: readonly ModelChoice[],
  descriptors?: readonly HarnessDescriptorWire[],
): CatalogOption[] {
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

export function modelOptions(
  kind: IssueAgentKind | string,
  live?: readonly ModelChoice[],
  descriptors?: readonly HarnessDescriptorWire[],
): CatalogOption[] {
  const descriptor = descriptorFor(kind, descriptors)
  if (!descriptor) return [{ value: AUTO, label: 'Auto' }]
  return [...modelOptionsForDescriptor(descriptor, live as readonly ModelChoiceWire[] | undefined)]
}

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

/**
 * Would this harness accept this effort? The per-KIND ladder is the floor,
 * but a single model may carry rungs the kind's generic list does not (codex
 * frontier models have `max`/`ultra`), and once a live catalog is in hand its
 * per-model `efforts` are the authority.
 */
export function isEffortValid(
  kind: IssueAgentKind | string,
  value: string | null | undefined,
  live?: readonly ModelChoice[],
  descriptors?: readonly HarnessDescriptorWire[],
): boolean {
  const descriptor = descriptorFor(kind, descriptors)
  if (!descriptor) return !value || value === AUTO
  return isEffortValidForDescriptor(
    descriptor,
    value,
    live as readonly ModelChoiceWire[] | undefined,
  )
}

const MODEL_PICK_SEP = ':'

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
  const kind = issueAgentKind(value.slice(0, sep))
  if (!kind) return { model: value }
  return { agentKind: kind, model: value.slice(sep + 1) }
}

export function allConnectorModelOptions(
  catalog?: Record<string, readonly ModelChoice[] | undefined>,
  descriptors?: readonly HarnessDescriptorWire[],
): CatalogOption[] {
  const options: CatalogOption[] = [{ value: AUTO, label: 'Auto' }]
  for (const descriptor of agentDescriptors(descriptors)) {
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

/** Consecutive options that share a `group`, so a select can render section headers. */
export function groupedCatalogOptions(
  options: readonly CatalogOption[],
): { label?: string; options: CatalogOption[] }[] {
  const groups: { label?: string; options: CatalogOption[] }[] = []
  for (const option of options) {
    const last = groups[groups.length - 1]
    if (last && last.label === option.group) {
      last.options.push(option)
    } else {
      groups.push({ ...(option.group ? { label: option.group } : {}), options: [option] })
    }
  }
  return groups
}

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

/** Values the spawn layer should send. `auto` is omitted — the server treats
 *  that sentinel as "no opinion" rather than a model named auto. */
export function spawnSelection(
  pick: string,
  effort: string,
): {
  agentKind?: IssueAgentKind
  model?: string
  effort?: string
} {
  const decoded = decodeModelPick(pick)
  return {
    ...(decoded.agentKind ? { agentKind: decoded.agentKind } : {}),
    ...(decoded.model && decoded.model !== AUTO ? { model: decoded.model } : {}),
    ...(effort && effort !== AUTO ? { effort } : {}),
  }
}

/**
 * Substring filter over a flat catalog, matched against the harness name as
 * well as the model label — "claude" should find Claude Code's models, and
 * "opus" should find OpenCode's Claude entry too. Case- and separator-tolerant
 * because nobody types `gpt-5.6-sol` on a phone keyboard.
 */
export function filterCatalogOptions(
  options: readonly CatalogOption[],
  query: string,
): CatalogOption[] {
  const needle = query
    .trim()
    .toLowerCase()
    .replace(/[\s._-]+/g, '')
  if (!needle) return [...options]
  return options.filter((option) => {
    const hay = `${option.group ?? ''}${option.label}`.toLowerCase().replace(/[\s._-]+/g, '')
    return hay.includes(needle)
  })
}
