/**
 * The gate ledger, verified as an INSTRUMENT.
 *
 * `assertGatesCovered` is what turns "registered as a Phase-2 gate condition" from a
 * sentence in a brief into something a build checks. A coverage tracker that cannot
 * report a miss is indistinguishable from one that found none, and an
 * always-passing totality test is the most expensive kind of green there is: every
 * later hop would read it as proof it had covered the multi-user gates.
 *
 * So this file proves the ledger can say NO before the suite's `afterAll` is believed
 * when it says nothing.
 */

import { describe, expect, it } from 'vitest'
import {
  GateLedger,
  PHASE_2_SYNC_GATES,
  PHASE_2_SYNC_GATE_IDS,
  assertGatesCovered,
  type Phase2SyncGate,
} from './gates'

describe('the Phase-2 gate ledger', () => {
  it('says NO when a gate has no test, and NAMES the gate', () => {
    const ledger = new GateLedger('probe')
    for (const gate of PHASE_2_SYNC_GATE_IDS) {
      if (gate !== 'scoped/revoke-mid-session') ledger.cover(gate)
    }

    expect(ledger.missing()).toEqual(['scoped/revoke-mid-session'])
    // The message has to be actionable, not merely present: a count with no name
    // leaves whoever hits it grepping.
    expect(() => assertGatesCovered(ledger)).toThrow(/scoped\/revoke-mid-session/)
    expect(() => assertGatesCovered(ledger)).toThrow(/probe/)
    expect(() => assertGatesCovered(ledger)).toThrow(
      PHASE_2_SYNC_GATES['scoped/revoke-mid-session'],
    )
  })

  it('says YES only when EVERY gate has a test', () => {
    const ledger = new GateLedger('probe')
    // POSITIVE CONTROL for the negative above: the same ledger, one gate later.
    expect(() => assertGatesCovered(ledger)).toThrow()
    for (const gate of PHASE_2_SYNC_GATE_IDS) ledger.cover(gate)
    expect(ledger.missing()).toEqual([])
    expect(() => assertGatesCovered(ledger)).not.toThrow()
  })

  it('counts per instantiation, so one hop cannot borrow another hop’s coverage', () => {
    const web = new GateLedger('indexeddb')
    const memory = new GateLedger('in-memory')
    for (const gate of PHASE_2_SYNC_GATE_IDS) memory.cover(gate)

    expect(() => assertGatesCovered(memory)).not.toThrow()
    // The other ledger learned nothing from it. A module-level counter would have.
    expect(web.missing()).toEqual(PHASE_2_SYNC_GATE_IDS)
    expect(() => assertGatesCovered(web)).toThrow(/indexeddb/)
  })

  it('keeps ids and descriptions in step, and holds every group the decision names', () => {
    // A gate whose description is missing would still be counted, and would read as
    // covered in the failure message. Cheap to check, and it is the sort of drift a
    // hand-maintained map acquires.
    for (const gate of PHASE_2_SYNC_GATE_IDS) {
      expect(typeof PHASE_2_SYNC_GATES[gate]).toBe('string')
      expect(PHASE_2_SYNC_GATES[gate].length).toBeGreaterThan(20)
    }
    // The four groups the brief and the ADRs enumerate, with the counts they state:
    // nine base cases, four ADR-named cases, SEVEN scoped multi-user gates, five
    // cross-cutting assertions. The seven is the one with a number attached to it in
    // the human decision, so it is the one asserted exactly.
    const group = (prefix: string): Phase2SyncGate[] =>
      PHASE_2_SYNC_GATE_IDS.filter((id) => id.startsWith(prefix))
    expect(group('scoped/')).toHaveLength(7)
    expect(group('adr/')).toHaveLength(4)
    expect(group('base/')).toHaveLength(9)
    expect(group('cross/')).toHaveLength(5)
    // …and nothing outside those four groups, so a new gate cannot be filed into a
    // fifth bucket the counts above stop watching.
    expect(
      PHASE_2_SYNC_GATE_IDS.filter(
        (id) => !/^(base|adr|scoped|cross)\//.test(id),
      ),
    ).toEqual([])
  })
})
