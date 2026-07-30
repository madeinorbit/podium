/**
 * THE L1 GATE OVER THE THREE SPEC CONTRACTS.
 *
 * Written against the failure class that dominated this run — suites that cannot
 * say NO. Every absence or agreement assertion below is paired with a probe that
 * shows the same instrument REPORTING the opposite on a planted input, because a
 * lint that stopped looking returns `[]` exactly like a lint that found nothing,
 * and a total lookup function returns a plausible default exactly like a real
 * declaration.
 *
 * The sharpest one is the matrix binding. `visibilityClassOf` is TOTAL and
 * default-closed: an id it has never heard of resolves to `personal`. So the
 * question worth asking of that test is what environmental fact its refusing arm
 * depends on — and the answer is that the `pspec-component` row EXISTS and says
 * `owned-compute`. It is shown here twice over: the contracts are asserted against
 * the real index, and then the SAME function is called with an empty index to prove
 * it answers differently when the declaration is gone. Delete POD-385's matrix row
 * and this file goes red rather than agreeing with a backstop.
 */

import {
  type MatrixRow,
  OWNERSHIP_MATRIX,
  type VisibilityClass,
  visibilityClassOf,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  type AnyCommandContract,
  classificationErrors,
  registryClassificationErrors,
} from '../contract'
import {
  SPEC_CONTRACT_NAMES,
  SPEC_CONTRACTS,
  type SpecContractName,
  specsCreateInput,
  specsRemoveInput,
  specsSaveInput,
} from './contracts'

/** The matrix row every spec write lands in. One string, used by every test
 *  below, so a typo cannot make one assertion pass against a different row. */
const PSPEC_ROW = 'pspec-component'

/**
 * Is this id a row the matrix actually DECLARES?
 *
 * `visibilityClassOf` is a semantic backstop, not a spell-checker: a mistyped row
 * id resolves `personal` and would match any contract classified `personal`. This
 * separates "declared" from "never heard of it".
 */
const isDeclaredMatrixRow = (row: string): boolean =>
  OWNERSHIP_MATRIX.some((r) => (r.id as string) === row)

/** An index with nothing in it — the counterfactual world where POD-385 never
 *  added the row. `visibilityClassOf` takes the index, so this is the real
 *  function under a real absence, not a re-implementation of its default. */
const EMPTY_INDEX = new Map<string, MatrixRow>()

const contracts = (): AnyCommandContract[] =>
  Object.values(SPEC_CONTRACTS).map((c) => c as AnyCommandContract)

const THREE: readonly SpecContractName[] = ['create', 'remove', 'save']

