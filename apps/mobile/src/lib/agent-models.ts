import type { AgentKind } from '@podium/model'

/**
 * Cross-harness model + effort catalogs for the phone launch sheet.
 *
 * Same values the desktop picker uses (`apps/web/src/lib/agent-models.ts`):
 * aliases each CLI actually accepts. `'auto'` means "no override".
 */

export type IssueAgentKind = Exclude<AgentKind, 'shell'>

export const ISSUE_AGENT_KINDS = [
  'claude-code',
  'codex',
  'grok',
  'opencode',
  'cursor',
  'pi',
] as const satisfies readonly IssueAgentKind[]

export const ISSUE_AGENT_LABELS: Record<IssueAgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  pi: 'Pi',
}

export const AUTO = 'auto'

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

type Choice = { value: string; label: string }

const CLAUDE_GROK_EFFORT: Choice[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
]

const CODEX_EFFORT: Choice[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
]

/** Codex's newer frontier line carries two rungs the older models do not; the
 *  live catalog supersedes this the moment a probe answers. */
const CODEX_56_EFFORT: Choice[] = [...CODEX_EFFORT, { value: 'max', label: 'Max' }]
const CODEX_56_FRONTIER_EFFORT: Choice[] = [...CODEX_56_EFFORT, { value: 'ultra', label: 'Ultra' }]

/**
 * THE FALLBACK, NOT THE ANSWER.
 *
 * Every list below is what the sheet shows when no live probe has answered yet
 * — an older server with no `models` router, a cold start, or a dropped
 * connection. The authority is `useModelCatalog`, which reads the machine's own
 * installed harnesses. Keeping this table current still matters (it is what a
 * first open paints), but it must never be the only source: that is exactly the
 * staleness this issue is fixing.
 */
const AGENT_MODELS: Record<IssueAgentKind, ModelChoice[]> = {
  'claude-code': [
    { value: 'opus', label: 'Opus', efforts: CLAUDE_GROK_EFFORT.map((o) => o.value) },
    { value: 'sonnet', label: 'Sonnet', efforts: CLAUDE_GROK_EFFORT.map((o) => o.value) },
    { value: 'haiku', label: 'Haiku', efforts: [] },
  ],
  codex: [
    {
      value: 'gpt-5.6-sol',
      label: 'GPT-5.6-Sol',
      efforts: CODEX_56_FRONTIER_EFFORT.map((o) => o.value),
    },
    {
      value: 'gpt-5.6-terra',
      label: 'GPT-5.6-Terra',
      efforts: CODEX_56_FRONTIER_EFFORT.map((o) => o.value),
    },
    {
      value: 'gpt-5.6-luna',
      label: 'GPT-5.6-Luna',
      efforts: CODEX_56_EFFORT.map((o) => o.value),
    },
    { value: 'gpt-5.5', label: 'GPT-5.5', efforts: CODEX_EFFORT.map((o) => o.value) },
    { value: 'gpt-5.4', label: 'GPT-5.4', efforts: CODEX_EFFORT.map((o) => o.value) },
  ],
  grok: [
    { value: 'grok-4.5', label: 'Grok 4.5' },
    { value: 'grok-composer-2.5-fast', label: 'Composer 2.5 Fast' },
  ],
  opencode: [
    { value: 'openai/gpt-5.5', label: 'OpenAI GPT-5.5' },
    { value: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8' },
    { value: 'xai/grok-4.3', label: 'Grok 4.3' },
  ],
  cursor: [
    { value: 'composer-2.5', label: 'Composer 2.5' },
    { value: 'gpt-5.2', label: 'GPT-5.2' },
    { value: 'claude-opus-4-8-thinking-high', label: 'Claude Opus 4.8 Thinking' },
  ],
  // Live-enumerated via `pi --list-models`; no static fallback.
  pi: [],
}

const AGENT_EFFORTS: Record<IssueAgentKind, Choice[]> = {
  'claude-code': CLAUDE_GROK_EFFORT,
  grok: CLAUDE_GROK_EFFORT,
  codex: CODEX_EFFORT,
  opencode: [
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'max', label: 'Max' },
  ],
  cursor: [],
  pi: [
    { value: 'off', label: 'Off' },
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra high' },
    { value: 'max', label: 'Max' },
  ],
}

