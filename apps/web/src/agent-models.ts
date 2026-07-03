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
}
type Choice = ModelChoice

const AGENT_MODELS: Record<IssueAgentKind, Choice[]> = {
  'claude-code': [
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'haiku', label: 'Haiku' },
  ],
  codex: [
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
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

/** Standard reasoning-effort ladders. Claude + Grok share the full five; codex adds
 *  a `minimal` rung and stops at `high`; opencode's `--variant` takes the common three. */
const FULL_EFFORT: Choice[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
]

const AGENT_EFFORTS: Record<IssueAgentKind, Choice[]> = {
  'claude-code': FULL_EFFORT,
  grok: FULL_EFFORT,
  codex: [
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ],
  opencode: [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ],
  // Cursor's CLI has no effort/reasoning flag.
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
export function effortLabel(kind: IssueAgentKind, value: string | null | undefined): string {
  if (!value || value === AUTO) return 'Auto'
  return AGENT_EFFORTS[kind].find((e) => e.value === value)?.label ?? value
}

/** Whether an effort value is offered for this agent — used to reset a stale effort
 *  when the effective agent changes (e.g. a codex-only rung under a claude session). */
export function isEffortValid(kind: IssueAgentKind, value: string | null | undefined): boolean {
  if (!value || value === AUTO) return true
  return AGENT_EFFORTS[kind].some((e) => e.value === value)
}