describe('the three spec write contracts', () => {
  it('declares exactly create · save · remove, and no fourth', () => {
    expect(SPEC_CONTRACT_NAMES).toEqual([...THREE])
    expect(Object.values(SPEC_CONTRACTS).map((c) => c.name).sort()).toEqual([
      'specs.create',
      'specs.remove',
      'specs.save',
    ])
  })

  it('passes the classification lint with no unclassified field', () => {
    expect(registryClassificationErrors(contracts())).toEqual([])
  })

  /**
   * THE INSTRUMENT PROBE for the assertion above, and it is deliberately aimed at
   * the rule this family is most likely to break. `machineVerb: 'use'` plus
   * `offline-eligible` is ADR 3 Amendment 1 D18.3, and a spec body is
   * entity-shaped content that would look perfectly queueable to the next author.
   */
  it('reports a defect when there is one — so the empty list above means something', () => {
    const queued = {
      ...(SPEC_CONTRACTS.save as AnyCommandContract),
      delivery: { ...SPEC_CONTRACTS.save.delivery, class: 'offline-eligible' },
    } as AnyCommandContract
    // The mutant CHANGED the value — a perturbation to what a field already held
    // reads as a pass and is non-evidence (POD-311).
    expect(SPEC_CONTRACTS.save.delivery.class).toBe('online-only')
    expect(classificationErrors(queued)).toEqual([
      'specs.save: machine `use` executes on someone else’s hardware and may not be offline-eligible (ADR 3 Amendment 1 D18.3) — name it in MACHINE_USE_OFFLINE_EXCEPTIONS if it genuinely is one',
    ])
  })

  /**
   * THE CONTRACT AND THE MATRIX, LOCKED TOGETHER — see the file header for why
   * this particular test is the one that could most easily have been vacuous.
   */
  it('agrees with ADR 1’s matrix about the class every spec write lands in', () => {
    expect(isDeclaredMatrixRow(PSPEC_ROW)).toBe(true)
    for (const contract of contracts()) {
      expect([contract.name, contract.visibility]).toEqual([
        contract.name,
        visibilityClassOf(PSPEC_ROW),
      ])
    }
    // And it is NOT the default. `owned-compute` is unreachable by forgetting: the
    // backstop's answer is `personal`, so the agreement above is reading a real
    // declaration. Proven with the real function under an EMPTY index rather than
    // by restating what the default is supposed to be.
    expect(visibilityClassOf(PSPEC_ROW)).toBe<VisibilityClass>('owned-compute')
    expect(visibilityClassOf(PSPEC_ROW, EMPTY_INDEX)).toBe<VisibilityClass>('personal')
    expect(isDeclaredMatrixRow('pspec-component-that-does-not-exist')).toBe(false)
  })

  it('names a real matrix row as the thing `create` creates', () => {
    // `creates` is prose that nothing else checks; an entity name that matches no
    // row would read as a classification while pointing nowhere.
    expect(SPEC_CONTRACTS.create.ownership.creates).toEqual([PSPEC_ROW])
    for (const name of SPEC_CONTRACTS.create.ownership.creates) {
      expect([name, isDeclaredMatrixRow(name)]).toEqual([name, true])
    }
    // The counterfactual: the other two mint nothing, and say so.
    expect(SPEC_CONTRACTS.save.ownership.creates).toEqual([])
    expect(SPEC_CONTRACTS.remove.ownership.creates).toEqual([])
  })
})

describe('exposure — opt-in, and MCP is absent on purpose', () => {
  it('serves the three arms that are wired and nothing else', () => {
    for (const [name, contract] of Object.entries(SPEC_CONTRACTS)) {
      expect([name, [...contract.exposure]]).toEqual([name, ['trpc', 'relay', 'cli']])
    }
  })

  /**
   * The declaration POD-311's finding does NOT transfer to. Issues collapse `cli`
   * and `mcp` into one decision because `issue-mcp.ts` derives its tools from
   * `ISSUE_COMMANDS`; nothing derives an MCP tool from `SPEC_COMMANDS`, so for this
   * family they are two answers. The reach half of the claim — that no `spec_*`
   * tool exists and that every CLI verb does — is checked against the RUNNING
   * objects in `apps/server/src/modules/specs/spec-surface.runtime.test.ts`,
   * because a table in this package cannot see what a server serves.
   */
  it('names neither mcp nor outbox on any of the three', () => {
    for (const contract of contracts()) {
      expect([contract.name, contract.exposure.includes('mcp')]).toEqual([contract.name, false])
      expect([contract.name, contract.exposure.includes('outbox')]).toEqual([contract.name, false])
    }
    // The counterfactual, so "includes returns false" is a decision and not a
    // property of the array: the tags that ARE named resolve true through the
    // identical call.
    expect(SPEC_CONTRACTS.create.exposure.includes('cli')).toBe(true)
    expect(SPEC_CONTRACTS.create.exposure.includes('relay')).toBe(true)
  })
})