export function issueAgentKind(value: string | null | undefined): IssueAgentKind | null {
  return ISSUE_AGENT_KINDS.find((kind) => kind === value) ?? null
}

export function agentSupportsEffort(kind: IssueAgentKind): boolean {
  return AGENT_EFFORTS[kind].length > 0
}

function withAuto(choices: Choice[]): CatalogOption[] {
  return [{ value: AUTO, label: 'Auto' }, ...choices]
}

function agentModels(kind: IssueAgentKind, live?: readonly ModelChoice[]): readonly ModelChoice[] {
  return live && live.length > 0 ? live : AGENT_MODELS[kind]
}

const EFFORT_LEVEL_LABELS: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

export function effortLevelLabel(level: string): string {
  return EFFORT_LEVEL_LABELS[level] ?? level
}

export function effortOptions(kind: IssueAgentKind): CatalogOption[] {
  return withAuto(AGENT_EFFORTS[kind])
}

export function effortOptionsForModel(
  kind: IssueAgentKind,
  modelValue: string | null | undefined,
  live?: readonly ModelChoice[],
): CatalogOption[] {
  if (!modelValue || modelValue === AUTO) {
    return agentSupportsEffort(kind) ? effortOptions(kind) : []
  }
  const efforts = agentModels(kind, live).find((m) => m.value === modelValue)?.efforts
  if (efforts !== undefined) {
    if (efforts.length === 0) return []
    return withAuto(efforts.map((e) => ({ value: e, label: effortLevelLabel(e) })))
  }
  return agentSupportsEffort(kind) ? effortOptions(kind) : []
}

export function modelLabel(
  kind: IssueAgentKind,
  value: string | null | undefined,
  live?: readonly ModelChoice[],
): string {
  if (!value || value === AUTO) return 'Auto'
  return agentModels(kind, live).find((m) => m.value === value)?.label ?? value
}

/**
 * Would this harness accept this effort?
 *
 * The per-KIND table is the floor, but a single model may carry rungs the kind's
 * generic list does not (Codex's frontier line has `max` and `ultra`), and once
 * a live catalog is in hand its per-model `efforts` are the authority. Checking
 * only the generic table would silently reset a legitimate pick back to Auto the
 * moment the operator changed anything else on the sheet.
 */
export function isEffortValid(
  kind: IssueAgentKind,
  value: string | null | undefined,
  live?: readonly ModelChoice[],
): boolean {
  if (!value || value === AUTO) return true
  if (AGENT_EFFORTS[kind].some((e) => e.value === value)) return true
  return agentModels(kind, live).some((model) => model.efforts?.includes(value))
}

const MODEL_PICK_SEP = ':'

export function encodeModelPick(kind: IssueAgentKind, model: string): string {
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
): CatalogOption[] {
  const options: CatalogOption[] = [{ value: AUTO, label: 'Auto' }]
  for (const kind of ISSUE_AGENT_KINDS) {
    const group = ISSUE_AGENT_LABELS[kind]
    for (const model of agentModels(kind, catalog?.[kind])) {
      options.push({
        value: encodeModelPick(kind, model.value),
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
  kind: IssueAgentKind | undefined,
  model: string | null | undefined,
  catalog?: Record<string, readonly ModelChoice[] | undefined>,
): string {
  if (!model || model === AUTO) return 'Auto'
  if (!kind) return model
  return `${ISSUE_AGENT_LABELS[kind]} · ${modelLabel(kind, model, catalog?.[kind])}`
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
