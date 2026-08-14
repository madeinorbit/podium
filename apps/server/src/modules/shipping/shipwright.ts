import { Buffer } from 'node:buffer'
import {
  DEFAULT_SHIPWRIGHT_BUDGET,
  type AccountId,
  type AgentQuotaWire,
  type IssueWire,
  ShipwrightEvidenceRef,
  type ShipwrightEvidenceRef as ShipwrightEvidenceRefValue,
  ShipwrightInspectionContract,
  type ShipAttempt,
  type ShipHoldAction,
  type ShipHoldCode,
  type ShipOrder,
  type ShipwrightAttemptResult,
  ShipwrightBudget,
  type ShipwrightFailureKind,
  type ShipwrightLevel,
  type ShipwrightRoute,
  ShipwrightPatchContract,
  type ShipwrightPatchContract as ShipwrightPatch,
  type UserId,
  asSessionId,
  asThreadId,
  shipRepairRef,
} from '@podium/model'
import type { PodiumSettings } from '@podium/runtime'
import type { ShippingJobClassification, ShippingValidationProfile } from '@podium/protocol/daemon'
import type { ModelCatalogSnapshot } from '../../model-catalog'
import { jsonSchema } from '../../llm-roles'
import type { HeadlessService } from '../superagent/headless'
import { routeShipwright, shipwrightModelFamily } from './shipwright-router'

export interface ShipwrightFailure {
  kind: ShipwrightFailureKind
  summary: string
  output: string
  relevantDiff: string
  validationProfile: ShippingValidationProfile
}