describe('the machine boundary — this family’s one real policy question', () => {
  it('authorizes every write against the machine with the `use` verb', () => {
    for (const contract of contracts()) {
      expect([contract.name, contract.policy.resource, contract.policy.machineVerb]).toEqual([
        contract.name,
        'machine',
        'use',
      ])
      expect([contract.name, contract.policy.action]).toEqual([contract.name, 'write'])
      expect([contract.name, contract.policy.roleFloor]).toEqual([contract.name, 'member'])
    }
  })

  /**
   * THE LINT COUPLING, CHECKED DELIBERATELY RATHER THAN DISCOVERED.
   *
   * `classificationErrors` enforces ADR 9 D6 in ONE direction: `owned-compute`
   * state must be authorized against the `machine` resource, because there is
   * nothing else for its grants to hang on. The converse does not hold and must
   * not be read in — a `machine` resource does NOT imply `owned-compute` state,
   * which is why a spawn (machine `use`, personal session) is correctly classified.
   *
   * This family satisfies the implication honestly rather than by coincidence: the
   * machine is what the shipped service authorizes against. Both arms are shown —
   * the coupling firing on a planted violation, and the second `machine` rule
   * firing when the verb is dropped — so neither is trusted on the strength of the
   * three contracts happening to pass.
   */
  it('is bound by ADR 9 D6’s coupling, and the lint enforces both halves of it', () => {
    const notAMachine = {
      ...(SPEC_CONTRACTS.create as AnyCommandContract),
      policy: { ...SPEC_CONTRACTS.create.policy, resource: 'issue', machineVerb: undefined },
    } as AnyCommandContract
    expect(SPEC_CONTRACTS.create.policy.resource).toBe('machine')
    expect(classificationErrors(notAMachine)).toEqual([
      'specs.create: visibility `owned-compute` must name the `machine` resource (ADR 9 D6)',
    ])
    // …and a machine resource that forgets its verb is caught too (Amendment 1 D18),
    // so `machineVerb: 'use'` above is a declaration the lint would miss the absence of.
    const verbless = {
      ...(SPEC_CONTRACTS.create as AnyCommandContract),
      policy: { ...SPEC_CONTRACTS.create.policy, machineVerb: undefined },
    } as AnyCommandContract
    expect(SPEC_CONTRACTS.create.policy.machineVerb).toBe('use')
    expect(classificationErrors(verbless)).toEqual([
      'specs.create: a `machine` resource must declare its verb (ADR 3 Amendment 1 D18)',
    ])
  })

  /**
   * readiness §3.1.4 M5 over Amendment 1 D20.2, and the ONLY contract family in
   * this package that answers `true`. The probe shows the lint's refusing arm is
   * reachable: flip the flag and `classificationErrors` names M5.
   */
  it('keeps unauthorized distinguishable from unreachable, and the lint would notice if it did not', () => {
    for (const contract of contracts()) {
      expect(contract.errorConsistency.callerSuppliedTargetId).toBe(true)
      expect([
        contract.name,
        contract.errorConsistency.callerSuppliedTargetId &&
          contract.errorConsistency.distinguishesUnauthorizedFromUnreachable,
      ]).toEqual([contract.name, true])
    }
    const collapsed = {
      ...(SPEC_CONTRACTS.remove as AnyCommandContract),
      errorConsistency: {
        ...SPEC_CONTRACTS.remove.errorConsistency,
        distinguishesUnauthorizedFromUnreachable: false,
      },
    } as AnyCommandContract
    expect(
      SPEC_CONTRACTS.remove.errorConsistency.distinguishesUnauthorizedFromUnreachable,
    ).toBe(true)
    expect(classificationErrors(collapsed)).toEqual([
      'specs.remove: machine `use` must keep unauthorized distinguishable from unreachable (readiness §3.1.4 M5)',
    ])
  })

  it('puts the destructive write behind a confirmation and the other two not', () => {
    // Written as a whole map rather than three assertions: the content of this
    // test is the DIFFERENCE, and a per-contract loop asserting 'confirm'
    // everywhere would pass just as happily on a surface that confirmed nothing.
    expect(
      Object.fromEntries(
        Object.entries(SPEC_CONTRACTS).map(([n, c]) => [n, c.policy.confirmation]),
      ),
    ).toEqual({ create: 'none', save: 'none', remove: 'confirm' })
  })

  it('records one online-only class per contract, each with its own reasoning', () => {
    for (const contract of contracts()) {
      expect([contract.name, contract.delivery.class]).toEqual([contract.name, 'online-only'])
      expect(contract.delivery.outboxReconciliation).toContain('D18.3')
      expect(contract.delivery.applyTimeReauthorization).toContain('LIVE')
      expect(contract.policy.rationale.length).toBeGreaterThan(80)
    }
  })

  it('stamps both halves of the attribution pair from the transport', () => {
    for (const contract of contracts()) {
      expect([contract.name, contract.attribution.actor, contract.attribution.onBehalfOf]).toEqual([
        contract.name,
        'from-capability',
        'from-delegation',
      ])
      expect(contract.attribution.wirePlacement).toBe('separate-field')
      expect([...contract.attribution.reservedWireKeys]).toEqual(['actor', 'onBehalfOf'])
    }
  })

  it('reviews redaction and redacts nothing, having considered the one candidate', () => {
    for (const contract of contracts()) {
      expect(contract.redaction.reviewed).toBe(true)
      expect(contract.redaction.inputPaths).toEqual([])
      expect(contract.redaction.outputPaths).toEqual([])
      // The empty list is only worth anything if the note says WHICH path was
      // weighed — otherwise `[]` is indistinguishable from nobody looking.
      expect(contract.redaction.note).toContain('repoPath')
    }
  })
})

