/**
 * The superagent contract table, pinned (POD-383).
 *
 * EVERY ASSERTION HERE IS SHOWN ABLE TO SAY NO. That is the discipline this run
 * paid for five times over (POD-351/391/732/306/311), and three checks in this
 * file would otherwise be vacuous by construction:
 *
 *  · `visibilityClassOf` is TOTAL — an unknown row id resolves `personal`, which
 *    is every contract's answer, so the matrix assertion would pass against a
 *    typo. It is paired with a declared-row probe and a counterfactual.
 *  · `classificationErrors` returning `[]` is indistinguishable from a lint
 *    whose rules all no-op, so it is shown reporting a real defect first.
 *  · "`send` is not in the table" is satisfied perfectly by an EMPTY table, so
 *    it is paired with the positive: `sendTurn` IS there, and there are eight.
 *
 * EIGHT, NOT SEVEN (POD-1105). POD-782 added `ensureSession` to the table and to
 * the contract file's prose but not to this file, so three assertions here sat
 * red on main. The count now lives in ONE hand-typed place — `EIGHT` — and the
 * length assertions are read off it rather than restating a numeral, because
 * three copies of a number is what drifted: the numeral is not the check, the
 * key list asserted against the table is, and a copy of it can only fail LATE.
 */

import { OWNERSHIP_MATRIX, visibilityClassOf } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  type AnyCommandContract,
  classificationErrors,
  registryClassificationErrors,
} from '../contract'
import {
  SUPERAGENT_COMMAND_NAMES,
  SUPERAGENT_CONTRACTS,
  type SuperagentContractName,
  superagentConciergeInput,
  superagentSendTurnInput,
  superagentUserFocus,
} from './contracts'

const EIGHT: SuperagentContractName[] = [
  'sendTurn',
  'interruptTurn',
  'openInTerminal',
  'clear',
  'restart',
  'ensureSession',
  'startBtw',
  'concierge',
]

/** The matrix row all eight write into. */
const SUPERAGENT_ROW = 'superagent-state'

/**
 * Is this id a row the matrix actually declares? `visibilityClassOf` cannot
 * answer it — see the file header — so this distinguishes "declared personal"
 * from "never heard of it".
 */
const isDeclaredMatrixRow = (row: string): boolean =>
  OWNERSHIP_MATRIX.some((r) => (r.id as string) === row)

const contracts = (): AnyCommandContract[] =>
  Object.values(SUPERAGENT_CONTRACTS).map((c) => c as AnyCommandContract)

