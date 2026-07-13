import type { IssueAgentKind } from './issue-agents'
import type { PropertyOption } from './PropertyMenu'

/**
 * Per-agent model + reasoning-effort catalogs — the single source of truth for the
 * Model/Effort pickers used in the New Issue composer, the issue Start controls, and
 * the Settings screen (replacing the old free-text model field).
 *
 * Values are what each agent's CLI actually accepts (verified against each binary's
 * `--help` / `models` command): claude's `--model` aliases, `grok models`,
 * `cursor-agent models`, `opencode models`; and each CLI's effort flag
 * (claude/grok `--effort`, codex reasoning-effort config, opencode `--variant`).
 *
 * `'auto'` is the sentinel for "let the agent decide" — the spawn layer passes no
 * flag. The model lists are curated (not exhaustive); the pickers keep a free-text
 * escape hatch so any model string still works.
 */

/** Stored sentinel meaning "no override — the agent/harness decides". */
export const AUTO = 'auto'

export interface ModelChoice {
  value: string
  label: string
  /** Per-model effort levels, when the source reports them authoritatively (claude,
   *  codex). `[]` = the model supports no effort; `undefined` = unknown (agent fallback). */
  efforts?: string[]
}
type Choice = { value: string; label: string }

// Reasoning-effort ladders, each verified against the agent's own authoritative
// source (not guessed):
//   claude  `claude --help` → low, medium, high, xhigh, max
//   grok    `grok --help`   → low, medium, high, xhigh, max
//   codex   `codex debug models` supported_reasoning_levels → low, medium, high, xhigh
//   opencode `opencode run --help` --variant examples → minimal, low, medium, high, max
//   cursor   no effort flag — effort rides the model string (`model[effort=high]`)
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

const AGENT_MODELS: Record<IssueAgentKind, ModelChoice[]> = {
  'claude-code': [
    { value: 'opus', label: 'Opus', efforts: CLAUDE_GROK_EFFORT.map((o) => o.value) },
    { value: 'sonnet', label: 'Sonnet', efforts: CLAUDE_GROK_EFFORT.map((o) => o.value) },
    { value: 'haiku', label: 'Haiku', efforts: [] },
  ],
  // Fallback only — codex is live-enumerated server-side via `codex debug models`.
  codex: [
    { value: 'gpt-5.5', label: 'GPT-5.5', efforts: CODEX_EFFORT.map((o) => o.value) },
    { value: 'gpt-5.4', label: 'GPT-5.4', efforts: CODEX_EFFORT.map((o) => o.value) },
  ],
  grok: [
    { value: 'grok-composer-2.5-fast', label: 'Grok Composer 2.5 Fast' },
    { value: 'grok-build', label: 'Grok Build' },
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
  // Cursor has no effort flag — effort is a model parameter (model[effort=high]).
  cursor: [],
}

/** True when the agent exposes a reasoning-effort flag (everything but cursor). */
export function agentSupportsEffort(kind: IssueAgentKind): boolean {
  return AGENT_EFFORTS[kind].length > 0
}

function withAuto(choices: Choice[]): PropertyOption[] {
  return [{ value: AUTO, label: 'Auto' }, ...choices]
}

/** The models to offer for an agent: the live list (from the CLI's `models` command,
 *  fetched by the server) when available, else the built-in static list. */
function agentModels(kind: IssueAgentKind, live?: readonly ModelChoice[]): readonly ModelChoice[] {
  return live && live.length > 0 ? live : AGENT_MODELS[kind]
}

/** Model options for a `PropertyMenu`/`Select`, with the `auto` default first.
 *  Pass `live` (the server's live catalog for this agent) to override the static list. */
export function modelOptions(
  kind: IssueAgentKind,
  live?: readonly ModelChoice[],
): PropertyOption[] {
  return withAuto([...agentModels(kind, live)])
}

/** Effort options for a `PropertyMenu`/`Select`, with the `auto` default first. */
export function effortOptions(kind: IssueAgentKind): PropertyOption[] {
  return withAuto(AGENT_EFFORTS[kind])
}

const EFFORT_LEVEL_LABELS: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

function effortLevelLabel(level: string): string {
  return EFFORT_LEVEL_LABELS[level] ?? level
}

/**
 * Effort options for the SELECTED model — effort is a per-model property, not a blanket
 * per-agent one. With no concrete model (auto) there's nothing to scope effort to, so
 * returns [] (effort stays auto). When the live catalog reports the model's effort
 * levels (claude `capabilities.effort`, codex `supported_reasoning_levels`), those are
 * authoritative: a model with `[]` (e.g. claude haiku) offers no effort. When the source
 * doesn't expose per-model effort (grok/opencode), falls back to the agent's verified
 * CLI ladder. Empty result = hide the effort picker.
 */
export function effortOptionsForModel(
  kind: IssueAgentKind,
  modelValue: string | null | undefined,
  live?: readonly ModelChoice[],
): PropertyOption[] {
  if (!modelValue || modelValue === AUTO) return []
  const efforts = agentModels(kind, live).find((m) => m.value === modelValue)?.efforts
  if (efforts !== undefined) {
    if (efforts.length === 0) return []
    return withAuto(efforts.map((e) => ({ value: e, label: effortLevelLabel(e) })))
  }
  // Grok/OpenCode expose an effort flag but no per-model metadata. Keep their
  // full verified ladders available; an explicit [] remains authoritative.
  return agentSupportsEffort(kind) ? effortOptions(kind) : []
}

/** Display label for a stored model value; checks live models first, falls back to the
 *  raw value for a custom (free-text) model, and 'Auto' for the sentinel/empty. */
export function modelLabel(
  kind: IssueAgentKind,
  value: string | null | undefined,
  live?: readonly ModelChoice[],
): string {
  if (!value || value === AUTO) return 'Auto'
  return agentModels(kind, live).find((m) => m.value === value)?.label ?? value
}

/** Display label for a stored effort value; 'Auto' for the sentinel/empty. */
export function effortLabel(_kind: IssueAgentKind, value: string | null | undefined): string {
  if (!value || value === AUTO) return 'Auto'
  return effortLevelLabel(value)
}

/** Whether an effort value is offered for this agent — used to reset a stale effort
 *  when the effective agent changes (e.g. a codex-only rung under a claude session). */
export function isEffortValid(kind: IssueAgentKind, value: string | null | undefined): boolean {
  if (!value || value === AUTO) return true
  return AGENT_EFFORTS[kind].some((e) => e.value === value)
}
