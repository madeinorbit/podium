import { Buffer } from 'node:buffer'
import {
  DEFAULT_SHIPWRIGHT_BUDGET,
  type AgentQuotaWire,
  type IssueWire,
  ShipwrightInspectionContract,
  type ShipAttempt,
  type ShipHoldAction,
  type ShipHoldCode,
  type ShipOrder,
  type ShipwrightAttemptResult,
  type ShipwrightBudget,
  type ShipwrightFailureKind,
  type ShipwrightLevel,
  ShipwrightPatchContract,
  type ShipwrightPatchContract as ShipwrightPatch,
  type UserId,
  asThreadId,
  shipRepairRef,
} from '@podium/model'
import type { PodiumSettings } from '@podium/runtime'
import type { ShippingValidationProfile } from '@podium/protocol/daemon'
import type { ModelCatalogSnapshot } from '../../model-catalog'
import { jsonSchema } from '../../llm-roles'
import type { HeadlessService } from '../superagent/headless'
import { routeShipwright } from './shipwright-router'

export interface ShipwrightFailure {
  kind: ShipwrightFailureKind
  summary: string
  output: string
  relevantDiff: string
  validationProfile: ShippingValidationProfile
}

export interface ShipwrightDeps {
  headless: Pick<HeadlessService, 'createHeadlessSession' | 'headlessTurn' | 'headlessTurnAck'>
  settingsFor(userId: UserId): PodiumSettings
  modelCatalog(machineId: ShipAttempt['machineId']): ModelCatalogSnapshot
  quota(machineId: ShipAttempt['machineId']): Promise<AgentQuotaWire[]>
  validationProfile(issue: IssueWire): ShippingValidationProfile
  /** Reads only the exact failed-effect artifacts and relevant target-side
   * hunks. The implementation owns remote-machine access and must honor the
   * byte limits supplied here. */
  context(input: ShippingRepairConsiderInput, limits: {
    maxContextBytes: number
    maxFailureBytes: number
  }): Promise<{ output: string; relevantDiff: string }>
  /** Deterministic patch boundary. It may create/update only `repairRef`; it has
   * no merge/publish/order authority. The caller revalidates candidateHeadSha. */
  applyPatch(input: {
    order: ShipOrder
    attempt: ShipAttempt
    custody: ShippingRepairConsiderInput['custody']
    repairRef: string
    patch: string
    touchedPaths: string[]
  }): Promise<
    | { ok: true; candidateHeadSha: string; evidenceRefs?: string[] }
    | { ok: false; summary: string; evidenceRefs?: string[] }
  >
  budget?: ShipwrightBudget
}

export type ShipwrightOutcome =
  | { kind: 'patch'; attempt: ShipwrightAttemptResult; patch: ShipwrightPatch }
  | {
      kind: 'hold'
      reason: 'ambiguous' | 'rejected' | 'budget-exhausted' | 'unavailable' | 'invalid-output'
      detail: string
      evidence: string[]
    }

export interface ShippingRepairConsiderInput {
  order: ShipOrder
  attempt: ShipAttempt
  issue: IssueWire
  failure: {
    operation: 'prepare-merge-group' | 'validate'
    classification: string
    summary: string
    artifactRefs: string[]
  }
  custody: {
    attemptId: ShipAttempt['id']
    generation: number
    machineId: ShipAttempt['machineId']
  }
}

export type ShippingRepairConsiderResult =
  | 'not-applicable'
  | { kind: 'patched'; repairRef: string; candidateHeadSha: string }
  | {
      kind: 'needs-decision'
      reasonCode: ShipHoldCode
      headline: string
      detail: string
      evidenceRefs: string[]
      actions: ShipHoldAction[]
    }

function byteSlice(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value)
  if (bytes.byteLength <= maxBytes) return value
  return `${bytes.subarray(0, maxBytes).toString('utf8')}\n[truncated by shipwright budget]`
}

