// @vitest-environment happy-dom
/**
 * POD-4564 (L6b) — every probe is ARMED, and the baseline is recorded.
 *
 * For each of the five probes, three subjects run the probe's whole
 * behaviour (fence steps, sequences, the gate):
 *
 * - the CLEAN probe reference arm: every instrument SILENT and not blind
 *   (the relation check looked at edges; the gate ran), so a firing below is
 *   the plant, not the scenario;
 * - the PLANTED probe reference arm (`probe-arm.tsx`, the probe's
 *   `referencePlant`): the behaviour test FIRES, and every instrument does
 *   exactly what the catalogue's `reference` column says — `fires` fired,
 *   `silent` looked and passed, `blind` could not look;
 * - the UNPLANTED legacy control: the catalogue's `control` column, recorded
 *   as the baseline (`harness/browser/results/probes-baseline.json`). A
 *   `blind` cell is SILENT because the control lacks what the instrument
 *   inspects; `fires-unplanted` is red with no mistake in it.
 *
 * No `it.fails`: each planted expectation names the instrument and the
 * evidence it must carry.
 */

import { afterAll, describe, expect, it } from 'vitest'
import { legacyControlArmFor } from '../../../harness/src/legacy-control/arm'
import { type ProbePlant, probeReferenceArmFor } from '../../../harness/src/reference-arm/probe-arm'
import { writeResult } from '../../../harness/src/results'
import {
  type ControlExpectation,
  type DetectorVerdict,
  PROBES,
  type Probe,
  type ProbeRun,
  type ProbeSubject,
  type ReferenceExpectation,
  runProbe,
  untrackedState,
  verdicts,
} from './index'

const TIMEOUT = 10 * 60_000

function reference(plant: ProbePlant | null): ProbeSubject {
  return {
    name: plant === null ? 'reference (clean)' : `reference + ${plant}`,
    mode: 'overlaid',
    armFor: (ctx) => probeReferenceArmFor(ctx.engine, plant),
    relations: [{ from: 'issue', relation: 'parent' }],
  }
}

const CONTROL: ProbeSubject = {
  name: 'legacy control',
  mode: 'overlaid',
  armFor: (ctx) => legacyControlArmFor(ctx.engine),
}

type Cell = ReferenceExpectation | ControlExpectation

/** The verdict a catalogue cell requires. */
function matches(cell: Cell, v: DetectorVerdict): boolean {
  switch (cell) {
    case 'fires':
    case 'fires-unplanted':
      return v.verdict === 'FIRED'
    case 'silent':
      return v.verdict === 'SILENT' && v.blind === undefined
    case 'blind':
      return v.verdict === 'SILENT' && v.blind !== undefined
    case 'not-run':
      return v.verdict === 'NOT RUN'
  }
}

function mismatches(probe: Probe, run: ProbeRun, column: 'reference' | 'control'): string[] {
  const got = verdicts(probe, run)
  return probe.detectors.flatMap((detector, index) => {
    const v = got[index] as DetectorVerdict
    const cell = detector[column]
    return matches(cell, v)
      ? []
      : [`${detector.instrument}: expected ${cell}, got ${v.verdict}${v.blind ? ' (blind)' : ''} — ${v.evidence}`]
  })
}

function skippedChanges(run: ProbeRun): string[] {
  return run.sequences.flatMap((q) =>
    q.steps.filter((s) => s.skipped !== undefined).map((s) => `${q.name} step ${s.index}: ${s.skipped}`),
  )
}

const baseline: Record<string, unknown> = {}

afterAll(() => {
  if (Object.keys(baseline).length > 0) writeResult('probes-baseline', baseline)
})

for (const probe of PROBES) {
  describe(`${probe.id}: ${probe.title}`, () => {
    it('the clean reference arm passes: every instrument silent, none blind', async () => {
      const run = await runProbe(probe, reference(null))
      expect(skippedChanges(run)).toEqual([])
      const got = verdicts(probe, run)
      const loud = got.filter((v) => v.verdict === 'FIRED').map((v) => `${v.instrument}: ${v.evidence}`)
      expect(loud).toEqual([])
      // Not blind where the planted arm is expected to see something.
      const blind = got
        .filter((v, i) => v.blind !== undefined && probe.detectors[i]?.reference !== 'blind')
        .map((v) => `${v.instrument}: ${v.blind}`)
      expect(blind).toEqual([])
      if (probe.behaviour.needs.includes('relation-check')) {
        const edges = [...run.steps.map((s) => s.relations?.edges ?? 0), ...run.sequences.flatMap((q) => q.steps.map((s) => s.relations?.edges ?? 0))]
        expect(Math.min(...edges)).toBeGreaterThan(0)
      }
    }, TIMEOUT)

    it(`the planted reference arm (${probe.referencePlant}) fails the behaviour test, and each instrument does what the catalogue says`, async () => {
      const run = await runProbe(probe, reference(probe.referencePlant))
      expect(skippedChanges(run)).toEqual([])
      expect(probe.behaviour.failure(run)).not.toBeNull()
      expect(mismatches(probe, run, 'reference')).toEqual([])
    }, TIMEOUT)

    it('the legacy control (unplanted) records the baseline: SILENT where it lacks the detector', async () => {
      const run = await runProbe(probe, CONTROL)
      const got = verdicts(probe, run)
      baseline[probe.id] = got.map((v) => ({
        instrument: v.instrument,
        kind: v.kind,
        verdict: v.verdict,
        ...(v.blind === undefined ? {} : { blind: v.blind }),
        evidence: v.evidence.slice(0, 300),
      }))
      expect(mismatches(probe, run, 'control')).toEqual([])
    }, TIMEOUT)
  })
}

describe('P4 is history, not inputs', () => {
  it('the planted guard passes the sequence with a tick between the two changes and fails the one without', async () => {
    const run = await runProbe(untrackedState, reference('guardSet'), { noGate: true })
    const [without, ticked] = run.sequences
    expect(without?.name).toBe('same row twice, nothing between')
    expect(without?.steps.map((s) => s.history !== null)).toEqual([false, false, false, true])
    expect(ticked?.name).toBe('same row twice, a tick between')
    expect(ticked?.steps.map((s) => s.history)).toEqual([null, null, null])
  }, TIMEOUT)
})
