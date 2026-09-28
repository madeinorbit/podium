// @vitest-environment happy-dom
/**
 * N1b (`POD-4593`) — throwaway runner: L6b's five probes against the MobX
 * pool arm, recording every verdict. No assertions (a firing is the record,
 * not a failure); the tables land in
 * `docs/decisions/pod-4545-round-three-n-mobx-probes.md`.
 *
 * Run one probe: `N1B_PROBE=P1 bun ../../scripts/validation-admission.ts
 * focused --label n1b -- bun --bun ../../node_modules/vitest/vitest.mjs run
 * --config vitest.config.ts shared/src/probes/n1b-mobx.test.tsx`
 * from `packages/worklist-proto`. DELETE before landing (arm byte-identical).
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mobxPoolArm } from '../../../arms/mobx/pool/arm'
import { writeResult } from '../../../harness/src/results'
import { PROBES, runProbe, verdicts, type ProbeSubject } from './index'

const TIMEOUT = 10 * 60_000

const MOBX: ProbeSubject = {
  name: 'mobx pool',
  mode: 'overlaid',
  armFor: () => mobxPoolArm,
  lintFolder: 'mobx',
}

const only = process.env['N1B_PROBE']?.trim() ?? ''
const results: Record<string, unknown> = {}

for (const probe of PROBES) {
  if (only !== '' && !probe.id.includes(only)) continue
  describe(probe.id, () => {
    it(
      'record every verdict (no assertions)',
      async () => {
        const run = await runProbe(probe, MOBX)
        for (const step of run.steps) {
          console.log(
            `[N1b ${probe.id}] step ${step.step} ${step.scenario}: parity=${step.parity} commits=${step.commits === null ? 'ok' : step.commits.slice(0, 200)} reads=${step.reads}/${step.readsBudget} rebuild=${step.rebuild === undefined ? 'n/a' : step.rebuild === null ? 'ok' : step.rebuild.slice(0, 200)} relations=${step.relations === null ? 'blind' : step.relations.total === 0 ? 'ok' : step.relations.problems[0]?.slice(0, 200)}`,
          )
        }
        for (const seq of run.sequences) {
          const skipped = seq.steps.filter((s) => s.skipped !== undefined)
          console.log(
            `[N1b ${probe.id}] seq "${seq.name}": gate=${seq.gate === undefined ? 'n/a' : seq.gate.ok ? 'ok' : `FAIL step ${seq.gate.step} vs ${seq.gate.against}: ${(seq.gate.diff ?? '').slice(0, 200)} shrunk=${seq.gate.shrunk?.length}`} skipped=${skipped.length === 0 ? 'none' : skipped.map((s) => `${s.index}:${s.skipped}`).join(',')}`,
          )
          for (const s of seq.steps) {
            if (s.history !== null || (s.relations !== null && s.relations.total > 0)) {
              console.log(
                `[N1b ${probe.id}] seq "${seq.name}" step ${s.index} (${(s.change as { kind: string }).kind}): history=${s.history?.slice(0, 200) ?? 'ok'} relations=${s.relations === null ? 'blind' : s.relations.total === 0 ? 'ok' : s.relations.problems[0]?.slice(0, 200)}`,
              )
            }
          }
        }
        const got = verdicts(probe, run)
        results[probe.id] = {
          verdicts: got.map((v) => ({
            instrument: v.instrument,
            kind: v.kind,
            verdict: v.verdict,
            ...(v.blind === undefined ? {} : { blind: v.blind }),
            evidence: v.evidence.slice(0, 400),
          })),
          steps: run.steps.map((s) => ({
            step: s.step,
            scenario: s.scenario,
            parity: s.parity,
            parityDiff: s.parityDiff?.slice(0, 300) ?? null,
            commits: s.commits?.slice(0, 300) ?? null,
            reads: s.reads,
            readsBudget: s.readsBudget,
            rebuild: s.rebuild === undefined ? 'n/a' : (s.rebuild?.slice(0, 300) ?? null),
            relations:
              s.relations === null
                ? 'blind'
                : s.relations.total === 0
                  ? `ok (${s.relations.edges} edges)`
                  : s.relations.problems[0]?.slice(0, 300),
          })),
          sequences: run.sequences.map((q) => ({
            name: q.name,
            gate:
              q.gate === undefined
                ? 'n/a'
                : q.gate.ok
                  ? 'ok'
                  : `FAIL step ${q.gate.step} vs ${q.gate.against}: ${(q.gate.diff ?? '').slice(0, 300)} shrunk=${q.gate.shrunk?.length}`,
            steps: q.steps.map((s) => ({
              index: s.index,
              kind: (s.change as { kind: string }).kind,
              skipped: s.skipped ?? null,
              history: s.history?.slice(0, 300) ?? null,
              relations:
                s.relations === null
                  ? 'blind'
                  : s.relations.total === 0
                    ? `ok (${s.relations.edges} edges)`
                    : s.relations.problems[0]?.slice(0, 300),
            })),
          })),
        }
        for (const v of got) {
          console.log(
            `[N1b ${probe.id}] ${v.instrument}: ${v.verdict}${v.blind === undefined ? '' : ` (blind: ${v.blind})`} — ${v.evidence.slice(0, 400)}`,
          )
        }
        expect(Object.keys(results)).toContain(probe.id)
      },
      TIMEOUT,
    )
  })
}

afterAll(() => {
  if (Object.keys(results).length > 0) writeResult(`n1b-mobx-${only === '' ? 'all' : only}`, results)
})
