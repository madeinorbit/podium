/**
 * POD-4564 (L6b) — what a planted-mistake probe is.
 *
 * A probe is one deliberate mistake, written so that it can be planted in
 * EITHER substrate by someone who did not build the arm (N1b, N2b), and judged
 * by the same detectors in both. Each probe carries:
 *
 * - `recipes`: where the mistake goes in each substrate and the patch that
 *   makes it, written against the L1 contracts (schema, row view, write
 *   contract, arm contract), never against one arm's private names;
 * - `behaviour`: the arm-neutral test that must FAIL once the mistake is
 *   planted (and pass on the clean arm), with the fence steps and change
 *   sequences it drives (`run.ts` runs them against any `ProbeSubject`);
 * - `detectors`: every detector that could see it — compile, lint, fence,
 *   correctness gate, test — with what each is expected to do in each
 *   substrate, on the planted probe reference arm (the armed control) and on
 *   the unplanted legacy control (the baseline);
 * - `lintPlants`: the mistake's code shape in each idiom, linted through the
 *   fence's own config in `probes-lint.test.ts`, so the lint column is
 *   measured, not asserted.
 *
 * The planted reference arm (`harness/src/reference-arm/probe-arm.tsx`) is
 * the proof that every behaviour test and every detector marked `fires` for
 * it CAN fire; its clean twin passes the same run.
 */

import type { ProbePlant } from '../../../harness/src/reference-arm/probe-arm'
import type { Arm } from '../arm'
import type { FixtureCorpus } from '../../../harness/src/fixture/index'
import type { Change } from '../gen/changes'
import type { RowSourceMode } from '../row-source'
import type { ScenarioEngine, ScenarioTargets } from '../scenarios'
import type { EntityName } from '../schema'
import type { ProbeRun } from './run'

export type ProbeId =
  | 'P1-omitted-input'
  | 'P2-evict-index-cleanup'
  | 'P3-row-scan'
  | 'P4-untracked-state'
  | 'P5-missing-inverse'

export type Substrate = 'mobx' | 'hand'

/** The five detector families the brief names. */
export type DetectorKind = 'compile' | 'lint' | 'fence' | 'gate' | 'test'

/** One named instrument. Every verdict in a run is per instrument. */
export type Instrument =
  /** `bun run typecheck -- --filter @podium/worklist-proto`. */
  | 'typecheck'
  /** The lint fence (`harness/lint/fence-plugin.mjs`), every arm folder. */
  | 'lint-fence'
  /** The exact-commit fence (`assertCommits`, row-view oracle). */
  | 'commit-fence'
  /** The reads-per-change fence (`READ_BUDGETS` and the `*ReadBudget` helpers). */
  | 'reads-fence'
  /** The step's snapshot against the oracle's (`CountResult.parity`). */
  | 'parity'
  /** L4b's `checkArm` over the probe's sequence: incremental vs rebuild vs oracle. */
  | 'gate'
  /** Every declared relation, both directions, against the feed's rows (`relations-check.ts`). */
  | 'relation-check'
  /** The long-lived arm against a FRESH arm over the same feed, after every step. */
  | 'history-check'
  /** The probe's own behaviour test. */
  | 'behaviour-test'
  /** The arm's own suite (the builder's tests): recorded by N1b/N2b, never run here. */
  | 'arm-tests'

export const INSTRUMENT_KIND: Readonly<Record<Instrument, DetectorKind>> = {
  typecheck: 'compile',
  'lint-fence': 'lint',
  'commit-fence': 'fence',
  'reads-fence': 'fence',
  parity: 'gate',
  gate: 'gate',
  'relation-check': 'gate',
  'history-check': 'gate',
  'behaviour-test': 'test',
  'arm-tests': 'test',
}

/**
 * What a detector is expected to do in a substrate. `fires-if` names the
 * condition under the substrate's idiom that decides it (an exhaustive input
 * map, a guard read from an observable, …): the exercise records which held.
 */
export type Expectation = 'fires' | 'silent' | { firesIf: string }

/**
 * - `fires` / `silent`: asserted on the planted probe reference arm.
 * - `blind`: the instrument does not cover it (the lint fence covers
 *   `arms/` only; the lint column is measured on `lintPlants` instead).
 * - `not-run`: the suite cannot run this instrument on it (typecheck: the
 *   plants are in the typechecked tree, so it is silent by construction;
 *   the arm's own tests do not exist for a reference arm).
 */
export type ReferenceExpectation = 'fires' | 'silent' | 'blind' | 'not-run'

