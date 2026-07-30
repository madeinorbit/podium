/**
 * The L1 gate over the eleven workflow contracts: classifications are TOTAL,
 * the advance partition is exact, and the decision function is default-closed.
 *
 * Every absence assertion below is preceded by a probe showing the instrument
 * can report the corresponding PRESENCE. A classification lint that returned
 * `[]` because it stopped looking is indistinguishable from one that found
 * nothing wrong, and the two have been confused on this codebase before.
 */

import { describe, expect, it } from 'vitest'
import {
  type AnyCommandContract,
  classificationErrors,
  registryClassificationErrors,
} from '../contract'
import {
  WORKFLOW_ADVANCE_NAMES,
  WORKFLOW_CONTRACTS,
  type WorkflowContractName,
  workflowAdvanceOf,
} from './contracts'
import {
  AMBIGUOUS_ADVANCE_MESSAGE,
  advanceIdempotencyKey,
  assertAdvanceIsDeliverable,
} from './idempotency'
import {
  canReadWorkflowEntity,
  SINGLE_USER_HUMAN,
  SINGLE_USER_WORKFLOW_OWNERSHIP,
  type WorkflowEntityRef,
  type WorkflowOwnershipPort,
  type WorkflowPrincipal,
  workflowDecision,
} from './ownership'

const ELEVEN: readonly WorkflowContractName[] = [
  'create',
  'revise',
  'fork',
  'publish',
  'assign',
  'profileSave',
  'checkpoint',
  'assignStep',
  'skip',
  'retry',
  'adopt',
]

const contracts = (): AnyCommandContract[] =>
  Object.values(WORKFLOW_CONTRACTS).map((c) => c as AnyCommandContract)

describe('the eleven workflow contracts', () => {
  it('declares exactly the eleven mutations POD-311 named, and no twelfth', () => {
    expect(Object.keys(WORKFLOW_CONTRACTS).sort()).toEqual([...ELEVEN].sort())
  })

  it('passes the classification lint with no unclassified field', () => {
    expect(registryClassificationErrors(contracts())).toEqual([])
  })

  /**
   * THE INSTRUMENT PROBE for the assertion above. A lint whose every rule
   * silently no-ops returns `[]` for any input, which reads exactly like a
   * clean bill of health — so it is shown reporting a real defect on a
   * contract built from a real one, before its silence is believed.
   */
  it('reports a defect when there is one — so the empty list above means something', () => {
    const broken = {
      ...(WORKFLOW_CONTRACTS.checkpoint as AnyCommandContract),
      exposure: ['outbox'],
    } as AnyCommandContract
    expect(classificationErrors(broken)).toEqual([
      'workflows.checkpoint: exposed on `outbox` without an offline-eligible delivery class (ADR 3 D3 rule 2)',
    ])
  })

  it('serves every contract on the two arms that are wired, and nothing on outbox', () => {
    for (const [name, contract] of Object.entries(WORKFLOW_CONTRACTS)) {
      expect([name, [...contract.exposure]]).toEqual([name, ['trpc', 'relay']])
    }
  })

  it('reviews redaction on every contract and redacts the account id on the one that names credentials', () => {
    for (const contract of contracts()) expect(contract.redaction.reviewed).toBe(true)
    expect(WORKFLOW_CONTRACTS.profileSave.redaction.inputPaths).toEqual(['accountId'])
    expect(WORKFLOW_CONTRACTS.profileSave.redaction.outputPaths).toEqual(['accountId'])
    // The counterfactual: a library write that carries no credential redacts
    // nothing, so "reviewed" is doing work rather than rubber-stamping.
    expect(WORKFLOW_CONTRACTS.create.redaction.inputPaths).toEqual([])
  })

  it('records an offline class per contract with its reasoning, split library vs advance', () => {
    const byClass = Object.fromEntries(
      Object.entries(WORKFLOW_CONTRACTS).map(([n, c]) => [n, c.delivery.class]),
    )
    expect(byClass).toEqual({
      create: 'offline-eligible',
      revise: 'offline-eligible',
      fork: 'offline-eligible',
      publish: 'offline-eligible',
      assign: 'offline-eligible',
      profileSave: 'online-sensitive',
      checkpoint: 'online-only',
      assignStep: 'online-only',
      skip: 'online-only',
      retry: 'online-only',
      adopt: 'online-only',
    })
    for (const contract of contracts()) {
      expect(contract.delivery.outboxReconciliation.length).toBeGreaterThan(80)
      expect(contract.delivery.applyTimeReauthorization).toContain('LIVE')
    }
  })

  it('stamps both halves of the attribution pair from the transport on every contract', () => {
    for (const contract of contracts()) {
      expect([contract.name, contract.attribution.actor, contract.attribution.onBehalfOf]).toEqual([
        contract.name,
        'from-capability',
        'from-delegation',
      ])
      expect(contract.attribution.wirePlacement).toBe('separate-field')
    }
  })
})

