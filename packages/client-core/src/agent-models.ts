import {
  BUNDLED_DESCRIPTORS,
  DESCRIPTOR_AUTO,
  effortLevelLabel,
  effortOptionsForDescriptor,
  isEffortValidForDescriptor,
  modelLabelForDescriptor,
  modelOptionsForDescriptor,
  parseServedDescriptors,
  resolveDescriptors,
} from '@podium/harness/browser'
import type { HarnessDescriptorWire, ModelChoiceWire } from '@podium/protocol'
import { type AgentKind, DEFAULT_HARNESS_AGENT } from '@podium/model/browser'

export {
  draftForLaunchContext,
  lastLaunchPick,
  readLastLaunchPicks,
  rememberLaunchPick,
  type LaunchPickContext,
} from './launch-pick'

/**
 * Pure harness/model/effort picker rules shared by web and mobile (POD-6028):
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

/**
 * The default harness (POD-4737): the named product policy
 * (`DEFAULT_HARNESS_AGENT` in `@podium/model` — Claude is the default for new
 * work), not the registry's first row, so a reorder can never silently change
 * the default and the two can never drift.
 */
export function issueDefaultAgentKind(value: string | null | undefined): IssueAgentKind {
  return issueAgentKind(value) ?? DEFAULT_HARNESS_AGENT
}

/** Picker label for a harness: the descriptor label, or the wire id when new. */
export function issueAgentLabel(
  value: string | null | undefined,
  descriptors?: readonly HarnessDescriptorWire[],
): string {
  if (!value) value = issueDefaultAgentKind(undefined)
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

/** Harness options before each app adds its presentation (icons, native rows). */
export function issueAgentOptions(
  defaultAgent: string | null | undefined,
  descriptors?: readonly HarnessDescriptorWire[],
): CatalogOption[] {
  const defaultKind = issueDefaultAgentKind(defaultAgent)
  return [
    { value: '', label: `${issueAgentLabel(defaultKind, descriptors)} (default)` },
    ...agentDescriptors(descriptors)
      .filter((descriptor) => descriptor.kind !== 'shell' && descriptor.kind !== defaultKind)
      .map((descriptor) => ({ value: descriptor.kind, label: descriptor.label })),
  ]
}

export const issueAgentDescriptors = agentDescriptors

/** Display a stored effort even when there are no levels to offer. */
export function effortLabel(_kind: string, value: string | null | undefined): string {
  return !value || value === AUTO ? 'Auto' : effortLevelLabel(value)
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

export { effortLevelLabel }

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
 * Would this harness accept this effort? The per-KIND ladder is the fallback,
 * but a single model may carry rungs the kind's generic list does not (codex
 * frontier models have `max`/`ultra`), and a live catalog can add per-model rungs. Launch drafts use
 * `draftForReportedModels` to validate against the selected model itself.
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
    // Live only (POD-3911): a harness the machine has not reported models for
    // contributes nothing here — Auto above still launches it.
    for (const model of catalog?.[descriptor.kind] ?? []) {
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

/** One reported model, as the live catalog carries it. */
export interface ReportedModel {
  value: string
  efforts?: readonly string[]
}

/**
 * THE BOX ONLY LAUNCHES WHAT THE MACHINE SAYS IT CAN RUN (POD-3911).
 *
 * The model and effort pills are the operator's own choice, so the server
 * refuses an unknown one rather than guessing. A pill can still go stale under
 * them: a draft saved weeks ago, or a project switch that moved the launch to a
 * machine with a different model list. Without this the launch was refused for
 * a value the operator never chose on this machine.
 *
 * So once the selected machine has REPORTED its models for this harness, the
 * draft is brought into line with that list, visibly, in the pills:
 *  - a model the list does not contain goes back to Auto, and its effort with it;
 *  - an effort goes back to Auto unless the model is concrete AND the list names
 *    that effort for it — the only case the effort pill offers a choice.
 *
 * Nothing changes while the list is still loading or was never reported: then
 * the server cannot check the value either, and it passes. Returns `undefined`
 * when the draft already agrees, so the caller can skip the write.
 */
export function draftForReportedModels<T extends { model: string; effort: string }>(
  draft: T,
  reported: readonly ReportedModel[] | undefined,
): T | undefined {
  const known = reported !== undefined && reported.length > 0
  const model = draft.model || 'auto'
  const effort = draft.effort || 'auto'
  if (model === 'auto') {
    return effort === 'auto' ? undefined : { ...draft, effort: 'auto' }
  }
  if (!known) return undefined
  const entry = reported.find((candidate) => candidate.value === model)
  if (!entry) return { ...draft, model: 'auto', effort: 'auto' }
  if (effort !== 'auto' && !entry.efforts?.includes(effort)) return { ...draft, effort: 'auto' }
  return undefined
}
