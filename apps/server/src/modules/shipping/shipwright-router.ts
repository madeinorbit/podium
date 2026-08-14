import {
  DEFAULT_SHIPWRIGHT_BUDGET,
  type AgentQuotaWire,
  type HarnessAgent,
  type ShipwrightBudget,
  type ShipwrightLevel,
  type ShipwrightRoute,
} from '@podium/model'
import { nativeAccountId, resolveRole, type PodiumSettings } from '@podium/runtime'
import { harnessSupportsNoTools } from '../../harness-manifest'
import type { ModelCatalogSnapshot } from '../../model-catalog'

type Tier = 'fast' | 'balanced' | 'frontier'

export interface ShipwrightTraitCandidate {
  id: string
  family: string
  tier: Tier
  preferred: boolean
  available: boolean
}

interface Candidate extends ShipwrightTraitCandidate {
  agent: HarnessAgent
  model: string
  efforts?: string[]
}

export interface ShipwrightRouteInput {
  settings: PodiumSettings
  catalog: ModelCatalogSnapshot
  quota: readonly AgentQuotaWire[]
  level: ShipwrightLevel
  priorFamilies?: readonly string[]
}

export function shipwrightModelFamily(agent: HarnessAgent, model: string): string {
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

function quotaAllows(
  agent: HarnessAgent,
  model: string,
  quota: readonly AgentQuotaWire[],
): boolean {
  const reading = quota.find((item) => item.agent === agent)
  if (!reading) return true
  if (reading.status !== 'ok') return false
  return !reading.windows.some(
    (window) =>
      window.usedPercent >= 98 && (window.scopeModel === undefined || window.scopeModel === model),
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

function rank(
  level: ShipwrightLevel,
  candidate: ShipwrightTraitCandidate,
  prior: ReadonlySet<string>,
): number {
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

export function selectShipwrightCandidate(
  level: ShipwrightLevel,
  candidates: readonly ShipwrightTraitCandidate[],
  priorFamilies: readonly string[] = [],
): string | null {
  const prior = new Set(priorFamilies)
  return (
    candidates
      .filter((candidate) => candidate.available)
      .sort(
        (left, right) =>
          rank(level, left, prior) - rank(level, right, prior) || left.id.localeCompare(right.id),
      )[0]?.id ?? null
  )
}

export function shipwrightTurnCeiling(
  budget: ShipwrightBudget = DEFAULT_SHIPWRIGHT_BUDGET,
): number {
  return Math.min(
    budget.maxTurns,
    (budget.maxMechanicTurns + budget.maxSolverTurns) * (1 + budget.maxInspectorTurns),
  )
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
    if (!harnessSupportsNoTools(parsed)) continue
    for (const model of models) {
      candidates.push({
        id: `${parsed}:${model.value}`,
        agent: parsed,
        model: model.value,
        efforts: model.efforts,
        family: shipwrightModelFamily(parsed, model.value),
        tier: modelTier(model.value),
        preferred: parsed === preferred.harness && model.value === preferred.model,
        available: quotaAllows(parsed, model.value, input.quota),
      })
    }
  }
  const selectedId = selectShipwrightCandidate(input.level, candidates, input.priorFamilies)
  const selected = candidates.find((candidate) => candidate.id === selectedId)
  if (!selected) return null
  return {
    level: input.level,
    agent: selected.agent,
    model: selected.model,
    effort: effortFor(input.level, selected.efforts),
    family: selected.family,
    accountId:
      selected.agent === preferred.harness ? preferred.accountId : nativeAccountId(selected.agent),
  }
}

/** Small stable corpus used to prevent trait changes from quietly collapsing
 * every failure onto one model tier. It contains shapes, never provider names. */
export const SHIPWRIGHT_ROUTER_EVAL_SET = [
  {
    id: 'throughput-first',
    level: 'mechanic',
    priorFamilies: [],
    candidates: [
      { id: 'fast-a', family: 'family-a', tier: 'fast', preferred: false, available: true },
      { id: 'frontier-b', family: 'family-b', tier: 'frontier', preferred: true, available: true },
    ],
    expected: 'fast-a',
    expectedTurnCeiling: 3,
  },
  {
    id: 'capability-first',
    level: 'solver',
    priorFamilies: [],
    candidates: [
      { id: 'fast-a', family: 'family-a', tier: 'fast', preferred: true, available: true },
      { id: 'frontier-b', family: 'family-b', tier: 'frontier', preferred: false, available: true },
    ],
    expected: 'frontier-b',
    expectedTurnCeiling: 3,
  },
  {
    id: 'independent-review',
    level: 'inspector',
    priorFamilies: ['family-a'],
    candidates: [
      { id: 'frontier-a', family: 'family-a', tier: 'frontier', preferred: true, available: true },
      { id: 'balanced-b', family: 'family-b', tier: 'balanced', preferred: false, available: true },
    ],
    expected: 'balanced-b',
    expectedTurnCeiling: 3,
  },
  {
    id: 'quota-fallback',
    level: 'solver',
    priorFamilies: [],
    candidates: [
      { id: 'frontier-a', family: 'family-a', tier: 'frontier', preferred: true, available: false },
      { id: 'balanced-b', family: 'family-b', tier: 'balanced', preferred: false, available: true },
    ],
    expected: 'balanced-b',
    expectedTurnCeiling: 3,
  },
] as const

export function evaluateShipwrightRouterCase(input: (typeof SHIPWRIGHT_ROUTER_EVAL_SET)[number]): {
  route: string | null
  turnCeiling: number
} {
  return {
    route: selectShipwrightCandidate(input.level, input.candidates, input.priorFamilies),
    turnCeiling: shipwrightTurnCeiling(),
  }
}