/**
 * The legacy control, UNPLANTED (it holds no pool, index or relation to
 * plant into):
 * - `blind`: the control lacks what the instrument inspects (no relation
 *   reader, not under `arms/`): it is SILENT because it cannot look;
 * - `silent`: it looked and passed;
 * - `fires-unplanted`: red on the control with no mistake planted (the
 *   control over-commits and reads the whole corpus), so on the control it
 *   is NOT evidence of the probe;
 * - `not-run`: as for the reference.
 */
export type ControlExpectation = 'blind' | 'silent' | 'fires-unplanted' | 'not-run'

export interface ExpectedDetector {
  instrument: Instrument
  mobx: Expectation
  hand: Expectation
  reference: ReferenceExpectation
  control: ControlExpectation
  /** Why, in one or two sentences, citing the K exercise or audit where one saw it. */
  why: string
}

/** Where the mistake goes in one substrate, and the patch that makes it. */
export interface PlantRecipe {
  /** The seam, named by the L1 contract that puts it there (not by one arm's private names). */
  where: string
  /** The patch, as steps a non-builder can follow. */
  patch: readonly string[]
  /** How to undo it (and prove the clean arm passes again). */
  revert: string
}

/** The mistake's code shape, linted through the fence's own config. */
export interface LintPlant {
  name: string
  substrate: Substrate | 'both'
  /** A path under the lint fence's fixture arm (`harness/lint/fixtures/arms/planted/`). */
  file: string
  code: string
  /** The rule ids expected, in order; empty means the lint fence is SILENT on this shape. */
  expect: readonly string[]
}

/** A fence step the probe runs, each on a fresh engine. */
export type FenceStepName = '#1' | '#2' | '#3' | '#4' | '#5' | '#6a' | '#6b' | '#6c' | '#6d' | '#7' | '#8' | '#8b'

export interface ProbeSequence {
  name: string
  /** What the sequence exercises, and which of its changes the clean arm must follow. */
  why: string
  build(targets: ScenarioTargets, corpus: FixtureCorpus): Change[]
}

export interface ProbeBehaviour {
  /** The behaviour test, as one sentence. */
  test: string
  /**
   * The instruments the test reads. When one of them was blind on a run (no
   * relation accessor, no rebuild), a pass is reported as blind, not clean.
   */
  needs: readonly Instrument[]
  /** Fence steps, each run on a fresh 1x engine through the count harness. */
  steps: readonly FenceStepName[]
  /** Change sequences, run through the generator's engine with per-step checks and through `checkArm`. */
  sequences: readonly ProbeSequence[]
  /**
   * The behaviour test's verdict over a run: null when it passed, otherwise
   * the failure, naming the step and what diverged. It reads only the
   * instruments the sentence above names.
   */
  failure(run: ProbeRun): string | null
}

export interface Probe {
  id: ProbeId
  title: string
  /** The mistake, in plain words. */
  mistake: string
  /** Where it was seen before (K exercise table rows, audit sections, contracts). */
  provenance: readonly string[]
  /** The plant that realises it in the probe reference arm. */
  referencePlant: ProbePlant
  recipes: Readonly<Record<Substrate, PlantRecipe>>
  behaviour: ProbeBehaviour
  detectors: readonly ExpectedDetector[]
  lintPlants: readonly LintPlant[]
}

/** A single-valued relation (`belongsTo`, `prefix`, outgoing `edge`); its inverse is implied. */
export interface RelationRef {
  from: EntityName
  relation: string
}

/** What a probe runs against: any arm, clean or planted. */
export interface ProbeSubject {
  name: string
  /** The feed the arm consumes (roster `mode`). */
  mode: RowSourceMode
  /** The arm over one engine (the reference and the control close over it). */
  armFor(ctx: ScenarioEngine): Arm
  /**
   * The single-valued relations the arm maintains (their inverses are
   * implied). Default: every one the schema declares. The probe reference
   * arm maintains `issue.parent` only.
   */
  relations?: readonly RelationRef[]
  /**
   * Compare with the oracle (parity, the gate's oracle pass). Default true;
   * false for a phase-a pool, whose snapshot carries no order or roll-ups yet.
   */
  oracle?: boolean
  /**
   * The arm's folder under `arms/` (a roster arm). The lint fence covers it,
   * but ESLint cannot run in the happy-dom lane: the run records NOT RUN and
   * the exercise runs `bun run lint` in the package. Absent: the lint fence
   * does not cover the arm (SILENT, blind).
   */
  lintFolder?: string
}
