/**
 * POD-4564 (L6b) — run a probe against any arm and record what every
 * detector did.
 *
 * `runProbe(probe, subject)` drives the probe's behaviour through three
 * existing instruments and two new ones, and returns the raw records; the
 * verdicts (`verdicts`) are read off them:
 *
 * - FENCE STEPS (count harness, `fence-scenarios.ts`): each named step on a
 *   FRESH 1x engine, the arm mounted through `mountArmForCounts` with the
 *   reads fence on. Recorded: the exact-commit fence (`assertCommits`), the
 *   reads cell against the step's budget, parity, the arm's snapshot against
 *   its own rebuild (checkable arms), and the relation check.
 * - SEQUENCES (the generator's engine, `gen/run.ts`, real kernel outbox and
 *   scripted server): after every change, the relation check and the HISTORY
 *   check — the long-lived arm against a fresh arm created over the same feed
 *   and locals at that step. Then the same sequence through L4b's `checkArm`
 *   (rebuild and oracle after every step, shrunk on failure): the gate.
 *
 * The HISTORY CHECK is the one instrument that sees P4 (untracked state)
 * directly: a derivation that read plain state carries its history, and a
 * fresh arm has none. It compares the rows present in BOTH snapshots,
 * because which cold rows a lazy pool has loaded is history by design
 * (POD-4567); order and row set are the gate's.
 *
 * BLIND IS NOT A PASS. An instrument that had nothing to inspect (no relation
 * accessor handed to the fence, no `rebuildFromScratch`) records SILENT with
 * the reason in `blind`; the baseline reports it as such.
 */

import { assertCommits, mountArmForCounts } from '../../../harness/src/count-harness'
import { createEngineLocals } from '../../../harness/src/engine-locals'
import { FENCE_SCENARIOS, openFenceFeeds, runFenceStep } from '../../../harness/src/fence-scenarios'
import type { ArmHandle, CheckableArm, CheckableArmHandle } from '../arm'
import type { Change } from '../gen/changes'
import { genCorpus } from '../gen/changes'
import { type Against, checkArm, diffSnapshots } from '../gen/check'
import { startGenRun } from '../gen/run'
import { createReadFence, DISABLED_READ_FENCE } from '../instrument/reads'
import { pickTargets, startScenarioEngine } from '../scenarios'
import type { SliceSnapshot } from '@podium/client-graph/shared/slice-types'
import {
  type DetectorKind,
  type Expectation,
  type FenceStepName,
  INSTRUMENT_KIND,
  type Instrument,
  type Probe,
  type ProbeId,
  type ProbeSequence,
  type ProbeSubject,
} from './probe'
import {
  capturingFence,
  checkRelations,
  declaredLinks,
  feedRowIds,
  type RelationCheck,
} from './relations-check'

export interface StepRecord {
  step: FenceStepName
  scenario: string
  parity: boolean
  parityDiff: string | null
  /** `assertCommits`'s failure, or null when the step drew exactly the changed rows. */
  commits: string | null
  reads: number | null
  readsBudget: number
  /** Snapshot against the arm's own rebuild after the step; undefined when the arm has none. */
  rebuild: string | null | undefined
  /** Null when the arm handed the fence no relation accessor. */
  relations: RelationCheck | null
}

export interface SequenceStepRecord {
  index: number
  change: Change
  skipped?: string
  relations: RelationCheck | null
  history: string | null
}

export interface GateRecord {
  ok: boolean
  step?: number
  against?: Against
  diff?: string
  shrunk?: Change[]
}

export interface SequenceRecord {
  name: string
  steps: SequenceStepRecord[]
  /** L4b over the same sequence; undefined when the arm is not checkable. */
  gate: GateRecord | undefined
}

export interface ProbeRun {
  probe: ProbeId
  subject: string
  steps: StepRecord[]
  sequences: SequenceRecord[]
  /** The arm handed `reads.wrapRelations` an accessor. */
  relationsSeen: boolean
  /** The arm has `rebuildFromScratch`. */
  checkable: boolean
  /** The subject's folder under `arms/`, when it has one. */
  lintFolder?: string
}