describe('the advance partition', () => {
  it('marks the five run-scoped advances and only those', () => {
    expect([...WORKFLOW_ADVANCE_NAMES].sort()).toEqual([
      'adopt',
      'assignStep',
      'checkpoint',
      'retry',
      'skip',
    ])
  })

  it('gives every advance the RUN as its resource scope, with a rationale', () => {
    for (const name of WORKFLOW_ADVANCE_NAMES) {
      const advance = workflowAdvanceOf(name)
      expect([name, advance?.resourceScope]).toEqual([name, 'run'])
      expect(advance?.targetNamedBy === 'step' || advance?.targetNamedBy === 'run').toBe(true)
      expect(advance?.rationale.length).toBeGreaterThan(40)
    }
  })

  it('leaves library CRUD with no advance declaration — the absence is the claim', () => {
    for (const name of ['create', 'revise', 'fork', 'publish', 'assign', 'profileSave'] as const) {
      expect([name, workflowAdvanceOf(name)]).toEqual([name, undefined])
    }
  })

  it('requires a step id on the three advances that can always name one', () => {
    // skip / retry name their step in the SCHEMA, so the ambiguous frame is
    // unreachable for them by construction rather than by a runtime check.
    expect(WORKFLOW_CONTRACTS.skip.input.safeParse({ reason: 'x' }).success).toBe(false)
    expect(WORKFLOW_CONTRACTS.retry.input.safeParse({}).success).toBe(false)
    expect(WORKFLOW_CONTRACTS.assignStep.input.safeParse({ sessionId: null }).success).toBe(false)
    // checkpoint and adopt can NOT, which is why the framework check exists.
    expect(WORKFLOW_CONTRACTS.checkpoint.input.safeParse({ status: 'complete' }).success).toBe(true)
  })
})

describe('run-scoped idempotency', () => {
  const stepped = { targetNamedBy: 'step', targetHasSteps: true } as const

  it('refuses the one frame whose duplicate is undetectable', () => {
    expect(() => assertAdvanceIsDeliverable({ ...stepped })).toThrow(AMBIGUOUS_ADVANCE_MESSAGE)
  })

  it('accepts a frame that names its step, and one that carries a mutation id', () => {
    // The counterfactual for the refusal above: both single-absence frames are
    // ACCEPTED, so the check is the intersection it claims to be and not a
    // blanket requirement wearing a narrower name.
    expect(() => assertAdvanceIsDeliverable({ ...stepped, stepId: 's1' })).not.toThrow()
    expect(() => assertAdvanceIsDeliverable({ ...stepped, mutationId: 'm1' })).not.toThrow()
    expect(() =>
      assertAdvanceIsDeliverable({ ...stepped, stepId: 's1', mutationId: 'm1' }),
    ).not.toThrow()
  })

  it('does not refuse a frame that has NO step it could name', () => {
    // A prompt-only run and a run-targeted advance have no step, so the remedy
    // the message offers does not exist for them — and neither does the defect:
    // their target does not move between deliveries. Refusing them would be a
    // rule punishing callers who cannot comply.
    expect(() =>
      assertAdvanceIsDeliverable({ targetNamedBy: 'step', targetHasSteps: false }),
    ).not.toThrow()
    expect(() =>
      assertAdvanceIsDeliverable({ targetNamedBy: 'run', targetHasSteps: true }),
    ).not.toThrow()
  })

  it('scopes the ledger key to the RUN, so one mutation id cannot cross runs', () => {
    const a = advanceIdempotencyKey({
      contract: 'workflows.checkpoint',
      runId: 'r1',
      mutationId: 'm',
    })
    const b = advanceIdempotencyKey({
      contract: 'workflows.checkpoint',
      runId: 'r2',
      mutationId: 'm',
    })
    expect(a).not.toBe(b)
    // …and to the COMMAND, so a skip and a retry replayed under one id differ.
    const c = advanceIdempotencyKey({ contract: 'workflows.skip', runId: 'r1', mutationId: 'm' })
    expect(c).not.toBe(a)
    // Same command, same run, same id — the one case that MUST collide.
    expect(
      advanceIdempotencyKey({ contract: 'workflows.checkpoint', runId: 'r1', mutationId: 'm' }),
    ).toBe(a)
  })
})

