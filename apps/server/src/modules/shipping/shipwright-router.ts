import type { AgentQuotaWire, HarnessAgent, ShipwrightLevel, ShipwrightRoute } from '@podium/model'
import { resolveRole, type PodiumSettings } from '@podium/runtime'
import type { ModelCatalogSnapshot } from '../../model-catalog'

type Tier = 'fast' | 'balanced' | 'frontier'

interface Candidate {
  agent: HarnessAgent
  model: string
  efforts?: string[]
  family: string
  tier: Tier
  preferred: boolean
}

export interface ShipwrightRouteInput {
  settings: PodiumSettings
  catalog: ModelCatalogSnapshot
  quota: readonly AgentQuotaWire[]
  level: ShipwrightLevel
  priorFamilies?: readonly string[]
}

function modelFamily(agent: HarnessAgent, model: string): string {
  const value = model.toLowerCase()
  if (/claude/.test(value)) return 'anthropic'
  if (/gemini/.test(value)) return 'google'
  if (/grok/.test(value)) return 'xai'
  if (/gpt|codex|\bo[134](?:-|$)/.test(value)) return 'openai'
  const provider = value.includes('/') ? value.split('/', 1)[0] : undefined
  return provider || agent
}

function modelTier(model: string): Tier {
  const value = model.toLowerCase()
  if (/nano|mini|flash|haiku|fast|lite/.test(value)) return 'fast'
  if (/opus|pro|max|ultra|frontier|gpt-5(?:\.|-|$)|codex|\bo[134](?:-|$)/.test(value)) {
    return 'frontier'
  }
  return 'balanced'
}

function quotaAllows(agent: HarnessAgent, model: string, quota: readonly AgentQuotaWire[]): boolean {
  const reading = quota.find((item) => item.agent === agent)
  if (!reading) return true
  if (reading.status !== 'ok') return false
  return !reading.windows.some(
    (window) =>
      window.usedPercent >= 98 &&
      (window.scopeModel === undefined || window.scopeModel === model),
  )
}

function effortFor(level: ShipwrightLevel, available: readonly string[] | undefined): string {
  const wanted =
    level === 'mechanic'
      ? ['medium', 'low', 'auto']
      : level === 'solver'
        ? ['high', 'xhigh', 'max', 'medium', 'auto']
        : ['high', 'medium', 'xhigh', 'max', 'auto']
  if (!available || available.length === 0) return wanted[0] as string
  return wanted.find((effort) => available.includes(effort)) ?? available[0] ?? 'auto'
}

function rank(level: ShipwrightLevel, candidate: Candidate, prior: ReadonlySet<string>): number {
  const tierScore =
    level === 'mechanic'
      ? candidate.tier === 'fast'
        ? 0
        : candidate.tier === 'balanced'
          ? 1
          : 3
      : candidate.tier === 'frontier'
        ? 0
        : candidate.tier === 'balanced'
          ? 1
          : 3
  const familyPenalty = level === 'inspector' && prior.has(candidate.family) ? 20 : 0
  return tierScore + familyPenalty + (candidate.preferred ? -1 : 0)
}

/** Resolve at use time from one person's role, one machine's live catalog, and
 * that machine's current quota. A spent or unauthenticated harness is skipped;
 * an Inspector is kept on a different family whenever one is available. */
export function routeShipwright(input: ShipwrightRouteInput): ShipwrightRoute | null {
  const preferred = resolveRole(input.settings, 'shipwright')
  const candidates: Candidate[] = []
  for (const [agentRaw, models] of Object.entries(input.catalog.byAgent)) {
    const parsed = (['claude-code', 'codex', 'grok', 'opencode', 'cursor'] as const).find(
      (agent) => agent === agentRaw,
    )
    if (!parsed) continue
    for (const model of models) {
      candidates.push({
        agent: parsed,
        model: model.value,
        efforts: model.efforts,
        family: modelFamily(parsed, model.value),
        tier: modelTier(model.value),
        preferred: parsed === preferred.harness && model.value === preferred.model,
      })
    }
  }
  if (
    preferred.model !== 'auto' &&
    !candidates.some(
      (candidate) =>
        candidate.agent === preferred.harness && candidate.model === preferred.model,
    )
  ) {
    candidates.push({
      agent: preferred.harness,
      model: preferred.model,
      family: modelFamily(preferred.harness, preferred.model),
      tier: modelTier(preferred.model),
      preferred: true,
    })
  }
  const prior = new Set(input.priorFamilies ?? [])
  const usable = candidates
    .filter((candidate) => quotaAllows(candidate.agent, candidate.model, input.quota))
    .sort(
      (left, right) =>
        rank(input.level, left, prior) - rank(input.level, right, prior) ||
        left.agent.localeCompare(right.agent) ||
        left.model.localeCompare(right.model),
    )
  const selected = usable[0]
  if (!selected) return null
  return {
    level: input.level,
    agent: selected.agent,
    model: selected.model,
    effort: effortFor(input.level, selected.efforts),
    family: selected.family,
  }
}

/** Small stable corpus used to prevent trait changes from quietly collapsing
 * every failure onto one model tier. It contains shapes, never provider names. */
export const SHIPWRIGHT_ROUTER_EVAL_SET = [
  { id: 'local-import-conflict', failure: 'merge-conflict', expectedFirst: 'mechanic' },
  { id: 'single-test-expectation', failure: 'validation-failed', expectedFirst: 'mechanic' },
  { id: 'cross-module-contract', failure: 'validation-failed', expectedEscalation: 'solver' },
  { id: 'two-valid-behaviors', failure: 'merge-conflict', expectedEscalation: 'inspector' },
] as const