export interface RunOptions {
  /** Skip the `checkArm` pass (the per-step checks still run). Default false. */
  noGate?: boolean
  /** Predicate runs the gate's shrinker may spend. Default 20. */
  maxShrinkRuns?: number
}

function isCheckable(handle: ArmHandle): handle is CheckableArmHandle {
  return typeof (handle as Partial<CheckableArmHandle>).rebuildFromScratch === 'function'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One fence step on a fresh engine. */
export async function runProbeStep(
  subject: ProbeSubject,
  step: FenceStepName,
): Promise<{ record: StepRecord; relationsSeen: boolean; checkable: boolean }> {
  const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === step)
  if (entry === undefined) throw new Error(`[probe] no fence scenario ${step}`)
  const ctx = await startScenarioEngine(1)
  const feeds = openFenceFeeds(ctx, subject.mode)
  const capture = capturingFence(createReadFence({ enabled: true }))
  const mounted = mountArmForCounts(subject.armFor(ctx), feeds.rows.source, feeds.locals, {
    reads: capture.fence,
  })
  try {
    const { result, readsBudget } = await runFenceStep(mounted, ctx, feeds.flush, entry)
    let commits: string | null = null
    try {
      assertCommits(result)
    } catch (error) {
      commits = messageOf(error)
    }
    const handle = mounted.handle
    const checkable = isCheckable(handle)
    const reader = capture.relations()
    return {
      record: {
        step,
        scenario: entry.scenario,
        parity: result.parity,
        parityDiff: result.parityDiff,
        commits,
        reads: result.readsPerChange,
        readsBudget,
        rebuild: checkable
          ? diffSnapshots(handle.snapshot(), handle.rebuildFromScratch())
          : undefined,
        relations:
          reader === null
            ? null
            : checkRelations(
                reader,
                feedRowIds(feeds.rows.source),
                subject.relations ?? declaredLinks(),
              ),
      },
      relationsSeen: reader !== null,
      checkable,
    }
  } finally {
    mounted.unmount()
    feeds.dispose()
    ctx.engine.destroy()
  }
}

/** Rows present in both snapshots whose fields differ (see HISTORY CHECK above). */
export function historyDiff(live: SliceSnapshot, fresh: SliceSnapshot): string | null {
  const lines: string[] = []
  for (const [id, row] of Object.entries(fresh.rowsById)) {
    const held = live.rowsById[id]
    if (held === undefined) continue
    const diff = diffSnapshots(
      { order: { pinnedIds: [], groups: [] }, rowsById: { [id]: held } },
      { order: { pinnedIds: [], groups: [] }, rowsById: { [id]: row } },
    )
    if (diff !== null) lines.push(diff.split('\n').slice(1).join(' ').trim())
  }
  if (lines.length === 0) return null
  return `${lines.length} row(s) differ from a fresh arm: ${lines.slice(0, 3).join('; ')}`
}