describe('the workflow decision — default-closed', () => {
  const OWNER = 'user:owner'
  const OTHER = 'user:other'
  const definition: WorkflowEntityRef = { kind: 'workflow-definition', id: 'wf_1' }
  const library: WorkflowEntityRef = { kind: 'workflow-library-entry', id: 'wf_g' }

  const port = (grants: readonly [string, string][] = []): WorkflowOwnershipPort => ({
    ownerOf: (e) => (e.id === 'wf_1' ? OWNER : null),
    hasGrant: (user, e, verb) => grants.some(([u, k]) => u === user && k === `${e.id}:${verb}`),
  })

  const member = (human: string | null): WorkflowPrincipal => ({
    actor: 'agent:a',
    onBehalfOf: human,
    role: 'member',
  })
  const admin: WorkflowPrincipal = { actor: 'user:a', onBehalfOf: OTHER, role: 'admin' }

  it('allows the owner', () => {
    expect(workflowDecision(member(OWNER), definition, 'write', port())).toBe('allowed')
  })

  it('denies another member — the cross-user write this issue closes', () => {
    expect(workflowDecision(member(OTHER), definition, 'write', port())).toBe('denied')
    expect(workflowDecision(member(OTHER), definition, 'read', port())).toBe('denied')
  })

  it('allows another member holding an explicit grant, for that verb only', () => {
    const shared = port([[OTHER, 'wf_1:read']])
    expect(workflowDecision(member(OTHER), definition, 'read', shared)).toBe('allowed')
    expect(workflowDecision(member(OTHER), definition, 'write', shared)).toBe('denied')
  })

  it('denies a revoked delegation BEFORE any other rule — including for an admin and an owner', () => {
    expect(workflowDecision(member(null), definition, 'read', port())).toBe('denied')
    expect(workflowDecision({ ...admin, onBehalfOf: null }, definition, 'write', port())).toBe(
      'denied',
    )
    expect(canReadWorkflowEntity({ ...admin, onBehalfOf: null }, library, port())).toBe(false)
  })

  it('fails closed on an UNOWNED row rather than treating it as everyone’s', () => {
    const orphan: WorkflowEntityRef = { kind: 'workflow-run', id: 'wrun_orphan' }
    expect(workflowDecision(member(OWNER), orphan, 'read', port())).toBe('denied')
    expect(workflowDecision(admin, orphan, 'read', port())).toBe('allowed')
  })

  it('makes a global library WRITE admin-grade even for the row’s own owner', () => {
    // The counterfactual that makes this an admin rule and not an ownership
    // one: `wf_g` is unowned here, so a member is refused. `wf_1` IS owned by
    // OWNER and a member write on it is allowed above — so the denial below is
    // the library arm firing, not the owner check failing.
    const owned = { kind: 'workflow-library-entry', id: 'wf_1' } as const
    expect(workflowDecision(member(OWNER), owned, 'write', port())).toBe('denied')
    expect(workflowDecision(member(OWNER), library, 'write', port())).toBe('denied')
    expect(workflowDecision(admin, library, 'write', port())).toBe('allowed')
  })

  it('reads a library entry through an explicit GRANT, never an ambient arm', () => {
    // The read side is the ordinary decision — no `return true` for global.
    // Widening the tenant-visible floor is ADR 1 Amendment 1 D9.3's ratchet and
    // POD-1071's to turn; ADR 9 D2's grant edge gets the same result revocably.
    expect(canReadWorkflowEntity(member(OTHER), library, port())).toBe(false)
    const shared = port([[OTHER, 'wf_g:read']])
    expect(canReadWorkflowEntity(member(OTHER), library, shared)).toBe(true)
    // …and a read grant on a library entry still does not open its WRITE path.
    expect(workflowDecision(member(OTHER), library, 'write', shared)).toBe('denied')
  })

  it('keeps the single-user present unchanged — one human owns everything', () => {
    const single = member(SINGLE_USER_HUMAN)
    expect(workflowDecision(single, definition, 'write', SINGLE_USER_WORKFLOW_OWNERSHIP)).toBe(
      'allowed',
    )
    // …but is NOT generous about grade: the substrate path still needs admin,
    // which is what closes the ambient global-scope arm even before accounts.
    expect(workflowDecision(single, library, 'write', SINGLE_USER_WORKFLOW_OWNERSHIP)).toBe(
      'denied',
    )
    expect(SINGLE_USER_WORKFLOW_OWNERSHIP.hasGrant(SINGLE_USER_HUMAN, definition, 'read')).toBe(
      false,
    )
  })
})