function issueContext(issue: IssueWire): string {
  return [
    `Title: ${issue.title}`,
    `Description: ${issue.description}`,
    issue.brief ? `Brief: ${issue.brief}` : '',
    issue.acceptance ? `Acceptance: ${issue.acceptance}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function patchPaths(patch: string): string[] | null {
  if (/GIT binary patch|Binary files .* differ|^diff --(?:cc|combined)/m.test(patch)) return null
  const paths = new Set<string>()
  for (const match of patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)) {
    if (match[1] !== match[2]) return null
    const path = match[1]
    if (!path || path.startsWith('/') || path.split('/').some((part) => part === '..')) return null
    if (path === '.git' || path.startsWith('.git/')) return null
    paths.add(path)
  }
  return paths.size > 0 ? [...paths].sort() : null
}

export function validateShipwrightPatch(
  contract: ShipwrightPatch,
  budget: ShipwrightBudget = DEFAULT_SHIPWRIGHT_BUDGET,
): { ok: true; paths: string[]; risky: boolean } | { ok: false; reason: string } {
  if (Buffer.byteLength(contract.patch) > budget.maxPatchBytes) {
    return { ok: false, reason: 'the proposed patch exceeds the repair byte budget' }
  }
  const paths = patchPaths(contract.patch)
  if (!paths) return { ok: false, reason: 'the response is not a bounded text patch' }
  const declared = [...new Set(contract.touchedPaths)].sort()
  if (JSON.stringify(paths) !== JSON.stringify(declared)) {
    return { ok: false, reason: 'declared touched paths do not match the patch' }
  }
  const forbidden = paths.find(
    (path) =>
      path === 'AGENTS.md' ||
      path.startsWith('.podium/') ||
      path.startsWith('docs/proposals/') ||
      path.includes('/migrations/') ||
      /(^|\/)(package|bun\.lock|pnpm-lock|yarn\.lock)/.test(path),
  )
  if (forbidden) return { ok: false, reason: `repair policy forbids changing ${forbidden}` }
  const risky = paths.some(
    (path) =>
      /(?:^|\/)(?:.*\.test\.[^/]+|.*\.spec\.[^/]+|__snapshots__\/|packages\/protocol\/)/.test(
        path,
      ),
  )
  return { ok: true, paths, risky }
}

function systemPrompt(level: ShipwrightLevel): string {
  const contract =
    level === 'inspector'
      ? '{"kind":"inspection","verdict":"safe|ambiguous|reject","summary":"...","concerns":[]}'
      : '{"kind":"patch","summary":"...","behaviorImpact":"none|observable-change|ambiguous","touchedPaths":["..."],"patch":"unified diff","concerns":[]}'
  return [
    `You are the Shipping ${level}.`,
    'You have no delivery authority. Do not merge, publish, commit, push, run commands, use tools, or broaden acceptance criteria.',
    level === 'inspector'
      ? 'Review the proposed repair only. Never return replacement code.'
      : 'Return the smallest text-only unified diff that repairs the classified failure.',
    'If observable behavior has more than one valid answer, report ambiguity instead of choosing.',
    `Return exactly one JSON object matching ${contract}`,
  ].join('\n')
}

function promptFor(
  level: ShipwrightLevel,
  issue: IssueWire,
  failure: ShipwrightFailure,
  budget: ShipwrightBudget,
  proposedPatch?: ShipwrightPatch,
): string {
  const failureOutput = byteSlice(failure.output, budget.maxFailureBytes)
  const raw = [
    '<issue>',
    issueContext(issue),
    '</issue>',
    '<failure>',
    `Kind: ${failure.kind}`,
    `Summary: ${failure.summary}`,
    `Validation profile: ${failure.validationProfile.id}`,
    failureOutput,
    '</failure>',
    '<relevant-diff>',
    failure.relevantDiff,
    '</relevant-diff>',
    ...(proposedPatch
      ? ['<proposed-repair>', JSON.stringify(proposedPatch), '</proposed-repair>']
      : []),
  ].join('\n')
  return byteSlice(raw, budget.maxContextBytes)
}

/** Tool-less headless execution for one ladder rung. The original issue session
 * is neither looked up nor resumed; every turn gets a repair-only session. */
export class ShipwrightService {
  private readonly budget: ShipwrightBudget

  constructor(private readonly deps: ShipwrightDeps) {
    this.budget = ShipwrightBudget.parse(deps.budget ?? DEFAULT_SHIPWRIGHT_BUDGET)
  }

  /** ShippingRepairPort implementation. This hook owns model judgment only:
   * deterministic code applies the returned patch to the attempt ref, and the
   * shipping lifecycle owns the mandatory exact validation that follows. */
  async consider(input: ShippingRepairConsiderInput): Promise<ShippingRepairConsiderResult> {
    const kind =
      input.failure.operation === 'prepare-merge-group' &&
      input.failure.classification === 'merge-conflict'
        ? 'merge-conflict'
        : input.failure.operation === 'validate' &&
            input.failure.classification === 'validation-failed'
          ? 'validation-failed'
          : null
    if (!kind) return 'not-applicable'
    if (
      input.custody.attemptId !== input.attempt.id ||
      input.custody.generation !== input.attempt.leaseGeneration ||
      input.custody.machineId !== input.attempt.machineId
    ) {
      return this.decision(input, 'policy-refused', 'Repair custody changed before dispatch.')
    }
    const context = await this.deps.context(input, {
      maxContextBytes: this.budget.maxContextBytes,
      maxFailureBytes: this.budget.maxFailureBytes,
    })
    let failure: ShipwrightFailure = {
      kind,
      summary: input.failure.summary,
      output: context.output,
      relevantDiff: context.relevantDiff,
      validationProfile: this.deps.validationProfile(input.issue),
    }
    const priorFamilies: string[] = []
    let turns = 0
    const levels: ShipwrightLevel[] = [
      ...Array.from({ length: this.budget.maxMechanicTurns }, () => 'mechanic' as const),
      ...Array.from({ length: this.budget.maxSolverTurns }, () => 'solver' as const),
    ]
    for (const level of levels) {
      if (turns >= this.budget.maxTurns) break
      const proposed = await this.run({
        order: input.order,
        attempt: input.attempt,
        issue: input.issue,
        failure,
        level,
        priorFamilies,
      })
      turns += 1
      if (proposed.kind === 'hold') {
        if (proposed.reason === 'ambiguous' || proposed.reason === 'rejected') {
          return this.decision(
            input,
            kind === 'merge-conflict' ? 'landing-conflict' : 'validation-failed',
            proposed.detail,
            proposed.evidence,
          )
        }
        failure = { ...failure, output: `${failure.output}\n${proposed.detail}` }
        continue
      }
      priorFamilies.push(proposed.attempt.route.family)
      let patch = proposed.patch
      if (this.requiresInspection(patch) && this.budget.maxInspectorTurns > 0) {
        if (turns >= this.budget.maxTurns) break
        const inspected = await this.run({
          order: input.order,
          attempt: input.attempt,
          issue: input.issue,
          failure,
          level: 'inspector',
          priorFamilies,
          proposedPatch: patch,
        })
        turns += 1
        if (inspected.kind === 'hold') {
          return this.decision(
            input,
            kind === 'merge-conflict' ? 'landing-conflict' : 'validation-failed',
            inspected.detail,
            inspected.evidence,
          )
        }
        priorFamilies.push(inspected.attempt.route.family)
        patch = inspected.patch
      }
      const applied = await this.deps.applyPatch({
        order: input.order,
        attempt: input.attempt,
        custody: input.custody,
        repairRef: proposed.attempt.repairRef,
        patch: patch.patch,
        touchedPaths: patch.touchedPaths,
      })
      if (applied.ok) {
        return {
          kind: 'patched',
          repairRef: proposed.attempt.repairRef,
          candidateHeadSha: applied.candidateHeadSha,
        }
      }
      failure = {
        ...failure,
        summary: applied.summary,
        output: `${failure.output}\nDeterministic patch application: ${applied.summary}`,
      }
    }
    return this.decision(
      input,
      kind === 'merge-conflict' ? 'landing-conflict' : 'validation-failed',
      'Bounded safe-fix attempts were exhausted without a deterministically applicable patch.',
    )
  }

  async run(input: {
    order: ShipOrder
    attempt: ShipAttempt
    issue: IssueWire
    failure: ShipwrightFailure
    level: ShipwrightLevel
    priorFamilies?: string[]
    proposedPatch?: ShipwrightPatch
  }): Promise<ShipwrightOutcome> {
    const owner = input.order.requestedBy.onBehalfOf
    if (!owner) {
      return { kind: 'hold', reason: 'unavailable', detail: 'shipping has no personal model owner', evidence: [] }
    }
    const quota = await this.deps.quota(input.attempt.machineId)
    const route = routeShipwright({
      settings: this.deps.settingsFor(owner),
      catalog: this.deps.modelCatalog(input.attempt.machineId),
      quota,
      level: input.level,
      priorFamilies: input.priorFamilies,
    })
    if (!route) {
      return { kind: 'hold', reason: 'unavailable', detail: 'no live shipwright route has usable quota', evidence: [] }
    }
    const { sessionId } = this.deps.headless.createHeadlessSession({
      agentKind: route.agent,
      cwd: input.issue.repoPath,
      title: `Shipwright ${input.level}`,
      spawnedBy: `shipping:${input.attempt.id}:${input.level}`,
      machineId: input.attempt.machineId,
    })
    const turnId = `shipwright:${input.attempt.id}:${input.attempt.leaseGeneration}:${input.level}`
    const response = await this.deps.headless.headlessTurn({
      turnId,
      sessionId,
      threadId: asThreadId(`shipping:${input.order.id}`),
      agent: route.agent,
      model: route.model,
      effort: route.effort,
      cwd: input.issue.repoPath,
      prompt: promptFor(input.level, input.issue, input.failure, this.budget, input.proposedPatch),
      systemPrompt: systemPrompt(input.level),
      allowedTools: [],
      permissionMode: 'deny',
      timeoutMs: this.budget.timeoutMs,
    })
    this.deps.headless.headlessTurnAck(sessionId, turnId)
    if (!response.ok || !response.output) {
      return {
        kind: 'hold',
        reason: 'unavailable',
        detail: response.error || 'shipwright returned no structured result',
        evidence: [],
      }
    }
    const parse =
      input.level === 'inspector'
        ? jsonSchema(ShipwrightInspectionContract)
        : jsonSchema(ShipwrightPatchContract)
    const contract = parse(response.output)
    if (!contract) {
      return { kind: 'hold', reason: 'invalid-output', detail: 'shipwright output did not match its patch contract', evidence: [] }
    }
    if (contract.kind === 'inspection') {
      if (contract.verdict !== 'safe') {
        return {
          kind: 'hold',
          reason: contract.verdict === 'ambiguous' ? 'ambiguous' : 'rejected',
          detail: contract.summary,
          evidence: contract.concerns,
        }
      }
      if (!input.proposedPatch) {
        return { kind: 'hold', reason: 'invalid-output', detail: 'inspector had no patch to review', evidence: [] }
      }
      return {
        kind: 'patch',
        attempt: {
          level: input.level,
          route,
          repairRef: shipRepairRef(input.attempt.id, input.attempt.leaseGeneration),
          contract,
        },
        patch: input.proposedPatch,
      }
    }
    const checked = validateShipwrightPatch(contract, this.budget)
    if (!checked.ok) {
      return { kind: 'hold', reason: 'invalid-output', detail: checked.reason, evidence: [] }
    }
    if (contract.behaviorImpact !== 'none') {
      return {
        kind: 'hold',
        reason: 'ambiguous',
        detail: contract.summary,
        evidence: contract.concerns,
      }
    }
    return {
      kind: 'patch',
      attempt: {
        level: input.level,
        route,
        repairRef: shipRepairRef(input.attempt.id, input.attempt.leaseGeneration),
        contract,
      },
      patch: contract,
    }
  }

  requiresInspection(patch: ShipwrightPatch): boolean {
    const checked = validateShipwrightPatch(patch, this.budget)
    return checked.ok && checked.risky
  }

  private decision(
    input: ShippingRepairConsiderInput,
    reasonCode: ShipHoldCode,
    detail: string,
    evidence: string[] = [],
  ): Extract<ShippingRepairConsiderResult, { kind: 'needs-decision' }> {
    return {
      kind: 'needs-decision',
      reasonCode,
      headline: 'Needs your decision',
      detail,
      evidenceRefs: [...new Set([...input.failure.artifactRefs, ...evidence])],
      actions: ['retry', 'return-to-issue', 'open-repair'],
    }
  }
}