/** One sequence through the generator's engine, with the relation and history checks after every change. */
export async function runProbeSequence(
  subject: ProbeSubject,
  sequence: ProbeSequence,
  opts: RunOptions = {},
): Promise<{ record: SequenceRecord; relationsSeen: boolean; checkable: boolean }> {
  const corpus = genCorpus()
  const changes = sequence.build(pickTargets(corpus), corpus)
  const run = await startGenRun({ feedMode: subject.mode })
  let feed = run.feed()
  let locals = createEngineLocals(run.ctx.engine)
  const scope = subject.relations ?? declaredLinks()
  let capture = capturingFence(DISABLED_READ_FENCE)
  const create = (): ArmHandle => {
    capture = capturingFence(DISABLED_READ_FENCE)
    return subject.armFor(run.ctx).create(feed.source, locals.source, capture.fence)
  }
  let handle = create()
  const checkable = isCheckable(handle)
  let relationsSeen = capture.relations() !== null
  const steps: SequenceStepRecord[] = []
  try {
    for (const [index, change] of changes.entries()) {
      const step = await run.apply(change)
      if (run.feed() !== feed) {
        handle.dispose()
        locals.dispose()
        feed = run.feed()
        locals = createEngineLocals(run.ctx.engine)
        handle = create()
      }
      locals.flush()
      const reader = capture.relations()
      relationsSeen ||= reader !== null
      const fresh = subject.armFor(run.ctx).create(feed.source, locals.source, DISABLED_READ_FENCE)
      let history: string | null
      try {
        history = historyDiff(handle.snapshot(), fresh.snapshot())
      } finally {
        fresh.dispose()
      }
      steps.push({
        index,
        change,
        ...(step.skipped === undefined ? {} : { skipped: step.skipped }),
        relations: reader === null ? null : checkRelations(reader, feedRowIds(feed.source), scope),
        history,
      })
    }
  } finally {
    handle.dispose()
    locals.dispose()
    run.dispose()
  }
  let gate: GateRecord | undefined
  if (checkable && opts.noGate !== true) {
    const result = await checkArm((ctx) => subject.armFor(ctx) as CheckableArm, changes, {
      mode: subject.mode,
      rebuildEvery: 1,
      oracleEvery: subject.oracle === false ? 0 : 1,
      maxShrinkRuns: opts.maxShrinkRuns ?? 20,
    })
    gate = result.ok
      ? { ok: true }
      : {
          ok: false,
          step: result.step,
          against: result.against,
          diff: result.diff,
          shrunk: result.shrunk,
        }
  }
  return { record: { name: sequence.name, steps, gate }, relationsSeen, checkable }
}

/** Run the probe's whole behaviour against one subject. */
export async function runProbe(
  probe: Probe,
  subject: ProbeSubject,
  opts: RunOptions = {},
): Promise<ProbeRun> {
  const steps: StepRecord[] = []
  const sequences: SequenceRecord[] = []
  let relationsSeen = false
  let checkable = false
  for (const step of probe.behaviour.steps) {
    const out = await runProbeStep(subject, step)
    steps.push(out.record)
    relationsSeen ||= out.relationsSeen
    checkable ||= out.checkable
  }
  for (const sequence of probe.behaviour.sequences) {
    const out = await runProbeSequence(subject, sequence, opts)
    sequences.push(out.record)
    relationsSeen ||= out.relationsSeen
    checkable ||= out.checkable
  }
  return {
    probe: probe.id,
    subject: subject.name,
    steps,
    sequences,
    relationsSeen,
    checkable,
    ...(subject.lintFolder === undefined ? {} : { lintFolder: subject.lintFolder }),
  }
}

// ------------------------------------------------------------------- verdicts

export type Verdict = 'FIRED' | 'SILENT' | 'NOT RUN'

export interface DetectorVerdict {
  instrument: Instrument
  kind: DetectorKind
  verdict: Verdict
  /** Set when SILENT because the instrument had nothing to inspect. */
  blind?: string
  /** The first firing (step and message), or what was looked at. */
  evidence: string
}

const NOT_RUN: ReadonlySet<Instrument> = new Set(['typecheck', 'arm-tests'])

function firstStep<T>(items: readonly T[], pick: (item: T) => string | null): string | null {
  for (const item of items) {
    const found = pick(item)
    if (found !== null) return found
  }
  return null
}

function relationFiring(run: ProbeRun): string | null {
  return (
    firstStep(run.steps, (s) =>
      s.relations !== null && s.relations.total > 0
        ? `${s.step} ${s.scenario}: ${s.relations.problems[0]} (${s.relations.total} in all)`
        : null,
    ) ??
    firstStep(run.sequences, (q) =>
      firstStep(q.steps, (s) =>
        s.relations !== null && s.relations.total > 0
          ? `${q.name} step ${s.index} (${s.change.kind}): ${s.relations.problems[0]} (${s.relations.total} in all)`
          : null,
      ),
    )
  )
}

function gateFiring(run: ProbeRun): string | null {
  return firstStep(run.sequences, (q) =>
    q.gate === undefined || q.gate.ok
      ? null
      : `${q.name} step ${q.gate.step} against the ${q.gate.against}: ${(q.gate.diff ?? '').split('\n').slice(0, 2).join(' ')} — shrunk to ${q.gate.shrunk?.length ?? '?'} change(s)`,
  )
}