describe('the input schemas refuse what the shipped surface refuses', () => {
  it('requires a non-empty repoPath on all three — the routing key the gate resolves', () => {
    for (const schema of [specsCreateInput, specsSaveInput, specsRemoveInput]) {
      expect(schema.safeParse({ repoPath: '', id: 'SP-abcd', title: 't', parent: '' }).success).toBe(
        false,
      )
      expect(schema.safeParse({ id: 'SP-abcd', title: 't', parent: '' }).success).toBe(false)
    }
  })

  it('requires a title on create and an id on save/remove', () => {
    expect(specsCreateInput.safeParse({ repoPath: '/r', title: '', parent: 'SP-root' }).success).toBe(
      false,
    )
    expect(specsSaveInput.safeParse({ repoPath: '/r', id: '' }).success).toBe(false)
    expect(specsRemoveInput.safeParse({ repoPath: '/r', id: '' }).success).toBe(false)
  })

  it('accepts what the CLI and the web UI actually send — so the refusals above are not blanket', () => {
    expect(
      specsCreateInput.safeParse({ repoPath: '/r', title: 'Sync', parent: 'SP-root' }).success,
    ).toBe(true)
    // `parent: ''` is the ROOT case and must stay accepted: `createSpec` treats an
    // empty parent as the root, and tightening it here would break the one call
    // that mints SP-root's children.
    expect(specsCreateInput.safeParse({ repoPath: '/r', title: 'Sync', parent: '' }).success).toBe(
      true,
    )
    // Every save field is optional and an absent one means "leave it" — a partial
    // patch is the shipped shape, not a degenerate one.
    expect(specsSaveInput.safeParse({ repoPath: '/r', id: 'SP-abcd' }).success).toBe(true)
    expect(
      specsSaveInput.safeParse({ repoPath: '/r', id: 'SP-abcd', status: 'superseded' }).success,
    ).toBe(true)
    expect(specsRemoveInput.safeParse({ repoPath: '/r', id: 'SP-abcd' }).success).toBe(true)
  })

  it('refuses a status outside the three the store writes', () => {
    expect(
      specsSaveInput.safeParse({ repoPath: '/r', id: 'SP-abcd', status: 'archived' }).success,
    ).toBe(false)
    expect(
      specsSaveInput.safeParse({ repoPath: '/r', id: 'SP-abcd', status: 'draft' }).success,
    ).toBe(true)
  })
})