export interface ShipwrightDeps {
  headless: Pick<
    HeadlessService,
    'createHeadlessSession' | 'headlessSession' | 'headlessTurn' | 'headlessTurnAck'
  >
  settingsFor(userId: UserId): PodiumSettings
  modelCatalog(machineId: ShipAttempt['machineId']): ModelCatalogSnapshot
  quota(machineId: ShipAttempt['machineId']): Promise<AgentQuotaWire[]>
  nativeAccountId(
    machineId: ShipAttempt['machineId'],
    agent: ShipwrightRoute['agent'],
    requested: AccountId,
  ): AccountId | null
  validationProfile(issue: IssueWire): ShippingValidationProfile
  /** Future stable-port seam: copy/register only authorized executor artifacts
   * and return repository-canonical opaque artifact:// references. */
  evidence: ShipwrightEvidenceMaterializer
  /** Reads only already-materialized evidence under the exact failure custody.
   * Raw executor paths never cross this port. */
  context(
    input: ShipwrightContextInput,
    limits: {
      maxContextBytes: number
      maxFailureBytes: number
    },
  ): Promise<{ output: string; relevantDiff: string }>
  /** Deterministic patch boundary. It may create/update only `repairRef`; it has
   * no merge/publish/order authority. The caller revalidates candidateHeadSha. */
  applyPatch(input: {
    order: ShipOrder
    attempt: ShipAttempt
    custody: ShipwrightRepairInput['custody']
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
  | {
      kind: 'patch'
      attempt: ShipwrightAttemptResult
      patch: ShipwrightPatch
      receipt: ShipwrightResultReceipt
    }
  | {
      kind: 'hold'
      reason: 'ambiguous' | 'rejected' | 'budget-exhausted' | 'unavailable' | 'invalid-output'
      detail: string
      evidence: ShipwrightEvidenceRefValue[]
      receipt?: ShipwrightResultReceipt
    }

export interface ShipwrightRepairInput {
  order: ShipOrder
  attempt: ShipAttempt
  issue: IssueWire
  failure: {
    operation: 'prepare-merge-group' | 'validate'
    classification: ShippingJobClassification
    summary: string
    artifactRefs: string[]
  }
  custody: {
    attemptId: ShipAttempt['id']
    generation: number
    machineId: ShipAttempt['machineId']
  }
}

export interface ShipwrightEvidenceMaterializer {
  materialize(input: {
    source: 'failure' | 'patch-application'
    refs: readonly string[]
    order: ShipOrder
    attempt: ShipAttempt
    custody: ShipwrightRepairInput['custody']
  }): Promise<readonly ShipwrightEvidenceRefValue[]>
}

export interface ShipwrightContextInput {
  order: ShipOrder
  attempt: ShipAttempt
  issue: IssueWire
  failure: {
    operation: ShipwrightRepairInput['failure']['operation']
    classification: ShippingJobClassification
    summary: string
    artifactRefs: readonly ShipwrightEvidenceRefValue[]
  }
  custody: ShipwrightRepairInput['custody']
}

export type ShipwrightRepairRecommendation =
  | { kind: 'not-applicable' }
  | { kind: 'patched'; repairRef: string; candidateHeadSha: string; resultToken: string }
  | {
      kind: 'needs-decision'
      reasonCode: ShipHoldCode
      headline: string
      detail: string
      evidenceRefs: ShipwrightEvidenceRefValue[]
      actions: ShipHoldAction[]
      resultToken: string
    }

interface ShipwrightResultReceipt {
  sessionId: ReturnType<typeof asSessionId>
  turnId: string
  requestDigest: string
  accountId: AccountId
}

interface ShipwrightResultEnvelope {
  orderId: ShipOrder['id']
  attemptId: ShipAttempt['id']
  generation: number
  receipts: ShipwrightResultReceipt[]
}

const RESULT_TOKEN_PREFIX = 'shipwright-result:'

function encodeResultToken(
  input: ShipwrightRepairInput,
  receipts: readonly ShipwrightResultReceipt[],
): string {
  const envelope: ShipwrightResultEnvelope = {
    orderId: input.order.id,
    attemptId: input.attempt.id,
    generation: input.custody.generation,
    receipts: [...receipts],
  }
  return `${RESULT_TOKEN_PREFIX}${Buffer.from(JSON.stringify(envelope)).toString('base64url')}`
}

function decodeResultToken(token: string): ShipwrightResultEnvelope {
  if (!token.startsWith(RESULT_TOKEN_PREFIX)) throw new Error('invalid shipwright result token')
  const parsed: unknown = JSON.parse(
    Buffer.from(token.slice(RESULT_TOKEN_PREFIX.length), 'base64url').toString('utf8'),
  )
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { orderId?: unknown }).orderId !== 'string' ||
    typeof (parsed as { attemptId?: unknown }).attemptId !== 'string' ||
    typeof (parsed as { generation?: unknown }).generation !== 'number' ||
    !Number.isInteger((parsed as { generation: number }).generation) ||
    !Array.isArray((parsed as { receipts?: unknown }).receipts) ||
    (parsed as { receipts: unknown[] }).receipts.some(
      (item) =>
        typeof item !== 'object' ||
        item === null ||
        typeof (item as { sessionId?: unknown }).sessionId !== 'string' ||
        typeof (item as { turnId?: unknown }).turnId !== 'string' ||
        typeof (item as { requestDigest?: unknown }).requestDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test((item as { requestDigest: string }).requestDigest) ||
        typeof (item as { accountId?: unknown }).accountId !== 'string' ||
        !(item as { accountId: string }).accountId.startsWith('native:'),
    )
  ) {
    throw new Error('invalid shipwright result token')
  }
  const value = parsed as {
    orderId: ShipOrder['id']
    attemptId: ShipAttempt['id']
    generation: number
    receipts: { sessionId: string; turnId: string; requestDigest: string; accountId: AccountId }[]
  }
  return {
    orderId: value.orderId,
    attemptId: value.attemptId,
    generation: value.generation,
    receipts: value.receipts.map((item) => ({
      sessionId: asSessionId(item.sessionId),
      turnId: item.turnId,
      requestDigest: item.requestDigest,
      accountId: item.accountId,
    })),
  }
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
  const entries = [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)]
  for (const match of entries) {
    if (match[1] !== match[2]) return null
    const path = match[1]
    if (!path || path.startsWith('/') || path.split('/').some((part) => part === '..')) return null
    if (path === '.git' || path.startsWith('.git/')) return null
    paths.add(path)
  }
  if (paths.size === 0 || paths.size !== entries.length) return null
  const oldPaths = [...patch.matchAll(/^--- a\/(.+)$/gm)].map((match) => match[1]).sort()
  const newPaths = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]).sort()
  const sorted = [...paths].sort()
  return JSON.stringify(oldPaths) === JSON.stringify(sorted) &&
    JSON.stringify(newPaths) === JSON.stringify(sorted)
    ? sorted
    : null
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
      path.startsWith('migrations/') ||
      path.includes('/migrations/') ||
      /(^|\/)(package\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock)$/.test(path),
  )
  if (forbidden) return { ok: false, reason: `repair policy forbids changing ${forbidden}` }
  const risky = paths.some((path) =>
    /(?:^|\/)(?:.*\.test\.[^/]+|.*\.spec\.[^/]+|__snapshots__\/|packages\/protocol\/)/.test(path),
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

  /** Internal model-judgment boundary. The POD-832 adapter owns the canonical
   * repair port once that moving contract lands:
   * deterministic code applies the returned patch to the attempt ref, and the
   * shipping lifecycle owns the mandatory exact validation that follows. */
  async consider(input: ShipwrightRepairInput): Promise<ShipwrightRepairRecommendation> {
    const kind =
      input.failure.operation === 'prepare-merge-group' &&
      input.failure.classification === 'merge-conflict'
        ? 'merge-conflict'
        : input.failure.operation === 'validate' &&
            input.failure.classification === 'validation-failed'
          ? 'validation-failed'
          : null
    if (!kind) return { kind: 'not-applicable' }
    const receipts: ShipwrightResultReceipt[] = []
    const evidence = new Set<ShipwrightEvidenceRefValue>()
    if (
      input.custody.attemptId !== input.attempt.id ||
      input.custody.generation !== input.attempt.leaseGeneration ||
      input.custody.machineId !== input.attempt.machineId
    ) {
      return this.decision(
        input,
        'policy-refused',
        'Repair custody changed before dispatch.',
        evidence,
      )
    }
    let materializedFailure: readonly string[]
    try {
      materializedFailure = await this.deps.evidence.materialize({
        source: 'failure',
        refs: input.failure.artifactRefs,
        order: input.order,
        attempt: input.attempt,
        custody: input.custody,
      })
    } catch {
      return this.decision(
        input,
        'policy-refused',
        'Repair evidence could not be materialized into an authorized artifact.',
        evidence,
      )
    }
    const parsedEvidence = ShipwrightEvidenceRef.array().safeParse(materializedFailure)
    if (!parsedEvidence.success) {
      return this.decision(
        input,
        'policy-refused',
        'Repair evidence contained a non-durable or unsafe reference.',
        evidence,
      )
    }
    for (const ref of parsedEvidence.data) evidence.add(ref)
    let context: Awaited<ReturnType<ShipwrightDeps['context']>>
    try {
      context = await this.deps.context(
        {
          order: input.order,
          attempt: input.attempt,
          issue: input.issue,
          failure: {
            operation: input.failure.operation,
            classification: input.failure.classification,
            summary: input.failure.summary,
            artifactRefs: parsedEvidence.data,
          },
          custody: input.custody,
        },
        {
          maxContextBytes: this.budget.maxContextBytes,
          maxFailureBytes: this.budget.maxFailureBytes,
        },
      )
    } catch {
      return this.decision(
        input,
        'policy-refused',
        'Repair context could not be resolved from authorized evidence for this attempt.',
        evidence,
      )
    }
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
    for (const [rung, level] of levels.entries()) {
      if (turns >= this.budget.maxTurns) break
      const proposed = await this.run({
        order: input.order,
        attempt: input.attempt,
        issue: input.issue,
        failure,
        level,
        rung,
        priorFamilies,
      })
      turns += 1
      if (proposed.receipt) receipts.push(proposed.receipt)
      if (proposed.kind === 'hold') {
        if (proposed.reason === 'ambiguous' || proposed.reason === 'rejected') {
          return this.decision(
            input,
            kind === 'merge-conflict' ? 'landing-conflict' : 'validation-failed',
            proposed.detail,
            evidence,
            receipts,
          )
        }
        failure = { ...failure, output: `${failure.output}\n${proposed.detail}` }
        continue
      }
      priorFamilies.push(proposed.attempt.route.family)
      let patch = proposed.patch
      if (this.requiresInspection(patch) && this.budget.maxInspectorTurns === 0) {
        return this.decision(
          input,
          'policy-refused',
          'This repair requires independent inspection, but the Inspector budget is zero.',
          evidence,
          receipts,
        )
      }
      if (this.requiresInspection(patch)) {
        let approved = false
        let inspectorTurns = 0
        while (inspectorTurns < this.budget.maxInspectorTurns && turns < this.budget.maxTurns) {
          const inspected = await this.run({
            order: input.order,
            attempt: input.attempt,
            issue: input.issue,
            failure,
            level: 'inspector',
            rung: levels.length + rung * this.budget.maxInspectorTurns + inspectorTurns,
            priorFamilies,
            proposedPatch: patch,
          })
          inspectorTurns += 1
          turns += 1
          if (inspected.receipt) receipts.push(inspected.receipt)
          if (inspected.kind === 'patch') {
            priorFamilies.push(inspected.attempt.route.family)
            patch = inspected.patch
            approved = true
            break
          }
          if (inspected.reason === 'ambiguous' || inspected.reason === 'rejected') {
            return this.decision(
              input,
              kind === 'merge-conflict' ? 'landing-conflict' : 'validation-failed',
              inspected.detail,
              evidence,
              receipts,
            )
          }
        }
        if (!approved) continue
      }
      const applied = await this.deps.applyPatch({
        order: input.order,
        attempt: input.attempt,
        custody: input.custody,
        repairRef: proposed.attempt.repairRef,
        patch: patch.patch,
        touchedPaths: patch.touchedPaths,
      })
      let materializedApplied: readonly string[]
      try {
        materializedApplied = await this.deps.evidence.materialize({
          source: 'patch-application',
          refs: applied.evidenceRefs ?? [],
          order: input.order,
          attempt: input.attempt,
          custody: input.custody,
        })
      } catch {
        return this.decision(
          input,
          'policy-refused',
          'Patch evidence could not be materialized into an authorized artifact.',
          evidence,
          receipts,
        )
      }
      const appliedEvidence = ShipwrightEvidenceRef.array().safeParse(materializedApplied)
      if (!appliedEvidence.success) {
        return this.decision(
          input,
          'policy-refused',
          'Patch application returned a non-durable or unsafe evidence reference.',
          evidence,
          receipts,
        )
      }
      for (const ref of appliedEvidence.data) evidence.add(ref)
      if (applied.ok) {
        return {
          kind: 'patched',
          repairRef: proposed.attempt.repairRef,
          candidateHeadSha: applied.candidateHeadSha,
          resultToken: encodeResultToken(input, receipts),
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
      evidence,
      receipts,
    )
  }

  /** Release daemon journals only after the shipping lifecycle has committed
   * the transition produced from this exact result token. */
  async acknowledge(input: {
    resultToken: string
    orderId: ShipOrder['id']
    attemptId: ShipAttempt['id']
    generation: number
  }): Promise<void> {
    const envelope = decodeResultToken(input.resultToken)
    if (
      envelope.orderId !== input.orderId ||
      envelope.attemptId !== input.attemptId ||
      envelope.generation !== input.generation
    ) {
      throw new Error('shipwright result acknowledgement fence mismatch')
    }
    for (const receipt of envelope.receipts) {
      this.deps.headless.headlessTurnAck(
        receipt.sessionId,
        receipt.turnId,
        receipt.requestDigest,
        receipt.accountId,
      )
    }
  }

  async run(input: {
    order: ShipOrder
    attempt: ShipAttempt
    issue: IssueWire
    failure: ShipwrightFailure
    level: ShipwrightLevel
    rung: number
    priorFamilies?: string[]
    proposedPatch?: ShipwrightPatch
  }): Promise<ShipwrightOutcome> {
    const owner = input.order.requestedBy.onBehalfOf
    if (!owner) {
      return {
        kind: 'hold',
        reason: 'unavailable',
        detail: 'shipping has no personal model owner',
        evidence: [],
      }
    }
    const sessionId = asSessionId(
      `shipwright:${input.attempt.id}:${input.attempt.leaseGeneration}:${input.level}:${input.rung}`,
    )
    const existing = this.deps.headless.headlessSession(sessionId)
    let route: ShipwrightRoute | null
    if (existing?.model && existing.effort && existing.accountId) {
      route = {
        level: input.level,
        agent: existing.agentKind as ShipwrightRoute['agent'],
        model: existing.model,
        effort: existing.effort,
        family: shipwrightModelFamily(
          existing.agentKind as ShipwrightRoute['agent'],
          existing.model,
        ),
        accountId: existing.accountId,
      }
    } else {
      const quota = await this.deps.quota(input.attempt.machineId)
      const selected = routeShipwright({
        settings: this.deps.settingsFor(owner),
        catalog: this.deps.modelCatalog(input.attempt.machineId),
        quota,
        level: input.level,
        priorFamilies: input.priorFamilies,
        resolveAccount: (agent, requested) =>
          this.deps.nativeAccountId(input.attempt.machineId, agent, requested),
      })
      route = selected
    }
    if (!route) {
      return {
        kind: 'hold',
        reason: 'unavailable',
        detail: 'no live shipwright route has usable quota',
        evidence: [],
      }
    }
    this.deps.headless.createHeadlessSession({
      sessionId,
      agentKind: route.agent,
      cwd: input.issue.repoPath,
      title: `Shipwright ${input.level}`,
      spawnedBy: `shipping:${input.attempt.id}:${input.level}`,
      machineId: input.attempt.machineId,
      ownerUserId: owner,
      createdBy: input.order.requestedBy,
      issueId: input.issue.id,
      accountId: route.accountId,
      model: route.model,
      effort: route.effort,
      requireNoTools: true,
    })
    const turnId = `shipwright:${input.attempt.id}:${input.attempt.leaseGeneration}:${input.level}:${input.rung}`
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
      toolPolicy: 'none',
      timeoutMs: this.budget.timeoutMs,
    })
    const receipt =
      response.requestDigest && response.accountId
        ? {
            sessionId,
            turnId,
            requestDigest: response.requestDigest,
            accountId: response.accountId,
          }
        : undefined
    if (!receipt) {
      return {
        kind: 'hold',
        reason: 'unavailable',
        detail: 'shipwright result was not bound to its durable request identity',
        evidence: [],
      }
    }
    if (!response.ok || !response.output) {
      return {
        kind: 'hold',
        reason: 'unavailable',
        detail: response.error || 'shipwright returned no structured result',
        evidence: [],
        receipt,
      }
    }
    const parse =
      input.level === 'inspector'
        ? jsonSchema(ShipwrightInspectionContract)
        : jsonSchema(ShipwrightPatchContract)
    const decoded = parse(response.output)
    if (!decoded) {
      return {
        kind: 'hold',
        reason: 'invalid-output',
        detail: 'shipwright output did not match its patch contract',
        evidence: [],
        receipt,
      }
    }
    const normalized =
      decoded.kind === 'inspection'
        ? ShipwrightInspectionContract.safeParse(decoded)
        : ShipwrightPatchContract.safeParse(decoded)
    if (!normalized.success) {
      return {
        kind: 'hold',
        reason: 'invalid-output',
        detail: 'shipwright output did not match its patch contract',
        evidence: [],
        receipt,
      }
    }
    const contract = normalized.data
    if (contract.kind === 'inspection') {
      if (contract.verdict !== 'safe') {
        return {
          kind: 'hold',
          reason: contract.verdict === 'ambiguous' ? 'ambiguous' : 'rejected',
          detail: contract.summary,
          evidence: [],
          receipt,
        }
      }
      if (!input.proposedPatch) {
        return {
          kind: 'hold',
          reason: 'invalid-output',
          detail: 'inspector had no patch to review',
          evidence: [],
          receipt,
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
        patch: input.proposedPatch,
        receipt,
      }
    }
    const checked = validateShipwrightPatch(contract, this.budget)
    if (!checked.ok) {
      return {
        kind: 'hold',
        reason: 'invalid-output',
        detail: checked.reason,
        evidence: [],
        receipt,
      }
    }
    if (contract.behaviorImpact !== 'none') {
      return {
        kind: 'hold',
        reason: 'ambiguous',
        detail: contract.summary,
        evidence: [],
        receipt,
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
      receipt,
    }
  }

  requiresInspection(patch: ShipwrightPatch): boolean {
    const checked = validateShipwrightPatch(patch, this.budget)
    return checked.ok && checked.risky
  }

  private decision(
    input: ShipwrightRepairInput,
    reasonCode: ShipHoldCode,
    detail: string,
    evidence: ReadonlySet<ShipwrightEvidenceRefValue>,
    receipts: readonly ShipwrightResultReceipt[] = [],
  ): Extract<ShipwrightRepairRecommendation, { kind: 'needs-decision' }> {
    return {
      kind: 'needs-decision',
      reasonCode,
      headline: 'Needs your decision',
      detail,
      evidenceRefs: [...evidence],
      actions: ['retry', 'return-to-issue', 'open-repair'],
      resultToken: encodeResultToken(input, receipts),
    }
  }
}