/** Each named instrument's first firing over a run, or null. */
export function firing(run: ProbeRun, instrument: Instrument): string | null {
  switch (instrument) {
    case 'commit-fence':
      return firstStep(run.steps, (s) => (s.commits === null ? null : `${s.step}: ${s.commits}`))
    case 'reads-fence':
      return firstStep(run.steps, (s) =>
        s.reads !== null && s.reads > s.readsBudget
          ? `${s.step} ${s.scenario}: read ${s.reads} rows, budget ${s.readsBudget}`
          : null,
      )
    case 'parity':
      return firstStep(run.steps, (s) =>
        s.parity ? null : `${s.step} ${s.scenario}: ${s.parityDiff ?? ''}`,
      )
    case 'gate':
      return (
        gateFiring(run) ??
        firstStep(run.steps, (s) =>
          typeof s.rebuild === 'string'
            ? `${s.step} ${s.scenario} against the rebuild: ${s.rebuild.split('\n')[0]}`
            : null,
        )
      )
    case 'relation-check':
      return relationFiring(run)
    case 'history-check':
      return firstStep(run.sequences, (q) =>
        firstStep(q.steps, (s) =>
          s.history === null ? null : `${q.name} step ${s.index} (${s.change.kind}): ${s.history}`,
        ),
      )
    default:
      return null
  }
}

function blindness(run: ProbeRun, instrument: Instrument): string | undefined {
  if (instrument === 'relation-check' && !run.relationsSeen) {
    return 'the arm handed the fence no RelationReader: there is no graph to check'
  }
  if (instrument === 'gate' && !run.checkable) return 'the arm has no rebuildFromScratch'
  if (instrument === 'history-check' && run.sequences.length === 0)
    return 'the probe runs no sequence'
  if (
    (instrument === 'commit-fence' || instrument === 'reads-fence' || instrument === 'parity') &&
    run.steps.length === 0
  ) {
    return 'the probe runs no fence step'
  }
  return undefined
}

/** The probe's behaviour-test verdict, with the instruments it reads. */
export function behaviourVerdict(probe: Probe, run: ProbeRun): DetectorVerdict {
  const failure = probe.behaviour.failure(run)
  const blind = probe.behaviour.needs.map((i) => blindness(run, i)).find((b) => b !== undefined)
  return {
    instrument: 'behaviour-test',
    kind: 'test',
    verdict: failure === null ? 'SILENT' : 'FIRED',
    ...(failure === null && blind !== undefined ? { blind } : {}),
    evidence: failure ?? `passed: ${probe.behaviour.test}`,
  }
}

/** One verdict per instrument the probe lists. Lint and compile are recorded elsewhere (NOT RUN here). */
export function verdicts(probe: Probe, run: ProbeRun): DetectorVerdict[] {
  return probe.detectors.map(({ instrument }): DetectorVerdict => {
    const kind = INSTRUMENT_KIND[instrument]
    if (instrument === 'behaviour-test') return behaviourVerdict(probe, run)
    if (NOT_RUN.has(instrument)) {
      return { instrument, kind, verdict: 'NOT RUN', evidence: 'not run by the probe suite' }
    }
    if (instrument === 'lint-fence') {
      return run.lintFolder === undefined
        ? {
            instrument,
            kind,
            verdict: 'SILENT',
            blind: 'the arm is not under arms/: the lint fence does not cover it',
            evidence: 'the lint fence does not cover the arm',
          }
        : {
            instrument,
            kind,
            verdict: 'NOT RUN',
            evidence: `run \`bun run lint\` in the package over arms/${run.lintFolder}`,
          }
    }
    const fired = firing(run, instrument)
    if (fired !== null) return { instrument, kind, verdict: 'FIRED', evidence: fired }
    const blind = blindness(run, instrument)
    return {
      instrument,
      kind,
      verdict: 'SILENT',
      ...(blind === undefined ? {} : { blind }),
      evidence: blind ?? 'looked, and passed',
    }
  })
}

/** Render an expectation for tables. */
export function expectationText(e: Expectation): string {
  return typeof e === 'string' ? e : `fires if ${e.firesIf}`
}