describe('the eight superagent thread contracts', () => {
  it('declares exactly the eight thread commands', () => {
    expect(Object.keys(SUPERAGENT_CONTRACTS).sort()).toEqual([...EIGHT].sort())
  })

  /**
   * THE DEDUPE, ASSERTED BOTH WAYS.
   *
   * The absence claim alone is satisfied by an empty table — POD-732's "an empty
   * router satisfies every absence claim perfectly" — so the surviving name and
   * the count are asserted in the same test. A table that lost `sendTurn` fails
   * here rather than reading as a successful deletion.
   */
  it('keeps ONE name for the turn command: sendTurn survives, send is gone', () => {
    expect(SUPERAGENT_COMMAND_NAMES).toContain('superagent.sendTurn')
    expect(SUPERAGENT_COMMAND_NAMES).not.toContain('superagent.send')
    expect(SUPERAGENT_COMMAND_NAMES).toHaveLength(EIGHT.length)
    // …and no two contracts share a body-shaped duplicate: every dotted name is
    // distinct, which `registryClassificationErrors` also checks, here made local.
    expect(new Set(SUPERAGENT_COMMAND_NAMES).size).toBe(EIGHT.length)
  })

  it('passes the classification lint with no unclassified field', () => {
    expect(registryClassificationErrors(contracts())).toEqual([])
  })

  /**
   * THE INSTRUMENT PROBE for the assertion above: a lint whose every rule
   * no-ops returns `[]` for any input. Two defects, each firing a DIFFERENT
   * rule, built from real contracts — one on the machine-placing arm and one on
   * the control arm, so a probe that only exercised the arm-0 shape is not what
   * is being trusted.
   */
  it('reports a defect when there is one — so the empty list above means something', () => {
    const outboxWithoutOfflineClass = {
      ...(SUPERAGENT_CONTRACTS.sendTurn as AnyCommandContract),
      exposure: ['outbox'],
    } as AnyCommandContract
    expect(classificationErrors(outboxWithoutOfflineClass)).toEqual([
      'superagent.sendTurn: exposed on `outbox` without an offline-eligible delivery class (ADR 3 D3 rule 2)',
    ])
    const compute = SUPERAGENT_CONTRACTS.openInTerminal as AnyCommandContract
    const unverbed = {
      ...compute,
      policy: { ...compute.policy, machineVerb: undefined },
    } as AnyCommandContract
    expect(classificationErrors(unverbed)).toEqual([
      'superagent.openInTerminal: a `machine` resource must declare its verb (ADR 3 Amendment 1 D18)',
    ])
  })

  it('serves the one arm that is wired, and nothing else — exposure is opt-in', () => {
    for (const [name, contract] of Object.entries(SUPERAGENT_CONTRACTS)) {
      expect([name, [...contract.exposure]]).toEqual([name, ['trpc']])
    }
  })

  /**
   * THE CONTRACT AND THE MATRIX, LOCKED TOGETHER — with the two probes that
   * make the lock mean something (see the file header).
   */
  it('agrees with ADR 1’s matrix about the class every superagent command writes', () => {
    expect(isDeclaredMatrixRow(SUPERAGENT_ROW)).toBe(true)
    for (const [name, contract] of Object.entries(SUPERAGENT_CONTRACTS)) {
      expect([name, contract.visibility]).toEqual([name, visibilityClassOf(SUPERAGENT_ROW)])
    }
    // The backstop, shown firing: an id the matrix never heard of ALSO resolves
    // `personal`, which is why the declared-row probe above is not decoration.
    expect(isDeclaredMatrixRow('superagent-nonexistent')).toBe(false)
    expect(visibilityClassOf('superagent-nonexistent')).toBe('personal')
  })

  /**
   * Not `per-user-state`, and asserted rather than asserted-by-comment: the
   * matrix row for superagent state must itself be `personal`, because if
   * POD-1071 reclassifies it the constant above follows the row and this
   * distinction is the one thing that would silently move with it.
   */
  it('classifies superagent state as personal, not as a per-reader facet', () => {
    const row = OWNERSHIP_MATRIX.find((r) => (r.id as string) === SUPERAGENT_ROW)
    expect(row?.visibility).toBe('personal')
    expect(row?.inheritanceOnCreate.kind).toBe('on-behalf-of-human')
    for (const contract of contracts()) expect(contract.visibility).not.toBe('per-user-state')
  })

  /**
   * The two exceptions carry SEPARATE constants (POD-1105), so this asserts the
   * reasoning as well as the class: `startBtw` upserts a thread under the
   * matrix's `exp-rev` rule and `ensureSession` mints a session row, and a
   * shared constant would attach one row's rule to the other's command — the
   * derivation the contract file's header refuses. Reading the class alone
   * cannot see that, which is why the texts are asserted distinct.
   */
  it('records an offline class per command, six live and two entity-shaped', () => {
    const byClass = Object.fromEntries(
      Object.entries(SUPERAGENT_CONTRACTS).map(([n, c]) => [n, c.delivery.class]),
    )
    expect(byClass).toEqual({
      sendTurn: 'online-only',
      interruptTurn: 'online-only',
      openInTerminal: 'online-only',
      clear: 'online-only',
      restart: 'online-only',
      concierge: 'online-only',
      startBtw: 'offline-eligible',
      ensureSession: 'offline-eligible',
    })
    expect(SUPERAGENT_CONTRACTS.startBtw.delivery.outboxReconciliation).not.toBe(
      SUPERAGENT_CONTRACTS.ensureSession.delivery.outboxReconciliation,
    )
    for (const contract of contracts()) {
      expect(contract.delivery.outboxReconciliation.length).toBeGreaterThan(80)
      expect(contract.delivery.applyTimeReauthorization).toContain('LIVE')
    }
  })

  /**
   * The offline class permits `outbox`; it does not open it. ADR 3 D3 is
   * default-closed, so making `ensureSession` offline-eligible must not have
   * changed what any transport serves — asserted here rather than left to the
   * exposure test above, which reads the arm and not the implication.
   */
  it('opens no transport by being offline-eligible — the class permits, the contract names', () => {
    for (const contract of contracts()) expect(contract.exposure).not.toContain('outbox')
  })

  /**
   * ADR 3 Amendment 1 D18/D18.3 and readiness §3.1.4 M5, per arm.
   *
   * The three machine-placing commands must declare `use` AND keep unauthorized
   * distinguishable from unreachable; the five control commands must declare no
   * verb at all. Both directions are asserted, so a verb spreading to a command
   * that places nothing fails here and not only in the lint.
   */
  it('declares machine `use` on exactly the three commands that place work on compute', () => {
    const placesWork: SuperagentContractName[] = ['sendTurn', 'concierge', 'openInTerminal']
    for (const name of EIGHT) {
      // Read through the ERASED type: the literal table's `policy` is a union of
      // eight distinct shapes, only three of which have a `machineVerb` key at
      // all, so a direct property read does not typecheck — and the union is
      // itself the point being asserted.
      const contract = SUPERAGENT_CONTRACTS[name] as AnyCommandContract
      const expected = placesWork.includes(name) ? 'use' : undefined
      expect([name, contract.policy.machineVerb]).toEqual([name, expected])
      expect([name, contract.policy.resource]).toEqual([
        name,
        placesWork.includes(name) ? 'machine' : 'session',
      ])
      expect([name, contract.errorConsistency.callerSuppliedTargetId]).toEqual([name, true])
      expect([
        name,
        'distinguishesUnauthorizedFromUnreachable' in contract.errorConsistency
          ? contract.errorConsistency.distinguishesUnauthorizedFromUnreachable
          : undefined,
      ]).toEqual([name, placesWork.includes(name)])
    }
  })

  it('asks for confirmation on the destructive command and only that one', () => {
    for (const name of EIGHT) {
      expect([name, SUPERAGENT_CONTRACTS[name].policy.confirmation]).toEqual([
        name,
        name === 'clear' ? 'confirm' : 'none',
      ])
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

  it('reviews redaction everywhere and names the paths only where there are paths', () => {
    for (const contract of contracts()) expect(contract.redaction.reviewed).toBe(true)
    expect(SUPERAGENT_CONTRACTS.sendTurn.redaction.inputPaths).toEqual([
      'text',
      'focus.worktreePath',
      'focus.filePath',
    ])
    expect(SUPERAGENT_CONTRACTS.concierge.redaction.inputPaths).toContain('repoPath')
    // The counterfactual: a control command carrying only an id redacts nothing,
    // so `reviewed: true` is a judgement and not a rubber stamp.
    expect(SUPERAGENT_CONTRACTS.interruptTurn.redaction.inputPaths).toEqual([])
  })
})

/**
 * COMPOSITION IDENTITY (POD-305). A restated `z.object({…})` with the same keys
 * is byte-identical on the wire, so the golden fixtures cannot see the drift —
 * only `toBe` against the shared INSTANCE can, and it is asserted PER ARM
 * rather than on arm 0.
 */
describe('the shared schema instances', () => {
  const unwrapFocus = (input: typeof superagentSendTurnInput | typeof superagentConciergeInput) =>
    (input.shape.focus as z.ZodOptional<typeof superagentUserFocus>).unwrap()

  it('uses the ONE user-focus schema on both turn-carrying arms', () => {
    expect(unwrapFocus(superagentSendTurnInput)).toBe(superagentUserFocus)
    expect(unwrapFocus(superagentConciergeInput)).toBe(superagentUserFocus)
  })

  it('uses the ONE turn-text schema on both turn-carrying arms', () => {
    expect(superagentConciergeInput.shape.text).toBe(superagentSendTurnInput.shape.text)
  })

  /**
   * The non-vacuity probe for the two assertions above: `toBe` on a freshly
   * restated schema of the same shape must FAIL, or identity is not what is
   * being measured. Asserted as an inequality so the probe itself is a check.
   */
  it('would notice a restatement — the identity assertions are not shape assertions', () => {
    const restated = superagentUserFocus.extend({})
    expect(restated).not.toBe(superagentUserFocus)
    expect(Object.keys(restated.shape).sort()).toEqual(
      Object.keys(superagentUserFocus.shape).sort(),
    )
  })
})
